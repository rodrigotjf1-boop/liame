import type { ActionOpenRequest, ActionOptionsResponse, ActionTargetsResponse, AdObject, BudgetMonthResponse, CreateActionRequest } from '@liame/contracts';
import { enderecoDoPedido } from '@/components/aprovacoes/textos';
import { artigo, autorizadorDa, plataforma } from '@/components/contas/textos';
import { type Frase, horaNoFuso, quandoNoFuso, type Trecho } from '@/components/resultados/textos';
import { reaisDigitados } from '@/components/verba/textos';
import type { NomeIcone } from '@/components/ui/icone';
import { mensagemDe, type Problema } from '@/lib/api';
import { reaisDeMicros } from '@/lib/formato';

// Regras e frases do pedido de mudança (A4 · X8; protótipo P9, aprovado em 05/10/2026: mockups/prototipo-anuncios.html).
// O Google no pedido (A5 · Y3; protótipo P13, parte 1, aprovado em 09/10/2026: mockups/prototipo-google-pedido.html): a
// mudança é na campanha inteira, e a verba dividida entre campanhas não muda pelo Liame.
// O botão "Pedir mudança" de Resultados e a gaveta "Pedir uma mudança". Quem decide se o pedido entra é o servidor
// (`POST /v1/actions`: a política, os limites da empresa, a conta do mês e a leitura na plataforma). Aqui o que o
// servidor devolve vira as frases do protótipo, e a gaveta confere antes de enviar só o que dá para saber com
// certeza: valor ilegível ou igual ao de agora, a faixa por pedido, o pedido repetido e os limites já lidos.
// Funções puras; listas que crescem chegam como texto (V23): ferramenta ou situação nova tem saída.

const reais = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
const b = (t: string): Trecho => ({ t, b: true });
const maiuscula = (t: string): string => t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1);
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const CENTAVO = 10_000;
/** A menor verba diária que um pedido aceita (o mesmo mínimo do servidor): R$ 1,00. */
const VERBA_MINIMA = 1_000_000;

/** "na Meta", "no Google": onde o objeto é lido e onde a mudança acontece. */
export function naPlataforma(provider: string): string {
  const quem = artigo(autorizadorDa(provider), false);
  return quem.startsWith('a ') ? `na ${quem.slice(2)}` : quem.startsWith('o ') ? `no ${quem.slice(2)}` : `em ${quem}`;
}

// ------------------------------------------------------------------ Resultados: onde dá para pedir

export type PedirNaCampanha = {
  /** Os pedidos em aberto na campanha: "1 pedido esperando", com o endereço do mais novo em Aprovações. */
  esperando: { rotulo: string; href: string } | null;
};

/**
 * As campanhas em que dá para pedir uma mudança (`GET /v1/actions/targets`), pela chave da campanha. A campanha de
 * conta que só lê também entra: o botão abre a gaveta, que diz para conectar a plataforma de novo.
 */
export function pedirPorCampanha(alvos: ActionTargetsResponse | null): Map<string, PedirNaCampanha> {
  const mapa = new Map<string, PedirNaCampanha>();
  for (const c of alvos?.campaigns ?? []) {
    const n = c.open.length;
    mapa.set(c.campaign_id, { esperando: n ? { rotulo: n === 1 ? '1 pedido esperando' : `${n} pedidos esperando`, href: enderecoDoPedido(c.open[0]!.id) } : null });
  }
  return mapa;
}

const juntar = (itens: string[]): string => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
/** As plataformas saem sempre na mesma ordem (a Meta, o Google, depois as outras), e não na ordem da lista de campanhas. */
const ORDEM_DAS_PLATAFORMAS = ['meta_ads', 'google_ads'];
function emOrdem(provedores: readonly string[]): string[] {
  const lugar = (p: string) => (ORDEM_DAS_PLATAFORMAS.includes(p) ? ORDEM_DAS_PLATAFORMAS.indexOf(p) : ORDEM_DAS_PLATAFORMAS.length);
  return [...new Set(provedores)].sort((a, b) => lugar(a) - lugar(b));
}
/** "da Meta", "do Google". */
function daPlataforma(provider: string): string {
  const quem = artigo(autorizadorDa(provider), false);
  return quem.startsWith('a ') ? `da ${quem.slice(2)}` : quem.startsWith('o ') ? `do ${quem.slice(2)}` : `de ${quem}`;
}

/**
 * A nota embaixo da lista de campanhas: o que o botão faz e em quais plataformas ele vale (`comPedido`); as campanhas
 * das outras plataformas da lista (`soLeitura`) seguem só para leitura.
 */
