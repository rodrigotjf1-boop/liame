import type { AdDeliveryAccount, AdDeliveryCampaign, AdDeliveryResponse } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { dataNoFuso, diaMes, type Frase, horaNoFuso, type Periodo, somarDias } from './textos';

// "Como os anúncios rodaram" (mockups/prototipo-desempenho-anuncios.html, P23 aprovado em 16/10/2026): os números que
// a Meta e o Google informam, na contagem deles, e o "Ler agora". A conta é do servidor (`/v1/results/delivery`); aqui
// só se escolhe o que mostrar e a frase. Funções puras: o "agora" e o fuso entram como parâmetro (LIC-006). O que
// mudou do protótipo está em docs/decisoes-design.md (P23, o servidor e a tela).

export type Provedor = 'meta_ads' | 'google_ads';
const PROVEDORES: Provedor[] = ['meta_ads', 'google_ads'];
const NOME: Record<Provedor, { a: string; A: string; da: string; na: string }> = {
  meta_ads: { a: 'a Meta', A: 'A Meta', da: 'da Meta', na: 'na Meta' },
  google_ads: { a: 'o Google', A: 'O Google', da: 'do Google', na: 'no Google' },
};
const ehProvedor = (p: string): p is Provedor => p === 'meta_ads' || p === 'google_ads';

/** Conta que a plataforma não deixa ler até alguém agir em Contas conectadas: o "Ler agora" não a lê. */
export function precisaDeContas(c: AdDeliveryAccount): boolean {
  return c.status === 'desconectada' || c.status === 'sem_permissao';
}

// ------------------------------------------------------------------ "Ler agora": o andamento

/** Como cada conta estava quando a pessoa pediu "Ler agora" (para reconhecer o fim da tentativa). */
export type MarcaDaConta = { tentativa: string | null; erro: string | null };

/** O "Ler agora" desta tela. `vistas` = a última tentativa vista de cada conta, de uma consulta para a outra. */
export type LerAgora =
  | { tipo: 'parado' }
  | { tipo: 'pedindo' }
  /** `desde` = o relógio do navegador no pedido (o prazo da espera); `pedidoEm` = a hora do servidor (a comparação com as contas). */
  /** `anterior` = os números da tela no pedido (P23, parte B: o que mudou com a leitura). */
  | { tipo: 'lendo'; pedidoEm: string; desde: number; antes: Record<string, MarcaDaConta>; vistas: Record<string, string | null>; anterior?: AdDeliveryResponse }
  | { tipo: 'terminou'; pedidoEm: string; falharam: Provedor[]; anterior?: AdDeliveryResponse }
  | { tipo: 'demorou'; pedidoEm: string };

/** Quanto a tela espera a leitura pedida (o worker pega a conta em até meio minuto; a Meta pode levar alguns minutos). */
export const ESPERA_DA_LEITURA_MS = 180_000;
/** De quanto em quanto tempo a tela pergunta se a leitura terminou. */
export const PASSO_DA_ESPERA_MS = 5_000;

const ms = (iso: string | null) => (iso === null ? Number.NaN : Date.parse(iso));
const depois = (iso: string | null, ref: string) => ms(iso) >= ms(ref);

export function marcasDe(contas: AdDeliveryAccount[]): Record<string, MarcaDaConta> {
  return Object.fromEntries(contas.map((c) => [c.connected_account_id, { tentativa: c.last_attempt_at, erro: c.last_error }]));
}

/**
 * Onde a leitura pedida está. A conta terminou bem quando a última leitura que deu certo é depois do pedido. Terminou
 * mal quando a tentativa depois do pedido acabou com erro; o worker grava a hora da tentativa no começo e de novo no
 * fim, e só no fim grava o erro: por isso "acabou" é o erro novo, ou a hora da tentativa que mudou depois do pedido
 * (no meio da leitura ela fica parada). A conta que espera Contas conectadas não é lida e não conta.
 */
export function andamentoDaLeitura(
  contas: AdDeliveryAccount[],
  pedidoEm: string,
  antes: Record<string, MarcaDaConta>,
  vistas: Record<string, string | null>,
): { pendentes: number; falharam: Provedor[] } {
  let pendentes = 0;
  const falharam = new Set<Provedor>();
  for (const c of contas) {
    if (precisaDeContas(c) || depois(c.last_success_at, pedidoEm)) continue;
    const marca = antes[c.connected_account_id];
    const vista = vistas[c.connected_account_id] ?? null;
    const tentouDepois = depois(c.last_attempt_at, pedidoEm);
    const erroNovo = c.last_error !== null && c.last_error !== (marca?.erro ?? null);
    const acabou = tentouDepois && c.last_error !== null && (erroNovo || (depois(vista, pedidoEm) && vista !== c.last_attempt_at));
    if (acabou && ehProvedor(c.provider)) falharam.add(c.provider);
    else pendentes += 1;
  }
  return { pendentes, falharam: PROVEDORES.filter((p) => falharam.has(p)) };
}

