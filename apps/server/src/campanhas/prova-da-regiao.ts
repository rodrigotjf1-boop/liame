import { createHmac } from 'node:crypto';
import { ErroConector, type PedidoConector, type RespostaConector } from '../connectors/cliente-http.js';
import type { CategoriaDoPerfil } from '../connectors/google-business/conector-perfil-google.js';
import { consultaDeLugares, ESTADOS_DO_BRASIL, type LugarNoGoogle, lugarDoTipo, lugaresDaResposta } from '../connectors/google-ads/lugares-no-google.js';
import type { ConjuntoComPublico } from '../connectors/meta/conector-meta.js';
import { TAMANHO_DO_TEMA } from './temas-de-busca.js';

// A prova na conta real do que a R9 e o teste de região precisam saber antes do código (plano da região, D-RG-89; o
// desenho do trilho com o "ok" da LIAME em 14/11/2026). Roda uma vez, pelo `scripts/prova-regiao.ts`, só com a ordem do
// dono, e NADA é criado nem mudado:
//   1. Google, os temas: quantos o grupo de recursos aceita (25, 26, 50 e 51) e o tamanho de cada um (80 e 81);
//   2. Google, os lugares (leitura): o estado, a cidade e os bairros da loja pela constante e pelo pai de cada uma;
//   3. Google, os bairros com "só quem está" (PRESENCE) na mesma requisição, na campanha que está no ar;
//   3b. Google, a criação inteira do jeito do desenho (a campanha aprovada, com o nome "(prova)", os temas no grupo de
//       recursos novo e os bairros no lugar do raio), só validando: prova o caminho que o código vai usar;
//   4. Perfil da Empresa (leitura): a categoria principal e o nome dela em português (`categories:batchGet`);
//   5. Meta, tirar um bairro do público de um conjunto do Liame (para o teste de região).
// A TRAVA (ajustes 1 e 3 da LIAME): a única saída para a rede é o `http` envolvido por `comTrava`, que deixa passar só o
// GET, a `suggest` do Google e a escrita que `exigirSoValidacao` aceita pelo corpo montado (o Google com
// `validateOnly: true` no `googleAds:mutate`; a Meta sem corpo e com `execution_options` exatamente `["validate_only"]`);
// qualquer outra coisa derruba a prova inteira, nunca vira "um passo recusado". As chamadas ainda conferem cada uma (a
// segunda camada). Quando a prova para no meio, o erro leva os passos que já saíram, para a auditoria registrar tudo.
// Só criação de nada: a campanha que já existe não ganha tema nem bairro. Partes com a rede trocável, para o teste.

export type Http = (p: PedidoConector) => Promise<RespostaConector<unknown>>;

/** A escrita que ia sair sem a validação: a prova para inteira, e nada foi mandado. */
export class EscritaSemValidacao extends Error {}

const EXECUCAO_SO_VALIDANDO = '["validate_only"]';
/** Na Meta, o POST da prova vai a um objeto só (`/<versão>/<id numérico>`), nunca à raiz (o lote, `batch`). */
const UM_OBJETO_DA_META = /^\/v\d+(\.\d+)?\/\d+$/;
/** Os únicos parâmetros do POST da prova na Meta (o token vai no cabeçalho): qualquer outro, `batch` inclusive, derruba. */
const PARAMETROS_DA_META = new Set(['targeting', 'execution_options', 'appsecret_proof']);

/**
 * A conferência de uma escrita (D-RG-89): só passa a que a plataforma valida sem aplicar. No Google, só o
 * `googleAds:mutate` com `validateOnly: true` no corpo; na Meta, só o POST sem corpo a um objeto só, com os parâmetros
 * da lista fechada, cujo `execution_options` é exatamente `["validate_only"]`.
 */