export function notaDoPedir(comPedido: readonly string[], soLeitura: readonly string[]): string {
  const onde = juntar([...new Set(emOrdem(comPedido).map(daPlataforma))]);
  // A campanha sem botão de uma plataforma que tem botão (arquivada, ou de conta sem a escrita) não entra na frase.
  const outras = juntar([...new Set(emOrdem(soLeitura.filter((p) => !comPedido.includes(p))).map(daPlataforma))]);
  // No Google o pedido não desce ao grupo de anúncios nem ao anúncio (P13).
  const noGoogle = comPedido.includes('google_ads') ? ' No Google, a mudança é na campanha inteira.' : '';
  return `“Pedir mudança” vale para as campanhas ${onde}: mudar a verba, pausar e retomar, sempre com a sua aprovação.${noGoogle}${outras ? ` As ${outras} seguem só para leitura.` : ''}`;
}

/**
 * A lista de campanhas ganha a coluna do pedido? Só quando alguma campanha à vista tem o que mostrar: o botão (para
 * quem opera as campanhas) ou um pedido esperando (para quem só acompanha).
 */
export function mostraOPedir(campanhas: readonly string[], porCampanha: ReadonlyMap<string, PedirNaCampanha>, podePedir: boolean): boolean {
  return campanhas.some((id) => {
    const p = porCampanha.get(id);
    return p !== undefined && (podePedir || p.esperando !== null);
  });
}

// ------------------------------------------------------------------ a gaveta: o que dá para pedir

export type Acao = 'verba' | 'pausar' | 'retomar';
export type OpcaoDeAcao = { acao: Acao; tool: string; rotulo: string; icone: NomeIcone };

const DA_ACAO: Record<Acao, { rotulo: string; icone: NomeIcone }> = {
  verba: { rotulo: 'A verba diária', icone: 'wallet' },
  pausar: { rotulo: 'Pausar', icone: 'pause' },
  retomar: { rotulo: 'Retomar', icone: 'play' },
};

function acaoDaFerramenta(tool: string): Acao | null {
  if (tool === 'orcamento_ajustar') return 'verba';
  if (tool.endsWith('_pausar')) return 'pausar';
  if (tool.endsWith('_retomar')) return 'retomar';
  return null;
}

/** As ações que a gaveta oferece, na ordem do servidor. A ferramenta que a tela ainda não conhece fica de fora. */
export function acoesDe(tools: readonly string[]): OpcaoDeAcao[] {
  const vistas = new Set<Acao>();
  return tools.flatMap((tool) => {
    const acao = acaoDaFerramenta(tool);
    if (!acao || vistas.has(acao)) return [];
    vistas.add(acao);
    return [{ acao, tool, ...DA_ACAO[acao] }];
  });
}

/** O campo "Onde": a campanha inteira (valor vazio) ou um conjunto ou anúncio dela (o `resource_id`). */
export type OndeDaGaveta = { conjuntos: { valor: string; rotulo: string }[]; anuncios: { valor: string; rotulo: string }[] };

const noCampo = (o: AdObject): { valor: string; rotulo: string } => ({ valor: o.resource_id, rotulo: o.status === 'pausado' ? `${o.name} (pausado)` : o.name });

export function ondeDe(o: Pick<ActionOptionsResponse, 'ad_sets' | 'ads'>): OndeDaGaveta {
  return { conjuntos: o.ad_sets.map(noCampo), anuncios: o.ads.map(noCampo) };
}

/**
 * O campo "Onde" só aparece quando há o que escolher. No Google a mudança é na campanha inteira (P13): o servidor
 * manda as duas listas vazias, e a gaveta abre direto na campanha.
 */
export const temOnde = (onde: OndeDaGaveta): boolean => onde.conjuntos.length + onde.anuncios.length > 0;

// ------------------------------------------------------------------ a verba dividida (Google Ads)

type Dividida = NonNullable<ActionOptionsResponse['target']['shared_budget']>;

/** Com quantas OUTRAS campanhas a verba é dividida: os nomes que vieram, ou a contagem da plataforma sem esta. */
const outrasNaVerba = (d: Dividida): number => Math.max(d.shared_with.length, d.campaigns - 1, 0);
const comOutras = (n: number): string => (n === 1 ? 'outra campanha' : `outras ${n} campanhas`);

export type VerbaDividida = {
  titulo: string;
  /** Por que o Liame não muda: com quantas campanhas a verba é dividida, e de quanto é o orçamento inteiro. */
  texto: Frase;
  /** Esta campanha e as outras de que a plataforma disse o nome. Vazia quando os nomes não vieram, ou só esta usa. */
  campanhas: { nome: string; papel: string }[];
  /** "e mais 2 campanhas": a plataforma informa mais campanhas do que os nomes que vieram. */
  mais: string | null;
  /** O que dá para fazer: pausar e retomar aqui, e a verba na plataforma. */
  depois: string;
};

/**
 * O aviso da verba dividida (P13): no Google a verba mora num orçamento que pode servir a várias campanhas, e o Liame
 * nunca muda um orçamento dividido (D-A5-4). Nulo quando a verba é só do objeto.
 */