/** Na espera que passou do prazo: quem tentou depois do pedido e ficou com erro conta como falha. */
export function falharamNoPrazo(contas: AdDeliveryAccount[], pedidoEm: string): Provedor[] {
  const f = new Set<Provedor>();
  for (const c of contas) {
    if (precisaDeContas(c) || depois(c.last_success_at, pedidoEm) || !ehProvedor(c.provider)) continue;
    if (depois(c.last_attempt_at, pedidoEm) && c.last_error !== null) f.add(c.provider);
  }
  return PROVEDORES.filter((p) => f.has(p));
}

/**
 * O fim da espera do "Ler agora", a cada consulta (nulo = seguir esperando). A falha de uma tentativa NÃO encerra a
 * espera antes do prazo: o worker tenta de novo sozinho, e a leitura que dá certo dentro do prazo vale (ERR-146: em
 * 20/10/2026 a Meta devolveu "Job Failed" no relatório da primeira leitura da conta nova, o worker leu certo 80
 * segundos depois, e a tela já tinha dito que a Meta não respondeu). No fim do prazo, a falha que ficou é anunciada.
 */
export function fimDaEspera(
  contas: AdDeliveryAccount[],
  leitura: Extract<LerAgora, { tipo: 'lendo' }>,
  venceu: boolean,
): Extract<LerAgora, { tipo: 'terminou' | 'demorou' }> | null {
  const a = andamentoDaLeitura(contas, leitura.pedidoEm, leitura.antes, leitura.vistas);
  if (a.pendentes === 0 && !a.falharam.length) return { tipo: 'terminou', pedidoEm: leitura.pedidoEm, falharam: [], anterior: leitura.anterior };
  if (!venceu) return null;
  const f = falharamNoPrazo(contas, leitura.pedidoEm);
  return f.length ? { tipo: 'terminou', pedidoEm: leitura.pedidoEm, falharam: f, anterior: leitura.anterior } : { tipo: 'demorou', pedidoEm: leitura.pedidoEm };
}

/** O aviso (toast) do fim do "Ler agora". */
export function avisoDoFim(leitura: LerAgora, contas: AdDeliveryAccount[], fuso: string): string | null {
  const provedores = PROVEDORES.filter((p) => contas.some((c) => c.provider === p));
  if (leitura.tipo === 'demorou') return 'A leitura ainda não terminou. Abra a tela de novo em alguns minutos.';
  if (leitura.tipo !== 'terminou') return null;
  if (leitura.falharam.length) {
    const f = leitura.falharam;
    const dele = f.length > 1 ? 'deles' : f[0] === 'meta_ads' ? 'dela' : 'dele';
    return `${quemAbre(f)} não ${f.length > 1 ? 'responderam' : 'respondeu'} agora: os números ${dele} são os da leitura anterior.`;
  }
  const em = ultimaLeitura(contas.filter((c) => !precisaDeContas(c)));
  return `Números lidos agora ${juntar(provedores.map((p) => NOME[p].da))}${em ? `, às ${horaNoFuso(new Date(em), fuso)}` : ''}.`;
}

// ------------------------------------------------------------------ horas

/** "hoje às 06:12", "ontem às 23:10" ou "em 28/09 às 06:12", no fuso da loja. */
export function quandoLido(iso: string, fuso: string, agora: Date): string {
  const instante = new Date(iso);
  const dia = dataNoFuso(instante, fuso);
  const hoje = dataNoFuso(agora, fuso);
  const hora = horaNoFuso(instante, fuso);
  if (dia === hoje) return `hoje às ${hora}`;
  if (dia === somarDias(hoje, -1)) return `ontem às ${hora}`;
  return `em ${diaMes(dia)}${dia.slice(0, 4) === hoje.slice(0, 4) ? '' : `/${dia.slice(0, 4)}`} às ${hora}`;
}

/** A leitura que vale para a plataforma: a mais antiga das contas dela (os números estão completos até ela). Nula se alguma nunca foi lida. */
function lidaEm(contas: AdDeliveryAccount[]): string | null {
  let mais: string | null = null;
  for (const c of contas) {
    if (c.last_success_at === null) return null;
    if (mais === null || ms(c.last_success_at) < ms(mais)) mais = c.last_success_at;
  }
  return mais;
}

/** A mais recente das leituras (o fim do "Ler agora"). */
function ultimaLeitura(contas: AdDeliveryAccount[]): string | null {
  let mais: string | null = null;
  for (const c of contas) if (c.last_success_at !== null && (mais === null || ms(c.last_success_at) > ms(mais))) mais = c.last_success_at;
  return mais;
}

// ------------------------------------------------------------------ números

const b = (t: string) => ({ t, b: true as const });
const t = (x: string) => ({ t: x });