export function exigirSoValidacao(plataforma: 'google_ads' | 'meta_ads', p: PedidoConector): void {
  if (p.metodo !== 'POST') throw new EscritaSemValidacao(`${plataforma}: a escrita da prova é sempre POST; nada foi mandado.`);
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    throw new EscritaSemValidacao(`${plataforma}: endereço inválido; nada foi mandado.`);
  }
  if (plataforma === 'google_ads') {
    const corpo = p.corpo as { validateOnly?: unknown } | null | undefined;
    if (!url.pathname.endsWith('/googleAds:mutate')) throw new EscritaSemValidacao('Google: a prova só usa o googleAds:mutate; nada foi mandado.');
    if (!corpo || typeof corpo !== 'object' || corpo.validateOnly !== true) throw new EscritaSemValidacao('Google: o corpo não tem validateOnly: true; nada foi mandado.');
    return;
  }
  if (p.corpo !== undefined && p.corpo !== null) throw new EscritaSemValidacao('Meta: a escrita da prova vai só pelos parâmetros, sem corpo; nada foi mandado.');
  if (!UM_OBJETO_DA_META.test(url.pathname)) throw new EscritaSemValidacao('Meta: a escrita da prova vai a um objeto só, nunca à raiz nem em lote; nada foi mandado.');
  const nomes = [...url.searchParams.keys()];
  const fora = nomes.find((n) => !PARAMETROS_DA_META.has(n));
  if (fora !== undefined) throw new EscritaSemValidacao(`Meta: o parâmetro "${fora.slice(0, 40)}" não sai na prova; nada foi mandado.`);
  if (new Set(nomes).size !== nomes.length) throw new EscritaSemValidacao('Meta: parâmetro repetido; nada foi mandado.');
  const opcoes = url.searchParams.getAll('execution_options');
  if (opcoes.length !== 1 || opcoes[0] !== EXECUCAO_SO_VALIDANDO) throw new EscritaSemValidacao('Meta: sem execution_options ["validate_only"]; nada foi mandado.');
}

const ehSuggest = (p: PedidoConector): boolean => {
  try {
    return p.provider === 'google_ads' && new URL(p.url).pathname.endsWith('/geoTargetConstants:suggest');
  } catch {
    return false;
  }
};

/** O pedido que leva o método num parâmetro (`?method=post`, `delete`, em qualquer caixa), como a Graph API aceitava. */
const comMetodoNoParametro = (p: PedidoConector): boolean => {
  try {
    return [...new URL(p.url).searchParams.keys()].some((n) => n.toLowerCase() === 'method');
  } catch {
    return true;
  }
};

/**
 * A saída única da prova: o GET passa; o POST só na `suggest` do Google (a lista de lugares, leitura) ou quando
 * `exigirSoValidacao` aceita pela plataforma do pedido; o resto (outro método, outra plataforma, o método escondido num
 * parâmetro `method`) derruba a prova.
 */
export function comTrava(http: Http): Http {
  return async (p) => {
    const metodo = p.metodo ?? 'GET';
    if (comMetodoNoParametro(p)) throw new EscritaSemValidacao(`${p.provider}: pedido com o método num parâmetro não sai na prova; nada foi mandado.`);
    if (metodo === 'GET') return http(p);
    if (metodo !== 'POST') throw new EscritaSemValidacao(`${p.provider}: ${metodo} não sai na prova; nada foi mandado.`);
    if (ehSuggest(p)) return http(p);
    if (p.provider !== 'google_ads' && p.provider !== 'meta_ads') throw new EscritaSemValidacao(`${p.provider}: a prova não escreve nesta plataforma; nada foi mandado.`);
    exigirSoValidacao(p.provider, p);
    return http(p);
  };
}

export type ResultadoDoPasso = { passo: string; resultado: 'aceito' | 'recusado' | 'lido' | 'pulado' | 'falhou'; detalhe: string };

/** A prova que parou no meio (a trava ou um erro inesperado): leva os passos que já saíram, para a auditoria. */
export class ProvaInterrompida extends Error {
  constructor(
    readonly passos: ResultadoDoPasso[],
    readonly causa: unknown,
  ) {
    super(causa instanceof Error ? causa.message.slice(0, 300) : 'erro desconhecido');
  }
}

export type BairroDaProva = { nome: string; latitude: number; longitude: number; raioKm: number };