export function verbaDividida(o: ActionOptionsResponse): VerbaDividida | null {
  const d = o.target.shared_budget ?? null;
  if (!d) return null;
  const n = outrasNaVerba(d);
  const Na = maiuscula(naPlataforma(o.campaign.provider));
  const nome = plataforma(o.campaign.provider).nome;
  const valor: Frase = d.daily_micros !== null ? [{ t: ' de ' }, b(`${reais(d.daily_micros)} por dia`)] : [];
  const titulo = 'O Liame não muda esta verba';
  if (n === 0) {
    // O orçamento foi criado para ser dividido, mas hoje só esta campanha usa: é dividido do mesmo jeito.
    return {
      titulo,
      texto: [{ t: `${Na}, a verba desta campanha vem de um orçamento` }, ...valor, { t: ' criado para ser dividido entre campanhas. Hoje só ela usa, mas o Liame não muda orçamento dividido.' }],
      campanhas: [],
      mais: null,
      depois: `Pausar e retomar esta campanha pode. Para mudar a verba, mude no ${nome}.`,
    };
  }
  const faltam = n - d.shared_with.length;
  return {
    titulo,
    texto: [{ t: `${Na}, esta campanha divide um orçamento` }, ...valor, { t: ` com ${comOutras(n)}. Mudar aqui mudaria a verba ${n === 1 ? 'dela' : 'delas'} também, sem ninguém ter pedido.` }],
    campanhas: d.shared_with.length ? [{ nome: o.target.name, papel: 'esta campanha' }, ...d.shared_with.map((x) => ({ nome: x, papel: 'divide a mesma verba' }))] : [],
    mais: d.shared_with.length && faltam > 0 ? `e mais ${faltam === 1 ? '1 campanha' : `${faltam} campanhas`}` : null,
    depois: `Pausar e retomar esta campanha pode: só ela para. Para mudar a verba, mude no ${nome}, onde você vê as campanhas juntas.`,
  };
}

// ------------------------------------------------------------------ o objeto, em palavras

type Tipo = 'campanha' | 'conjunto' | 'anuncio';
const tipoDe = (kind: string): Tipo => (kind === 'conjunto' || kind === 'anuncio' ? kind : 'campanha');
const NOME_DO_TIPO: Record<Tipo, string> = { campanha: 'campanha', conjunto: 'conjunto', anuncio: 'anúncio' };

/** Como o objeto entra numa frase: "a campanha “Combo sexta”", "do conjunto “Noite · raio de 3 km”". */
function alvoEmFrase(alvo: Pick<AdObject, 'kind' | 'name'>): { o: string; do: string; fem: boolean } {
  const tipo = tipoDe(alvo.kind);
  const fem = tipo === 'campanha';
  return { o: `${fem ? 'a' : 'o'} ${NOME_DO_TIPO[tipo]} “${alvo.name}”`, do: `${fem ? 'da' : 'do'} ${NOME_DO_TIPO[tipo]} “${alvo.name}”`, fem };
}
/** "pausado" → "pausada" na campanha. */
const comGenero = (palavra: string, fem: boolean): string => (fem && palavra.endsWith('o') ? `${palavra.slice(0, -1)}a` : palavra);

const SITUACAO: Record<string, string> = { ativo: 'ativo', pausado: 'pausado', arquivado: 'arquivado', removido: 'removido' };

/** "Ativa", "Pausado", "Arquivada"… A situação que a tela ainda não conhece sai como veio. */
function situacaoEscrita(status: string, fem: boolean): string {
  const conhecida = SITUACAO[status];
  if (!conhecida) return status === 'desconhecido' ? 'Situação desconhecida' : maiuscula(status.replaceAll('_', ' '));
  return maiuscula(comGenero(conhecida, fem));
}

/** O que a plataforma diz da entrega quando o objeto está ativo e o pai dele não: ele não roda enquanto o pai está parado. */
function entregaParada(o: ActionOptionsResponse['target']): string | null {
  if (o.status !== 'ativo') return null;
  if (o.effective_status === 'CAMPAIGN_PAUSED') return 'a campanha está em pausa: ele não roda enquanto ela estiver parada';
  if (o.effective_status === 'ADSET_PAUSED') return 'o conjunto dele está em pausa: ele não roda enquanto o conjunto estiver parado';
  return null;
}

export type LinhaDeAgora = { rotulo: string; valor: string; sub: string | null };
export type AgoraNaPlataforma = { titulo: string; linhas: LinhaDeAgora[] };