/** "2,7%" abaixo de 10% (a taxa de clique costuma ficar entre 0,5% e 5%); "12%" a partir daí. Contas exatas, sem ponto flutuante. */
export function taxa(parte: bigint, total: bigint): string {
  if (total <= 0n) return '—';
  const decimos = (parte * 2000n + total) / (total * 2n);
  if (decimos < 100n) return `${decimos / 10n},${decimos % 10n}%`;
  return `${(decimos + 5n) / 10n}%`;
}

/** Um número com uma casa ("1,8"): impressões por pessoa. */
export function umaCasa(parte: bigint, total: bigint): string {
  if (total <= 0n) return '—';
  const decimos = (parte * 20n + total) / (total * 2n);
  return `${inteiro(decimos / 10n)},${decimos % 10n}`;
}

/** Dinheiro dividido por uma contagem (custo por clique, por mil impressões), arredondado ao micro. */
function porCada(micros: bigint, n: bigint): string {
  if (n <= 0n) return '—';
  return reaisDeMicros((micros * 2n + n) / (n * 2n));
}

/** "36", "2,5" (o Google divide a conversão entre campanhas). */
export function valorDoResultado(v: string): string {
  const [i = '0', f = ''] = v.split('.');
  let fim = f.length;
  while (fim > 0 && f[fim - 1] === '0') fim -= 1;
  const fracao = f.slice(0, fim);
  return fracao ? `${inteiro(BigInt(i))},${fracao}` : inteiro(BigInt(i));
}

const RESULTADOS: Record<string, [string, string]> = {
  purchases: ['compra', 'compras'],
  conversations: ['conversa iniciada', 'conversas iniciadas'],
  conversions: ['conversão', 'conversões'],
};

/** O resultado da campanha como a plataforma conta ("36 compras"); sem ele, o traço. */
export function resultadoDe(c: AdDeliveryCampaign): { valor: string; rotulo: string } {
  if (!c.result) return { valor: '—', rotulo: 'resultado (a plataforma não informou)' };
  const [um, varios] = RESULTADOS[c.result.kind] ?? ['resultado', 'resultados'];
  return { valor: valorDoResultado(c.result.value), rotulo: c.result.value === '1' ? um : varios };
}

/** O tipo da campanha em palavras, pelo objetivo da Meta ou pelo canal do Google Ads; desconhecido, nada. */
const TIPOS: Record<string, string> = {
  OUTCOME_TRAFFIC: 'tráfego',
  OUTCOME_SALES: 'vendas',
  OUTCOME_ENGAGEMENT: 'engajamento',
  OUTCOME_LEADS: 'cadastros',
  OUTCOME_AWARENESS: 'reconhecimento',
  OUTCOME_APP_PROMOTION: 'aplicativo',
  MESSAGES: 'mensagens',
  SEARCH: 'rede de pesquisa',
  PERFORMANCE_MAX: 'Performance Max',
  DISPLAY: 'rede de display',
  VIDEO: 'vídeo',
  DEMAND_GEN: 'geração de demanda',
  LOCAL: 'local',
  SMART: 'inteligente',
};
export function tipoDaCampanha(objetivo: string | null): string | null {
  return objetivo ? (TIPOS[objetivo] ?? null) : null;
}

// ------------------------------------------------------------------ o cartão

export type BotaoDaLeitura =
  | { tipo: 'ler'; rotulo: 'Ler agora' | 'Tentar de novo' | 'Lendo…'; desligado: boolean; ocupado: boolean }
  | { tipo: 'contas' }
  | { tipo: 'nenhum' };

export type LinhaDaLeitura = { frase: Frase; falha: boolean; botao: BotaoDaLeitura };

/** `novo` = o número mudou na leitura pedida agora (P23, parte B: a etiqueta "atualizado agora"). */
export type Caixa = { valor: string; rotulo: string; nota: string | null; novo?: true };

/** Um número antes e depois da leitura pedida ("Gastos nas plataformas: R$ 691,15 → R$ 692,43"). */
export type MudancaDoNumero = { rotulo: string; antes: string; depois: string };

/** O que a leitura pedida mudou (P23, parte B), comparando os números da tela no pedido com os de agora. */
export type OQueMudou =
  | { tipo: 'mudou'; antes: string; linhas: MudancaDoNumero[]; nota: string }
  | { tipo: 'igual'; frase: string }
  | { tipo: 'entrou'; frase: string };

export type CampanhaDoCartao = {
  id: string;
  nome: string;
  plataforma: string;
  /** "Meta Ads · tráfego" (Pro). */
  plataformaETipo: string;
  /** Largura da barra do modo simples, de 0 a 100 (impressões contra a campanha que mais apareceu). */
  barra: number;
  rotuloDaBarra: string;
  /** "38.947 vezes · 1.036 cliques (2,7%) · R$ 412,50". */
  resumo: Frase;
  /** As nove caixas do Pro, sempre na mesma ordem. */
  caixas: Caixa[];
};