export type ContextoDaProva = {
  http: Http;
  /** A campanha do Google do piloto (a que está no ar) e o grupo de recursos dela; nulo pula os passos do Google. */
  google: { base: string; versao: string; cliente: string; chave: string; cabecalhos: Record<string, string>; campanha: string; grupo: string } | null;
  /**
   * As operações da criação da campanha aprovada (`operacoesDaCriacao`, com o nome "(prova)"), para o passo 3b; ou o
   * motivo de não ter montado (a foto, a logo); nulo pula o passo.
   */
  criacao: { operacoes: unknown[] } | { erro: string } | null;
  /** As duas leituras do Perfil (pelo conector); nulo pula o passo. */
  perfil: { categoria: () => Promise<CategoriaDoPerfil | null>; nome: (id: string) => Promise<string | null> } | null;
  /** Um conjunto ativo de uma campanha do Liame na Meta, com o público lido agora; nulo pula o passo. */
  meta: { base: string; versao: string; token: string; appSecret: string | null; conta: string; conjunto: ConjuntoComPublico } | null;
  loja: { cidade: string; uf: string; bairros: BairroDaProva[] };
};

/** Temas de teste para o limite de quantos: o mesmo começo, um número diferente em cada. */
export function temasDeTeste(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `hamburgueria teste ${i + 1}`);
}

/** Um tema de exatamente `n` caracteres (sem espaço na ponta), para o limite do tamanho. */
export function temaDeTamanho(n: number): string {
  const base = 'hamburgueria artesanal com entrega no bairro e retirada no balcao perto de voce todos os dias da semana ';
  let t = base.repeat(Math.ceil(n / base.length) + 1).slice(0, n);
  if (t.endsWith(' ')) t = `${t.slice(0, -1)}x`;
  return t;
}

/** O público de um conjunto com um círculo a menos (o bairro do teste), somado ao que já estava de fora. */
export function publicoSemOBairro(targeting: unknown, b: BairroDaProva): Record<string, unknown> {
  const t = targeting && typeof targeting === 'object' ? (targeting as Record<string, unknown>) : {};
  const fora = t.excluded_geo_locations && typeof t.excluded_geo_locations === 'object' ? (t.excluded_geo_locations as Record<string, unknown>) : {};
  const circulos = Array.isArray(fora.custom_locations) ? fora.custom_locations : [];
  // O círculo da Meta por coordenada vai de 1 a 80 km.
  const raio = Math.min(80, Math.max(1, Math.round(b.raioKm * 10) / 10));
  return {
    ...t,
    excluded_geo_locations: { ...fora, custom_locations: [...circulos, { latitude: b.latitude, longitude: b.longitude, radius: raio, distance_unit: 'kilometer' }] },
  };
}

/** O critério de um bairro na campanha: o lugar do Google, ou o círculo no centro dele. */
const criterioDoLugar = (campanha: string, lugar: LugarNoGoogle) => ({ campaignCriterionOperation: { create: { campaign: campanha, location: { geoTargetConstant: lugar.recurso } } } });
const criterioDoCirculo = (campanha: string, b: BairroDaProva) => ({
  campaignCriterionOperation: {
    create: {
      campaign: campanha,
      proximity: {
        geoPoint: { latitudeInMicroDegrees: Math.round(b.latitude * 1e6), longitudeInMicroDegrees: Math.round(b.longitude * 1e6) },
        radius: Math.max(1, Math.round(b.raioKm * 10) / 10),
        radiusUnits: 'KILOMETERS',
      },
    },
  },
});
const sinalDoTema = (grupo: string, text: string) => ({ assetGroupSignalOperation: { create: { assetGroup: grupo, searchTheme: { text } } } });

type Operacao = {
  campaignOperation?: { create?: { resourceName?: string } };
  assetGroupOperation?: { create?: { resourceName?: string } };
  campaignCriterionOperation?: { create?: { proximity?: unknown } };
};

/**
 * A criação do jeito do desenho (passo 3b): as operações da criação aprovada com os bairros no lugar do raio da loja
 * (onde o raio estava) e os temas no grupo de recursos novo (nome provisório), no fim. Função pura.
 */