/** O bloco "Agora, na Meta": o objeto como a plataforma respondeu neste momento. É dele que o pedido parte. */
export function agoraNaPlataforma(o: ActionOptionsResponse, fuso: string): AgoraNaPlataforma {
  const alvo = o.target;
  const tipo = tipoDe(alvo.kind);
  const na = naPlataforma(o.campaign.provider);
  const linhas: LinhaDeAgora[] = [];
  if (tipo !== 'campanha') linhas.push({ rotulo: maiuscula(NOME_DO_TIPO[tipo]), valor: alvo.name, sub: null });
  linhas.push({ rotulo: 'Situação', valor: situacaoEscrita(alvo.status, tipo === 'campanha'), sub: entregaParada(alvo) });

  let verba: Pick<LinhaDeAgora, 'valor' | 'sub'>;
  const dividida = alvo.shared_budget ?? null;
  if (dividida) {
    // A verba é do orçamento inteiro, e não desta campanha (P13): o valor dele, e com quantas ela divide.
    const n = outrasNaVerba(dividida);
    verba = { valor: dividida.daily_micros !== null ? reais(dividida.daily_micros) : 'Dividida', sub: n > 0 ? `dividida com ${comOutras(n)}` : 'de um orçamento criado para ser dividido' };
  } else if (alvo.daily_micros !== null) {
    verba = { valor: reais(alvo.daily_micros), sub: tipo === 'campanha' ? 'na campanha' : 'no conjunto' };
  } else if (tipo === 'campanha') {
    const nosConjuntos = o.ad_sets.filter((c) => c.daily_micros !== null).map((c) => `${c.name}: ${reais(c.daily_micros!)}${c.status === 'pausado' ? ' (pausado)' : ''}`);
    verba = nosConjuntos.length ? { valor: 'Fica nos conjuntos', sub: nosConjuntos.join(' · ') } : { valor: 'Não tem verba diária', sub: 'a verba desta campanha é de período, ou a plataforma não informou' };
  } else if (tipo === 'conjunto') {
    verba = { valor: 'Não tem verba própria', sub: 'a verba fica na campanha, ou é de período' };
  } else {
    const conjunto = o.ads.find((a) => a.resource_id === alvo.resource_id)?.ad_set ?? null;
    const noConjunto = conjunto !== null && o.ad_sets.some((c) => c.resource_id === conjunto && c.daily_micros !== null);
    verba = { valor: 'Não tem verba própria', sub: `o anúncio gasta dentro da verba ${noConjunto ? 'do conjunto dele' : 'da campanha'}` };
  }
  linhas.push({ rotulo: 'Verba diária', ...verba });
  linhas.push({ rotulo: `Lido ${na}`, valor: `agora, às ${horaNoFuso(new Date(o.read_at), fuso)}`, sub: null });
  return { titulo: `Agora, ${na}`, linhas };
}

/** O objeto não aceita mudança (arquivado, removido ou em situação que a tela não conhece): o porquê, no lugar das opções. */
export function semOpcoes(o: ActionOptionsResponse): string {
  const alvo = alvoEmFrase(o.target);
  const na = naPlataforma(o.campaign.provider);
  if (o.target.status === 'arquivado' || o.target.status === 'removido') {
    return `${maiuscula(alvo.o)} foi ${comGenero('arquivado', alvo.fem)} ou ${comGenero('removido', alvo.fem)} ${na}: não dá para mudar.`;
  }
  return `Não há mudança que caiba aqui agora: ${alvo.o} está ${na} numa situação que o Liame não muda.`;
}

/** "Lendo a campanha na Meta, para o pedido partir do que está valendo agora…" */
export const lendoNaPlataforma = (provider: string): string => `Lendo a campanha ${naPlataforma(provider)}, para o pedido partir do que está valendo agora…`;

/** De quando é a lista de conjuntos e anúncios do campo "Onde" (a da leitura diária); nulo se a conta nunca foi lida. */
export function listaLidaEm(o: Pick<ActionOptionsResponse, 'listed_at' | 'ad_sets' | 'ads'>, fuso: string, agora: Date): string | null {
  if (!o.listed_at || (!o.ad_sets.length && !o.ads.length)) return null;
  return `A lista de conjuntos e anúncios é a da leitura de ${quandoNoFuso(o.listed_at, fuso, agora)}.`;
}

/** O rodapé da gaveta: o caminho do pedido depois de enviado. */
export function notaDoPedido(provider: string): string {
  const quem = artigo(autorizadorDa(provider), false);
  return `O pedido vai para Aprovações. Depois da aprovação com o código do app, o Liame confere com ${quem}, faz a mudança e avisa. Dá para desfazer, se ninguém mexer depois.`;
}

// ------------------------------------------------------------------ os limites da empresa

export type LimitesDaGaveta =
  | { tipo: 'sem'; titulo: string; texto: string }
  | { tipo: 'ok'; linhas: { rotulo: string; valor: string }[] };