export type CartaoDosAnuncios =
  | { tipo: 'desligado' }
  | { tipo: 'sem-plataforma'; texto: string; contas: boolean }
  | {
      tipo: 'numeros';
      leitura: LinhaDaLeitura;
      notas: string[];
      /** Nulo quando não há o que somar (hoje, antes da leitura): `vazio` diz por quê. */
      caixas: Caixa[] | null;
      vazio: string | null;
      campanhas: CampanhaDoCartao[];
      notaDoPro: string;
      /** Depois da leitura pedida: o que ela mudou; nulo antes, ou com outro período na tela. */
      mudou: OQueMudou | null;
      /** As plataformas com números no cartão, para "Comparar com a plataforma". */
      comparar: Provedor[];
    };

export type EntradaDoCartao = {
  resposta: AdDeliveryResponse;
  periodo: Periodo;
  fuso: string;
  agora: Date;
  leitura: LerAgora;
  podeVerContas: boolean;
};

function juntar(partes: string[]): string {
  if (partes.length <= 1) return partes[0] ?? '';
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

/** "A Meta e o Google": só o primeiro nome abre a frase com maiúscula. */
function quemAbre(provedores: Provedor[]): string {
  return juntar(provedores.map((p, i) => (i === 0 ? NOME[p].A : NOME[p].a)));
}

/** "da Meta hoje às 06:12 e do Google às 06:14": o dia não se repete quando é o mesmo. */
function horasDasLeituras(lidas: [Provedor, string][], fuso: string, agora: Date): Frase {
  const frase: Frase = [];
  let diaAnterior: string | null = null;
  lidas.forEach(([p, iso], i) => {
    if (i > 0) frase.push(t(i === lidas.length - 1 ? ' e ' : ', '));
    const quando = quandoLido(iso, fuso, agora);
    const dia = dataNoFuso(new Date(iso), fuso);
    const hora = horaNoFuso(new Date(iso), fuso);
    const prefixo = dia === diaAnterior ? 'às ' : quando.slice(0, quando.length - hora.length);
    frase.push(t(`${NOME[p].da} ${prefixo}`), b(hora));
    diaAnterior = dia;
  });
  return frase;
}

function linhaDaLeitura(e: EntradaDoCartao, porProvedor: Map<Provedor, AdDeliveryAccount[]>): LinhaDaLeitura {
  const { resposta: r, fuso, agora, leitura } = e;
  const provedores = PROVEDORES.filter((p) => porProvedor.has(p));
  const da = juntar(provedores.map((p) => NOME[p].da));
  const proximaEm = r.refresh.next_at;
  const liberado = proximaEm === null || ms(proximaEm) <= agora.getTime();
  const horaDaProxima = proximaEm ? horaNoFuso(new Date(proximaEm), fuso) : null;
  const ler = (rotulo: 'Ler agora' | 'Tentar de novo'): BotaoDaLeitura => ({ tipo: 'ler', rotulo, desligado: !liberado, ocupado: false });

  // A plataforma que espera Contas conectadas vem primeiro: ler de novo não resolve.
  const presas = provedores.filter((p) => porProvedor.get(p)!.some(precisaDeContas));
  if (presas.length) {
    const frase: Frase = [];
    presas.forEach((p, i) => {
      const contas = porProvedor.get(p)!;
      const recusou = contas.some((c) => c.status === 'desconectada');
      const espaco = i > 0 ? ' ' : '';
      frase.push(b(`${espaco}${recusou ? `${NOME[p].A} recusou a autorização do Liame.` : `Falta a permissão de leitura ${NOME[p].na}.`}`));
      const ultima = lidaEm(contas.filter((c) => c.last_success_at !== null));
      frase.push(t(ultima ? ` Os números ${NOME[p].da} abaixo são os da última leitura, ${quandoLido(ultima, fuso, agora)}.` : ` Os números ${NOME[p].da} ainda não foram lidos.`));
      if (e.podeVerContas) frase.push(t(recusou ? ` Conecte ${NOME[p].a} de novo para voltar a ler.` : ' Confira a permissão da conta em Contas conectadas.'));
      else frase.push(t(recusou ? ` Peça a quem cuida das contas para conectar ${NOME[p].a} de novo.` : ' Peça a quem cuida das contas para conferir a permissão da conta.'));
    });
    return { frase, falha: true, botao: e.podeVerContas ? { tipo: 'contas' } : { tipo: 'nenhum' } };
  }

  if (leitura.tipo === 'pedindo' || leitura.tipo === 'lendo') {
    return { frase: [t(`Lendo ${da} agora…`)], falha: false, botao: { tipo: 'ler', rotulo: 'Lendo…', desligado: true, ocupado: true } };
  }

  const lidas = provedores.flatMap((p): [Provedor, string][] => {
    const em = lidaEm(porProvedor.get(p)!);
    return em ? [[p, em]] : [];
  });
  const nuncaLidas = provedores.filter((p) => !lidas.some(([q]) => q === p));
  const proxima = !liberado && horaDaProxima ? ` Dá para ler de novo às ${horaDaProxima}.` : '';

  if (leitura.tipo === 'terminou' && leitura.falharam.length) {
    const falharam = leitura.falharam.filter((p) => porProvedor.has(p));
    const boas = provedores.filter((p) => !falharam.includes(p));
    const horaDoPedido = horaNoFuso(new Date(leitura.pedidoEm), fuso);
    const frase: Frase = [b(`${quemAbre(falharam)} não ${falharam.length > 1 ? 'responderam' : 'respondeu'} agora (às ${horaDoPedido}).`)];
    const antigas = lidas.filter(([p]) => falharam.includes(p));
    if (antigas.length) {
      const deQuem = boas.length ? ` ${NOME[falharam[0]!].da}` : '';
      frase.push(t(falharam.length === 1 ? ` Os números${deQuem} abaixo são os da leitura de ` : ' Os números abaixo são os das últimas leituras: '));
      const horas = falharam.length === 1 ? [{ t: quandoLido(antigas[0]![1], fuso, agora) }] : horasDasLeituras(antigas, fuso, agora);
      frase.push(...horas);
    } else {
      frase.push(t(` Os números ${juntar(falharam.map((p) => NOME[p].da))} ainda não foram lidos`));
    }
    const novas = boas.flatMap((p): string[] => {
      const em = ultimaLeitura(porProvedor.get(p)!);
      return em ? [`os ${NOME[p].da} foram lidos às ${horaNoFuso(new Date(em), fuso)}`] : [];
    });
    frase.push(t(novas.length ? `; ${juntar(novas)}.` : '.'));
    if (!liberado && horaDaProxima) frase.push(t(` Dá para tentar de novo às ${horaDaProxima}.`));
    return { frase, falha: true, botao: ler('Tentar de novo') };
  }

  if (leitura.tipo === 'terminou' && !liberado) {
    const em = ultimaLeitura(provedores.flatMap((p) => porProvedor.get(p)!));
    const hora = em ? horaNoFuso(new Date(em), fuso) : horaNoFuso(new Date(leitura.pedidoEm), fuso);
    return { frase: [b(`Lido ${da} agora, às ${hora}.`), t(proxima)], falha: false, botao: ler('Ler agora') };
  }

  if (leitura.tipo === 'demorou') {
    const frase: Frase = [t(`A leitura pedida às ${horaNoFuso(new Date(leitura.pedidoEm), fuso)} ainda não terminou.`)];
    if (lidas.length) frase.push(t(' Os números abaixo são os da leitura anterior: '), ...horasDasLeituras(lidas, fuso, agora), t('.'));
    frase.push(t(` Abra a tela de novo em alguns minutos.${proxima}`));
    return { frase, falha: false, botao: ler('Ler agora') };
  }

  const frase: Frase = [];
  if (lidas.length) frase.push(t('Lido '), ...horasDasLeituras(lidas, fuso, agora), t('.'));
  if (nuncaLidas.length) {
    frase.push(t(`${lidas.length ? ' ' : ''}A primeira leitura ${juntar(nuncaLidas.map((p) => NOME[p].da))} ainda não terminou.`));
  }
  frase.push(t(` A leitura de todo dia traz o dia anterior.${proxima}`));
  return { frase, falha: false, botao: ler('Ler agora') };
}

function caixasDoPro(c: AdDeliveryCampaign): Caixa[] {
  const imp = BigInt(c.impressions);
  const cli = BigInt(c.clicks);
  const gasto = BigInt(c.spend_micros);
  const alcance = c.reach === null ? null : BigInt(c.reach);
  const res = resultadoDe(c);
  const semAlcance = c.provider === 'google_ads' ? 'alcance (o Google não informa)' : 'alcance (a Meta ainda não informou)';
  return [
    { valor: inteiro(imp), rotulo: 'impressões', nota: null },
    { valor: alcance === null ? '—' : inteiro(alcance), rotulo: alcance === null ? semAlcance : 'pessoas alcançadas', nota: null },
    { valor: alcance === null ? '—' : umaCasa(imp, alcance), rotulo: 'vezes por pessoa', nota: null },
    { valor: inteiro(cli), rotulo: cli === 1n ? 'clique' : 'cliques', nota: c.link_clicks === null ? null : `${inteiro(BigInt(c.link_clicks))} no link` },
    { valor: taxa(cli, imp), rotulo: 'clicaram (CTR)', nota: null },
    { valor: porCada(gasto, cli), rotulo: 'por clique (CPC)', nota: null },
    { valor: porCada(gasto * 1000n, imp), rotulo: 'por mil impressões (CPM)', nota: null },
    { valor: reaisDeMicros(gasto), rotulo: 'gastos', nota: null },
    { valor: res.valor, rotulo: res.rotulo, nota: null },
  ];
}

function campanhaDoCartao(c: AdDeliveryCampaign, maior: bigint): CampanhaDoCartao {
  const imp = BigInt(c.impressions);
  const cli = BigInt(c.clicks);
  const nome = plataforma(c.provider).nome;
  const tipo = tipoDaCampanha(c.objective);
  const vezes = `${inteiro(imp)} ${imp === 1n ? 'vez' : 'vezes'}`;
  return {
    id: c.campaign_id,
    nome: c.name,
    plataforma: nome,
    plataformaETipo: tipo ? `${nome} · ${tipo}` : nome,
    barra: maior > 0n ? Number((imp * 10_000n) / maior) / 100 : 0,
    rotuloDaBarra: `${c.name}: apareceu ${vezes}`,
    resumo: [b(inteiro(imp)), t(` ${imp === 1n ? 'vez' : 'vezes'} · `), b(inteiro(cli)), t(` ${cli === 1n ? 'clique' : 'cliques'} (${taxa(cli, imp)}) · `), b(reaisDeMicros(c.spend_micros))],
    caixas: caixasDoPro(c),
  };
}

function notaDoPro(temMeta: boolean, provedores: Provedor[]): string {
  const janelas = provedores.map((p) => (p === 'meta_ads' ? 'a Meta, 7 dias depois do clique' : 'o Google, a janela de cada conversão'));
  const resultado = `O resultado é o que cada plataforma conta, na janela dela (${janelas.join('; ')}).`;
  if (!temMeta) return resultado;
  return `O alcance não se soma entre campanhas: a mesma pessoa pode ver mais de uma. O total é o que a Meta informa para a conta no período. ${resultado}`;
}

// ------------------------------------------------------------------ o que mudou (P23, parte B, aprovado em 16/10/2026)

/** Quantas campanhas entram, no máximo, na lista do que mudou (as outras viram uma frase). */
export const CAMPANHAS_NO_QUE_MUDOU = 3;

/** "a leitura de hoje às 06:12 e 06:14": a leitura de antes de cada plataforma, sem repetir o dia. */
function leiturasDeAntes(anterior: AdDeliveryResponse, fuso: string, agora: Date): string | null {
  const partes: string[] = [];
  let diaAnterior: string | null = null;
  for (const p of PROVEDORES) {
    const em = lidaEm(anterior.accounts.filter((c) => c.provider === p && !precisaDeContas(c)));
    if (!em || !anterior.accounts.some((c) => c.provider === p)) continue;
    const dia = dataNoFuso(new Date(em), fuso);
    const parte = dia === diaAnterior ? horaNoFuso(new Date(em), fuso) : quandoLido(em, fuso, agora);
    if (!partes.includes(parte)) partes.push(parte);
    diaAnterior = dia;
  }
  return partes.length ? `a leitura de ${juntar(partes)}` : null;
}

const contagem = (v: string) => inteiro(BigInt(v));
const alcance = (v: string | null) => (v === null ? '—' : contagem(v));

/**
 * O que a leitura pedida mudou, comparando os números da tela no pedido (`anterior`) com os de agora. Nulo com outro
 * período na tela (a pessoa trocou de período no meio da leitura) ou sem número nenhum agora.
 */
export function oQueMudou(anterior: AdDeliveryResponse, atual: AdDeliveryResponse, hoje: boolean, fuso: string, agora: Date): OQueMudou | null {
  if (anterior.period.from !== atual.period.from || anterior.period.to !== atual.period.to || !atual.campaigns.length) return null;
  const t = atual.totals;
  const temMeta = atual.campaigns.some((c) => c.provider === 'meta_ads') || atual.accounts.some((c) => c.provider === 'meta_ads');
  if (!anterior.campaigns.length) {
    const ultima = ultimaLeitura(atual.accounts.filter((c) => !precisaDeContas(c)));
    const pessoas = temMeta && t.meta_reach !== null ? `, ${contagem(t.meta_reach)} pessoas alcançadas na Meta` : '';
    const cliques = `${contagem(t.clicks)} ${t.clicks === '1' ? 'clique' : 'cliques'}`;
    const inicio = hoje ? `O dia de hoje${ultima ? ` até ${horaNoFuso(new Date(ultima), fuso)}` : ''}, lido pela primeira vez` : 'Os números do período, lidos pela primeira vez';
    return { tipo: 'entrou', frase: `${inicio}: ${contagem(t.impressions)} vezes que os anúncios apareceram${pessoas}, ${cliques} e ${reaisDeMicros(t.spend_micros)} de gasto.` };
  }

  const a = anterior.totals;
  const linhas: MudancaDoNumero[] = [];
  const mudaram = new Set<Provedor>();
  if (a.impressions !== t.impressions) linhas.push({ rotulo: 'Vezes que os anúncios apareceram', antes: contagem(a.impressions), depois: contagem(t.impressions) });
  if (temMeta && a.meta_reach !== t.meta_reach) {
    linhas.push({ rotulo: 'Pessoas alcançadas na Meta', antes: alcance(a.meta_reach), depois: alcance(t.meta_reach) });
    mudaram.add('meta_ads');
  }
  if (a.clicks !== t.clicks) linhas.push({ rotulo: 'Cliques nos anúncios', antes: contagem(a.clicks), depois: contagem(t.clicks) });
  if (a.spend_micros !== t.spend_micros) linhas.push({ rotulo: 'Gastos nas plataformas', antes: reaisDeMicros(a.spend_micros), depois: reaisDeMicros(t.spend_micros) });

  // Cada campanha que mudou entra com o número que mais pesa (o gasto, depois as vezes, os cliques e o alcance).
  const antesPorId = new Map(anterior.campaigns.map((c) => [c.campaign_id, c]));
  const campanhas: MudancaDoNumero[] = [];
  let algumaComMaisDeUm = false;
  for (const c of atual.campaigns) {
    const x = antesPorId.get(c.campaign_id);
    const diferentes = x ? [x.spend_micros !== c.spend_micros, x.impressions !== c.impressions, x.clicks !== c.clicks, x.reach !== c.reach].filter(Boolean).length : 1;
    if (!diferentes) continue;
    if (ehProvedor(c.provider)) mudaram.add(c.provider);
    if (diferentes > 1) algumaComMaisDeUm = true;
    if (!x) campanhas.push({ rotulo: `${c.name} · gasto`, antes: '—', depois: reaisDeMicros(c.spend_micros) });
    else if (x.spend_micros !== c.spend_micros) campanhas.push({ rotulo: `${c.name} · gasto`, antes: reaisDeMicros(x.spend_micros), depois: reaisDeMicros(c.spend_micros) });
    else if (x.impressions !== c.impressions) campanhas.push({ rotulo: `${c.name} · vezes que apareceu`, antes: contagem(x.impressions), depois: contagem(c.impressions) });
    else if (x.clicks !== c.clicks) campanhas.push({ rotulo: `${c.name} · cliques`, antes: contagem(x.clicks), depois: contagem(c.clicks) });
    else campanhas.push({ rotulo: `${c.name} · pessoas alcançadas`, antes: alcance(x.reach), depois: alcance(c.reach) });
  }

  const antes = leiturasDeAntes(anterior, fuso, agora) ?? 'a leitura anterior';
  if (!linhas.length && !campanhas.length) {
    const conectadas = PROVEDORES.filter((p) => atual.accounts.some((c) => c.provider === p));
    const informa = conectadas.length > 1 ? 'informam' : 'informa';
    return { tipo: 'igual', frase: `${quemAbre(conectadas)} ${informa} o mesmo que na ${antes.replace('a leitura', 'leitura')}.` };
  }
  const mostradas = campanhas.slice(0, CAMPANHAS_NO_QUE_MUDOU);
  const sobra = campanhas.length - mostradas.length;
  const quem = mudaram.size ? quemAbre(PROVEDORES.filter((p) => mudaram.has(p))) : 'As plataformas';
  const revisa = mudaram.size === 1 ? 'revisa' : 'revisam';
  // "Os outros números não mudaram" só quando a lista mostra tudo o que mudou.
  const resto =
    sobra > 0
      ? ` Mais ${sobra} ${sobra === 1 ? 'campanha mudou' : 'campanhas mudaram'}: veja os números de cada campanha.`
      : algumaComMaisDeUm
        ? ''
        : ' Os outros números não mudaram.';
  return { tipo: 'mudou', antes, linhas: [...linhas, ...mostradas], nota: `${quem} ${revisa} os números dos últimos dias.${resto} “Por campanha” já está com os números novos.` };
}

export function montarCartaoDosAnuncios(e: EntradaDoCartao): CartaoDosAnuncios {
  const { resposta: r, periodo, fuso, agora } = e;
  if (!r.enabled) return { tipo: 'desligado' };
  const porProvedor = new Map<Provedor, AdDeliveryAccount[]>();
  for (const c of r.accounts) if (ehProvedor(c.provider)) porProvedor.set(c.provider, [...(porProvedor.get(c.provider) ?? []), c]);
  if (!porProvedor.size) {
    return {
      tipo: 'sem-plataforma',
      texto: e.podeVerContas
        ? 'Nenhuma plataforma de anúncio está conectada. Conecte a Meta ou o Google para ver aqui quantas vezes os anúncios apareceram, os cliques e o gasto.'
        : 'Nenhuma plataforma de anúncio está conectada. Quando a Meta ou o Google estiverem conectados, aqui aparecem quantas vezes os anúncios apareceram, os cliques e o gasto.',
      contas: e.podeVerContas,
    };
  }

  const leitura = linhaDaLeitura(e, porProvedor);
  const campanhas = r.campaigns;
  const provedoresComNumeros = PROVEDORES.filter((p) => porProvedor.has(p) || campanhas.some((c) => c.provider === p));
  const temMeta = provedoresComNumeros.includes('meta_ads');
  const notas: string[] = [];
  const conectados = PROVEDORES.filter((p) => porProvedor.has(p));
  // "Só a Meta" só quando nenhuma campanha da outra plataforma entra na lista (a conta desligada traz o que já leu).
  if (conectados.length === 1 && provedoresComNumeros.length === 1) {
    notas.push(
      conectados[0] === 'meta_ads'
        ? 'O Google Ads não está conectado: aqui entram só as campanhas da Meta.'
        : 'A Meta não está conectada: aqui entram só as campanhas do Google.',
    );
  }

  const hoje = periodo === 'hoje';
  const lendo = e.leitura.tipo === 'pedindo' || e.leitura.tipo === 'lendo';
  const anterior = e.leitura.tipo === 'terminou' ? (e.leitura.anterior ?? null) : null;
  const mudou = anterior ? oQueMudou(anterior, r, hoje, fuso, agora) : null;
  if (!campanhas.length) {
    // A frase diz por que não há número: lendo, ainda não lido, ou lido e nenhum anúncio apareceu.
    const ativas = r.accounts.filter((c) => !precisaDeContas(c));
    let vazio: string;
    if (lendo) vazio = hoje ? 'Lendo os números de hoje até agora…' : 'Lendo os números agora…';
    else if (!ativas.length) vazio = 'Não há números lidos para o período.';
    else if (hoje) {
      const diaDeHoje = dataNoFuso(agora, fuso);
      const lidasHoje = ativas.every((c) => c.last_success_at !== null && dataNoFuso(new Date(c.last_success_at), fuso) === diaDeHoje);
      const ultima = lidasHoje ? lidaEm(ativas) : null;
      vazio = ultima
        ? `Nenhum anúncio apareceu hoje até ${horaNoFuso(new Date(ultima), fuso)} (a última leitura).`
        : 'O dia de hoje ainda não foi lido: a leitura de todo dia traz o dia anterior. “Ler agora” traz os números de hoje até agora.';
    } else if (ativas.some((c) => c.last_success_at === null)) vazio = 'Os números aparecem aqui depois da primeira leitura.';
    else vazio = `Nenhum anúncio apareceu ${periodo === '30' ? 'nos últimos 30 dias' : 'nos últimos 7 dias'}.`;
    return { tipo: 'numeros', leitura, notas, caixas: null, vazio, campanhas: [], notaDoPro: notaDoPro(temMeta, provedoresComNumeros), mudou: null, comparar: [] };
  }

  if (hoje) {
    const ativas = r.accounts.filter((c) => !precisaDeContas(c) && c.last_success_at !== null);
    const ate = lidaEm(ativas);
    if (ate) notas.unshift(`Hoje até ${horaNoFuso(new Date(ate), fuso)}: o dia ainda não terminou.`);
  }

  const imp = BigInt(r.totals.impressions);
  const cli = BigInt(r.totals.clicks);
  const gasto = BigInt(r.totals.spend_micros);
  // Depois da leitura pedida, a caixa cujo número mudou ganha "atualizado agora" (só quando houve o que comparar).
  const antes = mudou?.tipo === 'mudou' && anterior ? anterior.totals : null;
  const novo = (mudouAqui: boolean): { novo?: true } => (antes && mudouAqui ? { novo: true } : {});
  const caixas: Caixa[] = [{ valor: inteiro(imp), rotulo: 'vezes que os anúncios apareceram', nota: 'impressões', ...novo(antes?.impressions !== r.totals.impressions) }];
  if (temMeta) {
    caixas.push(
      r.totals.meta_reach === null
        ? { valor: '—', rotulo: 'pessoas alcançadas na Meta', nota: 'a Meta ainda não informou o alcance deste período' }
        : { valor: inteiro(BigInt(r.totals.meta_reach)), rotulo: 'pessoas alcançadas na Meta', nota: 'cada pessoa conta uma vez no período', ...novo(antes?.meta_reach !== r.totals.meta_reach) },
    );
  }
  caixas.push(
    { valor: inteiro(cli), rotulo: cli === 1n ? 'clique nos anúncios' : 'cliques nos anúncios', nota: imp > 0n ? `${taxa(cli, imp)} de quem viu clicou` : null, ...novo(antes?.clicks !== r.totals.clicks) },
    { valor: reaisDeMicros(gasto), rotulo: 'gastos nas plataformas', nota: cli > 0n ? `${porCada(gasto, cli)} por clique` : null, ...novo(antes?.spend_micros !== r.totals.spend_micros) },
  );
  const maior = campanhas.reduce((m, c) => (BigInt(c.impressions) > m ? BigInt(c.impressions) : m), 0n);
  return {
    tipo: 'numeros',
    leitura,
    notas,
    caixas,
    vazio: null,
    campanhas: campanhas.map((c) => campanhaDoCartao(c, maior)),
    notaDoPro: notaDoPro(temMeta, provedoresComNumeros),
    mudou,
    comparar: provedoresComNumeros,
  };
}

/** A entrada oficial de cada plataforma, para comparar os números (a conta se escolhe lá). */
export const ENDERECO_DA_PLATAFORMA: Record<Provedor, { nome: string; url: string }> = {
  meta_ads: { nome: 'Gerenciador de Anúncios da Meta', url: 'https://adsmanager.facebook.com/' },
  google_ads: { nome: 'Google Ads', url: 'https://ads.google.com/' },
};