export function criacaoComARegiao(operacoes: readonly unknown[], temas: readonly string[], lugares: readonly LugarNoGoogle[], circulo: BairroDaProva | null): unknown[] {
  const ops = operacoes as Operacao[];
  const campanha = ops.find((o) => o.campaignOperation?.create)?.campaignOperation?.create?.resourceName;
  const grupo = ops.find((o) => o.assetGroupOperation?.create)?.assetGroupOperation?.create?.resourceName;
  const raio = ops.findIndex((o) => o.campaignCriterionOperation?.create?.proximity !== undefined);
  if (!campanha || !grupo || raio < 0) throw new Error('a criação montada não tem a campanha, o grupo de recursos ou o raio');
  const bairros = [...lugares.map((l) => criterioDoLugar(campanha, l)), ...(circulo ? [criterioDoCirculo(campanha, circulo)] : [])];
  const saida: unknown[] = [...ops];
  saida.splice(raio, 1, ...bairros);
  saida.push(...temas.map((t) => sinalDoTema(grupo, t)));
  return saida;
}

/** O motivo de uma falha, sem nada da credencial: a recusa da plataforma (definitiva) ou o tipo do que deu errado. */
function falha(passo: string, err: unknown): ResultadoDoPasso {
  if (err instanceof EscritaSemValidacao) throw err;
  if (err instanceof ErroConector) {
    const texto = (err.mensagemUsuario ?? err.message).slice(0, 500);
    const codigo = err.subcodigo ? ` (${err.subcodigo})` : '';
    return err.tipo === 'definitivo' ? { passo, resultado: 'recusado', detalhe: `${texto}${codigo}` } : { passo, resultado: 'falhou', detalhe: `${err.tipo}: ${texto}${codigo}` };
  }
  return { passo, resultado: 'falhou', detalhe: err instanceof Error ? err.message.slice(0, 300) : 'erro desconhecido' };
}

type Google = NonNullable<ContextoDaProva['google']>;

async function mutarSoValidando(http: Http, g: Google, passo: string, operacoes: unknown[]): Promise<ResultadoDoPasso> {
  const pedido: PedidoConector = {
    provider: 'google_ads',
    conta: g.chave,
    url: `${g.base}/${g.versao}/customers/${g.cliente}/googleAds:mutate`,
    metodo: 'POST',
    corpo: { mutateOperations: operacoes, validateOnly: true },
    endpoint: 'prova_da_regiao (validação)',
    apiVersion: g.versao,
    cabecalhos: g.cabecalhos,
  };
  exigirSoValidacao('google_ads', pedido);
  try {
    await http(pedido);
    return { passo, resultado: 'aceito', detalhe: `${operacoes.length} operações validadas; nada foi criado.` };
  } catch (err) {
    return falha(passo, err);
  }
}

async function sugerir(http: Http, g: Google, nomes: string[]): Promise<LugarNoGoogle[]> {
  const pedido: PedidoConector = {
    provider: 'google_ads',
    conta: g.chave,
    url: `${g.base}/${g.versao}/geoTargetConstants:suggest`,
    metodo: 'POST',
    corpo: consultaDeLugares(nomes),
    endpoint: 'geo_target_constants (leitura)',
    apiVersion: g.versao,
    cabecalhos: g.cabecalhos,
  };
  return lugaresDaResposta((await http(pedido)).corpo);
}

const descrever = (ls: readonly LugarNoGoogle[]): string =>
  ls.slice(0, 6).map((l) => `${l.tipo} ${l.nome} [${l.nomeCanonico}] ${l.recurso} pai ${l.pai ?? '—'} (${l.situacao}, buscado "${l.buscado}")`).join('; ') || 'nenhum';

/**
 * A prova inteira: cada passo com o resultado e o detalhe, para o registro e para a LIAME. Parou no meio (a trava ou
 * um erro inesperado): `ProvaInterrompida`, com os passos que já saíram.
 */