/** Os limites que valem para o pedido, pela verba do mês; nulo quando ela não foi lida (o servidor confere no pedido). */
export function limitesDaGaveta(v: BudgetMonthResponse | null): LimitesDaGaveta | null {
  if (!v) return null;
  const { month_micros: mes, campaign_daily_micros: campanha } = v.limits;
  if (mes === null || campanha === null) {
    return { tipo: 'sem', titulo: 'A empresa ainda não definiu os limites', texto: 'Sem o teto do mês e o teto por campanha, o Liame só reduz verba e pausa. Aumentar e retomar ficam negados.' };
  }
  const sobra = v.remaining_micros;
  const linhas = [
    { rotulo: 'Teto por campanha', valor: `${reais(campanha)} por dia` },
    { rotulo: `Verba de ${mesDe(v)}`, valor: sobra === null ? `teto de ${reais(mes)}` : sobra >= 0 ? `sobram ${reais(sobra)} de ${reais(mes)}` : `passa ${reais(-sobra)} do teto de ${reais(mes)}` },
  ];
  if (v.rules.change_percent_max !== null) linhas.push({ rotulo: 'Por pedido', valor: `no máximo ${porcento(v.rules.change_percent_max)} da verba` });
  return { tipo: 'ok', linhas };
}

const mesDe = (v: Pick<BudgetMonthResponse, 'period'>): string => MESES[Number(v.period.slice(5, 7)) - 1] ?? v.period;
/** "10%", "7,5%". */
const porcento = (n: number): string => `${(Math.round(n * 10) / 10).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

// ------------------------------------------------------------------ a verba pedida

/** Quanto um pedido pode mexer na verba, em %: a regra da distribuição, lida do servidor; sem ela, a tela não limita. */
export const passoDaVerba = (v: BudgetMonthResponse | null): number | null => v?.rules.change_percent_max ?? null;

/**
 * De quanto a quanto a verba pode ir num pedido só, em centavos inteiros e sem passar do passo: o mínimo arredonda
 * para cima e o máximo para baixo (R$ 33,33 com 10% vai de R$ 30,00 a R$ 36,66). Conta em inteiros, sem ponto flutuante.
 */
export function faixaDaVerba(atualMicros: number, pct: number): { min: number; max: number } {
  const centavos = Math.round(atualMicros / CENTAVO);
  const decimos = Math.round(pct * 10);
  // A verba diária não desce de R$ 1,00 (o mínimo que o pedido aceita).
  const min = Math.max(Math.ceil((centavos * (1000 - decimos)) / 1000) * CENTAVO, Math.min(atualMicros, VERBA_MINIMA));
  return { min, max: Math.floor((centavos * (1000 + decimos)) / 1000) * CENTAVO };
}

export type DicaDaVerba = {
  /** "Hoje: R$ 40,00 por dia. Cada pedido muda no máximo 10%: de R$ 36,00 a R$ 44,00." */
  texto: string;
  /** Os dois atalhos ("Reduzir 10%" e "Aumentar 10%"), com o valor que cada um põe no campo; nulo sem a regra lida. */
  atalhos: { reduzir: { rotulo: string; valor: string }; aumentar: { rotulo: string; valor: string } } | null;
};

/** A dica do campo da verba e os dois atalhos, pela verba de agora e pelo passo da regra. */
export function dicaDaVerba(atualMicros: number, v: BudgetMonthResponse | null): DicaDaVerba {
  const hoje = `Hoje: ${reais(atualMicros)} por dia.`;
  const pct = passoDaVerba(v);
  if (pct === null) return { texto: hoje, atalhos: null };
  const f = faixaDaVerba(atualMicros, pct);
  return {
    texto: `${hoje} Cada pedido muda no máximo ${porcento(pct)}: de ${reais(f.min)} a ${reais(f.max)}.`,
    atalhos: { reduzir: { rotulo: `Reduzir ${porcento(pct)}`, valor: verbaNoCampo(f.min) }, aumentar: { rotulo: `Aumentar ${porcento(pct)}`, valor: verbaNoCampo(f.max) } },
  };
}

/** "36,00": o valor no campo, sempre com os centavos (é o que a pessoa vai conferir). */
export function verbaNoCampo(micros: number): string {
  const centavos = Math.round(micros / CENTAVO);
  return `${Math.floor(centavos / 100)},${String(centavos % 100).padStart(2, '0')}`;
}

/** O que a pessoa montou na gaveta: a ação escolhida e, na verba, o que está digitado. */
export type Rascunho = { acao: Acao; valor: string };

type Sobe = { porDia: number; aumento: boolean };

/** O pedido faz o gasto subir? Aumentar a verba e retomar: é o que pede os limites da empresa e a conta do mês. */
function sobeOGasto(o: ActionOptionsResponse, r: Rascunho): Sobe | null {
  const atual = o.target.daily_micros;
  if (r.acao === 'retomar') return { porDia: atual ?? 0, aumento: false };
  if (r.acao !== 'verba' || atual === null) return null;
  const para = reaisDigitados(r.valor);
  return para !== null && para > atual ? { porDia: para - atual, aumento: true } : null;
}

type Barreira = 'sem-limites' | 'teto-campanha' | 'teto-mes';

/**
 * O que barraria o pedido que faz o gasto subir, pelos limites já lidos (a mesma ordem do servidor): os limites
 * definidos, o teto por campanha (só no aumento) e caber no mês. Sem a verba lida, nada é antecipado.
 */
function barreiraDoPedido(o: ActionOptionsResponse, r: Rascunho, v: BudgetMonthResponse | null): Barreira | null {
  const sobe = sobeOGasto(o, r);
  if (!sobe || !v) return null;
  const { month_micros: mes, campaign_daily_micros: campanha } = v.limits;
  if (mes === null || (sobe.aumento && campanha === null)) return 'sem-limites';
  if (sobe.aumento && campanha !== null && (o.target.daily_micros ?? 0) + sobe.porDia > campanha) return 'teto-campanha';
  if (v.remaining_micros !== null && v.remaining_micros - sobe.porDia * v.days_left < 0) return 'teto-mes';
  return null;
}

/** A frase do efeito: o que muda se o pedido for aprovado, e se cabe nos limites. */
export function efeitoDoPedido(o: ActionOptionsResponse, r: Rascunho, v: BudgetMonthResponse | null): Frase {
  const alvo = alvoEmFrase(o.target);
  const A = maiuscula(alvo.o);
  const atual = o.target.daily_micros;
  const barreira = barreiraDoPedido(o, r, v);
  const sobra = v && v.remaining_micros !== null && v.remaining_micros >= 0 ? ` (sobram ${reais(v.remaining_micros)})` : '';
  const ateOFim = v ? `Até o fim de ${mesDe(v)}` : null;

  if (r.acao === 'verba') {
    const para = reaisDigitados(r.valor);
    if (para === null || atual === null) return [{ t: 'Digite a nova verba diária para ver o que muda.' }];
    if (para === atual) return [{ t: `A verba já é de ${reais(atual)} por dia.` }];
    const dif = para - atual;
    const pct = `${dif < 0 ? '−' : '+'}${porcento((Math.abs(dif) / atual) * 100)}`;
    // Fora do passo por pedido, a frase não promete o que o pedido não vai poder fazer.
    const passo = passoDaVerba(v);
    if (passo !== null) {
      const f = faixaDaVerba(atual, passo);
      if (para < f.min || para > f.max) return [{ t: 'A verba ' }, b(`${dif < 0 ? 'cai' : 'sobe'} ${reais(Math.abs(dif))} por dia`), { t: ` (${pct}): passa do máximo de ${porcento(passo)} por pedido.` }];
    }
    if (dif < 0) return [{ t: 'A verba ' }, b(`cai ${reais(-dif)} por dia`), { t: ` (${pct}). Reduzir não depende do teto por campanha nem da verba do mês.` }];
    const sobe: Frase = [{ t: 'A verba ' }, b(`sobe ${reais(dif)} por dia`), { t: ` (${pct}).` }];
    if (!v || !ateOFim) return [...sobe, { t: ' O Liame confere com os limites da empresa ao receber o pedido.' }];
    const total = `${ateOFim} são ${reais(dif * v.days_left)} a mais`;
    if (barreira === 'sem-limites') return [...sobe, { t: ` ${total}, e a empresa ainda não definiu os limites.` }];
    if (barreira === 'teto-campanha') return [...sobe, { t: ` ${total}, mas o valor passa do teto por campanha.` }];
    if (barreira === 'teto-mes') return [...sobe, { t: ` ${total}, e ` }, b('não cabem'), { t: ' na verba do mês.' }];
    return [...sobe, { t: ` ${total}: cabem na verba do mês${sobra}.` }];
  }

  if (r.acao === 'pausar') {
    const hoje = atual !== null ? ` (hoje ${reais(atual)} por dia)` : '';
    return [{ t: `${A} ` }, b('para de aparecer e de gastar'), { t: `${hoje}. Fica ${comGenero('pausado', alvo.fem)}, não ${comGenero('apagado', alvo.fem)}.` }];
  }

  const jaPassou = v !== null && v.remaining_micros !== null && v.remaining_micros < 0;
  const negado =
    barreira === 'teto-mes'
      ? jaPassou
        ? ' Mas o mês já passa do teto: retomar fica negado.'
        : ' Mas isso não cabe na verba do mês: retomar fica negado.'
      : barreira === 'sem-limites'
        ? ' Mas a empresa ainda não definiu o teto do mês: retomar fica negado.'
        : '';
  const volta: Frase = [{ t: `${A} ` }, b('volta a aparecer e a gastar')];
  if (atual === null) return [...volta, { t: `, dentro da verba que já existe: a verba não muda.${negado}` }];
  const ate = { t: ` até ${reais(atual)} por dia.` };
  if (!v || !ateOFim) return [...volta, ate];
  const total = ` ${ateOFim} são até ${reais(atual * v.days_left)}`;
  return negado ? [...volta, ate, { t: `${total}.${negado}` }] : [...volta, ate, { t: `${total}: cabem na verba do mês${sobra}.` }];
}

// ------------------------------------------------------------------ a conferência antes de enviar

export type PedidoConferido =
  | { ok: true; corpo: CreateActionRequest }
  /** `noValor`: o erro é do campo da verba (o foco vai para ele). `ver`: o pedido que já existe. `limites`: falta definir os limites. */
  | { ok: false; erro: string; noValor: boolean; ver?: string; limites?: boolean };

const ESPERA: ActionOpenRequest['status'][] = ['aguardando_aprovacao'];

/** O pedido igual que já está em aberto (a mesma ferramenta no mesmo objeto): o servidor não aceita dois. */
function pedidoIgual(o: ActionOptionsResponse, tool: string): ActionOpenRequest | null {
  return o.open.find((p) => p.tool === tool && p.resource_id === o.target.resource_id) ?? null;
}

/**
 * Confere o pedido antes de enviar e devolve o corpo de `POST /v1/actions`, ou a recusa em palavras. `recomendacao`:
 * o pedido que nasce do "Pedir esta mudança" da Atenção leva a recomendação (o servidor confere que as duas batem).
 */
export function conferirPedido(o: ActionOptionsResponse, r: Rascunho, v: BudgetMonthResponse | null, recomendacao: string | null = null): PedidoConferido {
  const opcao = acoesDe(o.tools).find((a) => a.acao === r.acao);
  if (!opcao) return { ok: false, erro: 'Esta mudança não cabe mais neste objeto. Feche e abra de novo para ler como ele está agora.', noValor: false };
  const atual = o.target.daily_micros;
  let params: Record<string, unknown> = {};

  if (r.acao === 'verba') {
    const para = reaisDigitados(r.valor);
    if (para === null || para < VERBA_MINIMA || atual === null) return { ok: false, erro: 'Digite a nova verba diária em reais, como 36,00.', noValor: true };
    if (para === atual) return { ok: false, erro: `A verba já é de ${reais(atual)} por dia.`, noValor: true };
    params = { daily_budget_micros: para };
  }

  const igual = pedidoIgual(o, opcao.tool);
  if (igual) {
    const esperando = ESPERA.includes(igual.status);
    return {
      ok: false,
      erro: esperando ? 'Já existe um pedido igual esperando aprovação. Decida esse antes de pedir outro.' : 'Já existe um pedido igual sendo executado. Espere ele terminar antes de pedir outro.',
      noValor: false,
      ver: enderecoDoPedido(igual.id),
    };
  }

  if (r.acao === 'verba' && atual !== null) {
    const para = params.daily_budget_micros as number;
    const pct = passoDaVerba(v);
    if (pct !== null) {
      const f = faixaDaVerba(atual, pct);
      if (para < f.min || para > f.max) {
        return { ok: false, erro: `Cada pedido muda no máximo ${porcento(pct)}. De ${reais(atual)}, dá para ir de ${reais(f.min)} a ${reais(f.max)}. Para mudar mais, faça outro pedido depois deste.`, noValor: true };
      }
    }
  }

  const barreira = barreiraDoPedido(o, r, v);
  const noValor = r.acao === 'verba';
  if (barreira === 'sem-limites') {
    const oque = r.acao === 'verba' ? 'aumentar a verba' : 'retomar';
    return { ok: false, erro: `Para ${oque}, a empresa precisa definir antes o teto do mês${r.acao === 'verba' ? ' e o teto por campanha' : ''}. Reduzir e pausar não dependem deles.`, noValor, limites: true };
  }
  if (barreira === 'teto-campanha' && v) {
    return { ok: false, erro: `${reais(params.daily_budget_micros as number)} passa do teto por campanha, que é de ${reais(v.limits.campaign_daily_micros ?? 0)} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`, noValor };
  }
  if (barreira === 'teto-mes' && v) {
    // As mesmas palavras da recusa do servidor (`fraseDeNaoCaber`), com os números que decidem.
    const mes = mesDe(v);
    const sobra = v.remaining_micros ?? 0;
    const acrescenta = (sobeOGasto(o, r)?.porDia ?? 0) * v.days_left;
    const hoje = v.pending_micros > 0 ? `, mais ${reais(v.pending_micros)} de aumentos pedidos ou feitos hoje` : '';
    const conta = `No ritmo atual, ${mes} fecha em ${reais(v.forecast_micros)}${hoje}, e o teto é de ${reais(v.limits.month_micros ?? 0)}.`;
    const porque = sobra < 0 ? `o mês já passa do teto em ${reais(-sobra)}` : `o pedido acrescenta ${reais(acrescenta)} até o fim do mês, e sobram ${reais(sobra)}`;
    return { ok: false, erro: `Não cabe na verba de ${mes}: ${porque}. ${conta}`, noValor };
  }

  return {
    ok: true,
    corpo: {
      tool: opcao.tool,
      brand_id: o.campaign.brand_id,
      provider: o.campaign.provider,
      account_id: o.campaign.account_id,
      resource_id: o.target.resource_id,
      params,
      ...(recomendacao ? { recommendation_id: recomendacao } : {}),
    },
  };
}

/** A recusa do servidor ao criar o pedido, em palavras. */
export function erroDoPedido(p: Problema): { erro: string; ver?: string; limites?: boolean } {
  if (p.code === 'acao-duplicada') return { erro: 'Já existe um pedido igual em aberto. Decida esse antes de pedir outro.', ver: '/aprovacoes' };
  if (p.code === 'teto-nao-definido' || p.code === 'envelope-nao-definido') return { erro: p.detail ?? p.title, limites: true };
  // A política diz qual regra foi ferida em cada linha (o passo por pedido, o teto, a frequência).
  if (p.code === 'politica-negou' && p.errors?.length) return { erro: p.errors.map((e) => e.message).join(' ') };
  return { erro: mensagemDe(p) };
}

// ------------------------------------------------------------------ a leitura que falhou

export type FalhaDaLeitura = {
  /** `fora`: a plataforma não respondeu (dá para tentar de novo). `reconectar`: falta conectar de novo. `outra`: não dá para pedir aqui. */
  tipo: 'fora' | 'reconectar' | 'outra';
  titulo: string;
  texto: string;
};

/** Por que a gaveta não abriu o formulário: a leitura na plataforma falhou, ou o pedido não cabe nesta campanha agora. */
export function falhaDaLeitura(p: Problema, provider: string | null): FalhaDaLeitura {
  const na = provider ? naPlataforma(provider) : 'na plataforma';
  const quem = artigo(autorizadorDa(provider), false);
  if (p.code === 'conexao-so-leitura') {
    return {
      tipo: 'reconectar',
      titulo: `A conexão com ${quem} ainda não deixa o Liame mudar anúncios`,
      texto: `Hoje ela só deixa ler. Conecte ${quem} de novo em Contas conectadas: ${quem} vai pedir a permissão de gerenciar anúncios, e as contas que já estão ligadas continuam as mesmas.`,
    };
  }
  if (p.code === 'conta-desconectada' || p.code === 'sem-permissao-na-plataforma') {
    return { tipo: 'reconectar', titulo: `É preciso conectar ${quem} de novo`, texto: p.detail ?? p.title };
  }
  // A mensagem do servidor para a escrita desligada cita a chave da plataforma: aqui ela sai em palavras.
  if (p.code === 'escrita-desligada') {
    return { tipo: 'outra', titulo: 'Não dá para pedir uma mudança aqui agora', texto: 'Nesta conta, o Liame ainda não muda anúncios: por enquanto ele só lê os números dela.' };
  }
  if (p.status === 0 || p.status >= 500) {
    return {
      tipo: 'fora',
      titulo: `Não foi possível ler a campanha ${na} agora`,
      texto: `O pedido parte sempre do que está valendo ${na} neste momento. Sem essa leitura, nada foi pedido.`,
    };
  }
  return { tipo: 'outra', titulo: 'Não dá para pedir uma mudança aqui agora', texto: mensagemDe(p) };
}

// ------------------------------------------------------------------ o pedido criado

/** O título do pedido criado, pela ação que o servidor registrou: "Reduzir a verba da campanha “Smash em dobro”". */
export function tituloDoPedido(action: string, alvo: Pick<AdObject, 'kind' | 'name'>): string {
  const a = alvoEmFrase(alvo);
  if (action === 'orcamento.aumentar') return `Aumentar a verba ${a.do}`;
  if (action === 'orcamento.reduzir') return `Reduzir a verba ${a.do}`;
  if (action.endsWith('.pausar')) return `Pausar ${a.o}`;
  if (action.endsWith('.retomar')) return `Retomar ${a.o}`;
  return `Mudança ${a.do}`;
}

/** O que vem depois do título: o pedido espera a aprovação, ou seguiu de outro jeito (a política decide o modo). */
export function depoisDeCriar(status: string, provider: string): string {
  const na = naPlataforma(provider);
  if (status === 'aguardando_aprovacao') return `Ele espera a aprovação com o código do app. Nada muda ${na} antes disso.`;
  if (status === 'sombra') return `Ele ficou só registrado: nesta conta o Liame ainda não executa este tipo de mudança. Nada muda ${na}.`;
  return 'Acompanhe o andamento em Aprovações.';
}