export async function provaDaRegiao(ctx: ContextoDaProva): Promise<ResultadoDoPasso[]> {
  const saida: ResultadoDoPasso[] = [];
  try {
    await passos({ ...ctx, http: comTrava(ctx.http) }, saida);
  } catch (err) {
    throw new ProvaInterrompida([...saida], err);
  }
  return saida;
}

async function passos(ctx: ContextoDaProva, saida: ResultadoDoPasso[]): Promise<void> {
  const g = ctx.google;
  const http = ctx.http;

  // 1. Os temas: quantos e de que tamanho, só validando no grupo de recursos da campanha do piloto.
  if (!g) saida.push({ passo: 'google: temas', resultado: 'pulado', detalhe: 'sem campanha do Google no ar nesta empresa' });
  else {
    const grupo = `customers/${g.cliente}/assetGroups/${g.grupo}`;
    for (const n of [25, 26, 50, 51]) saida.push(await mutarSoValidando(http, g, `google: ${n} temas`, temasDeTeste(n).map((t) => sinalDoTema(grupo, t))));
    for (const n of [TAMANHO_DO_TEMA, TAMANHO_DO_TEMA + 1]) saida.push(await mutarSoValidando(http, g, `google: um tema de ${n} caracteres`, [sinalDoTema(grupo, temaDeTamanho(n))]));
  }

  // 2. Os lugares: o estado, a cidade cujo pai é o estado, e os bairros cujo pai é a cidade.
  const achados: { bairro: BairroDaProva; lugar: LugarNoGoogle }[] = [];
  if (g) {
    try {
      const nomeDoEstado = ESTADOS_DO_BRASIL[ctx.loja.uf.toUpperCase()] ?? null;
      if (!nomeDoEstado) throw new Error(`UF desconhecida: ${ctx.loja.uf}`);
      const deEstado = await sugerir(http, g, [nomeDoEstado]);
      const estado = lugarDoTipo(deEstado, 'State', null);
      saida.push({ passo: 'google: o estado', resultado: 'lido', detalhe: `${estado ? `escolhido ${estado.recurso}` : 'nenhum escolhido'}. Sugeridos: ${descrever(deEstado)}` });
      const deCidade = await sugerir(http, g, [ctx.loja.cidade]);
      const cidade = estado ? lugarDoTipo(deCidade, 'City', estado.recurso) : null;
      saida.push({ passo: 'google: a cidade', resultado: 'lido', detalhe: `${cidade ? `escolhida ${cidade.recurso}` : 'nenhuma escolhida'}. Sugeridas: ${descrever(deCidade)}` });
      for (const b of ctx.loja.bairros.slice(0, 3)) {
        const deBairro = await sugerir(http, g, [b.nome]);
        const lugar = cidade ? lugarDoTipo(deBairro, 'Neighborhood', cidade.recurso) : null;
        if (lugar) achados.push({ bairro: b, lugar });
        saida.push({ passo: `google: o bairro ${b.nome}`, resultado: 'lido', detalhe: `${lugar ? `escolhido ${lugar.recurso}` : 'nenhum: vai por círculo'}. Sugeridos: ${descrever(deBairro)}` });
      }
    } catch (err) {
      saida.push(falha('google: os lugares', err));
    }
  }

  // Os bairros dos passos 3 e 3b: até 2 pelo lugar do Google e 1 por círculo.
  const pelosLugares = achados.slice(0, 2);
  const doCirculo = ctx.loja.bairros.find((b) => !pelosLugares.some((a) => a.bairro === b)) ?? ctx.loja.bairros[0] ?? null;
  const descricaoDosBairros = `${pelosLugares.length} bairro(s) pelo lugar + ${doCirculo ? 1 : 0} por círculo`;

  // 3. Na campanha que está no ar: os bairros e a campanha em PRESENCE, juntos (só validando).
  if (!g) saida.push({ passo: 'google: bairros + PRESENCE', resultado: 'pulado', detalhe: 'sem campanha do Google no ar nesta empresa' });
  else {
    const campanha = `customers/${g.cliente}/campaigns/${g.campanha}`;
    const ops: unknown[] = pelosLugares.map((a) => criterioDoLugar(campanha, a.lugar));
    if (doCirculo) ops.push(criterioDoCirculo(campanha, doCirculo));
    ops.push({ campaignOperation: { updateMask: 'geo_target_type_setting.positive_geo_target_type', update: { resourceName: campanha, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } } } });
    saida.push(await mutarSoValidando(http, g, `google: ${descricaoDosBairros} + PRESENCE`, ops));
  }

  // 3b. A criação inteira do jeito do desenho: os temas no grupo de recursos novo e os bairros no lugar do raio.
  const passo3b = `google: a criação inteira com 3 temas e ${descricaoDosBairros} (prova)`;
  if (!g || !ctx.criacao) saida.push({ passo: passo3b, resultado: 'pulado', detalhe: !g ? 'sem campanha do Google no ar nesta empresa' : 'sem a campanha aprovada para montar' });
  else if ('erro' in ctx.criacao) saida.push({ passo: passo3b, resultado: 'falhou', detalhe: ctx.criacao.erro });
  else {
    let ops: unknown[] | null = null;
    try {
      ops = criacaoComARegiao(ctx.criacao.operacoes, temasDeTeste(3), pelosLugares.map((a) => a.lugar), doCirculo);
    } catch (err) {
      saida.push(falha(passo3b, err));
    }
    if (ops) saida.push(await mutarSoValidando(http, g, passo3b, ops));
  }

  // 4. A categoria do perfil e o nome dela em português.
  if (!ctx.perfil) saida.push({ passo: 'perfil: a categoria', resultado: 'pulado', detalhe: 'sem Perfil do Google ligado à loja' });
  else {
    try {
      const c = await ctx.perfil.categoria();
      if (!c) saida.push({ passo: 'perfil: a categoria', resultado: 'lido', detalhe: 'o perfil não devolveu a categoria principal' });
      else {
        const pt = await ctx.perfil.nome(c.id);
        saida.push({ passo: 'perfil: a categoria', resultado: 'lido', detalhe: `${c.id}; como veio: ${c.nome ?? '—'}; em pt-BR (batchGet): ${pt ?? '—'}` });
      }
    } catch (err) {
      saida.push(falha('perfil: a categoria', err));
    }
  }

  // 5. Meta: o mesmo público de um conjunto do Liame, com o círculo de um bairro de fora, só validando. A recusa pode
  //    ser de um campo lido que a Meta não aceita de volta: o detalhe traz o motivo, para ler antes de concluir.
  const m = ctx.meta;
  const bairro = ctx.loja.bairros[0];
  if (!m || !bairro) saida.push({ passo: 'meta: tirar um bairro', resultado: 'pulado', detalhe: !m ? 'nenhum conjunto ativo de campanha do Liame na Meta' : 'a loja não tem bairro' });
  else {
    const params = new URLSearchParams({ targeting: JSON.stringify(publicoSemOBairro(m.conjunto.targeting, bairro)), execution_options: EXECUCAO_SO_VALIDANDO });
    if (m.appSecret) params.set('appsecret_proof', createHmac('sha256', m.appSecret).update(m.token).digest('hex'));
    const pedido: PedidoConector = {
      provider: 'meta_ads',
      conta: m.conta,
      url: `${m.base}/${m.versao}/${m.conjunto.id}?${params.toString()}`,
      metodo: 'POST',
      endpoint: 'prova_da_regiao (validação)',
      apiVersion: m.versao,
      cabecalhos: { authorization: `Bearer ${m.token}` },
      custo: 3,
    };
    exigirSoValidacao('meta_ads', pedido);
    const passo = `meta: tirar ${bairro.nome} do conjunto ${m.conjunto.id}`;
    try {
      const r = await http(pedido);
      const ok = (r.corpo as { success?: unknown } | null)?.success === true;
      saida.push({ passo, resultado: ok ? 'aceito' : 'recusado', detalhe: ok ? 'a Meta validou o público com o bairro de fora; nada foi mudado.' : 'a Meta não confirmou a validação.' });
    } catch (err) {
      saida.push(falha(passo, err));
    }
  }
}
