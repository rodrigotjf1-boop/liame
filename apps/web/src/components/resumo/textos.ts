import type { AttentionItem, SourceFreshness, SummaryResponse, TeamResponse } from '@liame/contracts';
import { acaoDoAviso, destinoDoAviso, destinoPedeVendas, gravidadeDe } from '@/components/atencao/textos';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { diaMes, intervaloEscrito, nomesDe, porcentagem, quandoNoFuso, type Trecho } from '@/components/resultados/textos';

// Regras e frases do Resumo (A3 · P8, aprovado em 03/10/2026): a página inicial do Lite. Os números chegam
// prontos de `GET /v1/summary` (os mesmos de Resultados); a tela só os escreve, com a fonte de cada um.

// ------------------------------------------------------------------ números com fonte

/** Número que leva à fonte dele: `i` é a linha em "De onde vêm os números". */
export type Num = { texto: string; i: number };
export type LinhaDeFonte = { valor: string; fonte: string };

/** Junta as fontes na ordem em que os números aparecem; o mesmo valor com a mesma fonte é uma linha só. */
export class Fontes {
  readonly lista: LinhaDeFonte[] = [];
  n(valor: string, fonte: string): Num {
    const i = this.lista.findIndex((l) => l.valor === valor && l.fonte === fonte);
    if (i >= 0) return { texto: valor, i };
    this.lista.push({ valor, fonte });
    return { texto: valor, i: this.lista.length - 1 };
  }
}

/** Trecho do texto: comum, em negrito ou um número com fonte. */
export type Peca = Trecho | { num: Num };
export type Texto = Peca[];

/** Texto corrido (testes e leitores). */
export function textoCorrido(t: Texto): string {
  return t.map((p) => ('num' in p ? p.num.texto : p.t)).join('');
}

// ------------------------------------------------------------------ cabeçalho

/** "Bom dia", "Boa tarde" ou "Boa noite", pela hora da loja. */
export function saudacao(agora: Date, fuso: string): string {
  const hora = Number(new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', hourCycle: 'h23', timeZone: fuso }).format(agora));
  if (hora >= 5 && hora < 12) return 'Bom dia';
  if (hora >= 12 && hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

/** "Terça, 29 de setembro", no fuso da loja. */
export function hojeEscrito(agora: Date, fuso: string): string {
  const partes = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: fuso }).formatToParts(agora);
  const de = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  const semana = de('weekday').replace(/-feira$/, '');
  return `${semana.charAt(0).toLocaleUpperCase('pt-BR')}${semana.slice(1)}, ${de('day')} de ${de('month')}`;
}

/** O primeiro nome, para a saudação ("Rodrigo de Oliveira" → "Rodrigo"). */
export function primeiroNome(nome: string): string {
  return nome.trim().split(/\s+/)[0] ?? nome;
}

// ------------------------------------------------------------------ o dinheiro (os três números do topo)

const reais0 = (micros: string | bigint) => reaisDeMicros(micros, 0);

/** "+13,1%" entre duas somas (micros), sem ponto flutuante; nulo sem a semana anterior ou com ela em zero. */
export function variacaoEntre(agora: string, antes: string | null): { sobe: boolean; texto: string } | null {
  if (antes === null) return null;
  const a = BigInt(agora);
  const b = BigInt(antes);
  if (b <= 0n) return null;
  const diferenca = a - b;
  const negativa = diferenca < 0n;
  const abs = negativa ? -diferenca : diferenca;
  // Décimos de ponto percentual, metade para cima.
  const decimos = (abs * 1000n + b / 2n) / b;
  return { sobe: !negativa, texto: `${decimos / 10n},${decimos % 10n}%` };
}

export type Stat = {
  id: 'vendas' | 'gasto' | 'sobra';
  rotulo: string;
  /** O valor com a fonte; nulo quando ainda não dá para dizer (o texto vai em `vazio`). */
  valor: Num | null;
  vazio: string | null;
  /** A linha de baixo: a comparação com a semana anterior ou o que falta. */
  sub: { texto: Texto; tom: 'bom' | 'ruim' | 'neutro'; seta: 'sobe' | 'desce' | null } | null;
  foco: boolean;
};

type Contexto = {
  r: SummaryResponse;
  fontes: Fontes;
  /** "22/09 a 28/09" */
  periodo: string;
  agora: Date;
};

function contextoDe(r: SummaryResponse, fontes: Fontes, agora: Date): Contexto {
  return { r, fontes, periodo: intervaloEscrito(r.period.from, r.period.to), agora };
}

const MIDIA = new Set(['meta_ads', 'google_ads']);

/** "Meta Ads e Google Ads · gasto · 22/09 a 28/09 · lido hoje, 06:12 e 06:20" (das fontes de mídia da marca). */
function fonteDoGasto(c: Contexto): string {
  const midia = c.r.sources.filter((s) => MIDIA.has(s.provider));
  const nomes = [...new Set(midia.map((s) => nomesDe(s.provider).nome))];
  const lidas = [...new Set(midia.map((s) => s.last_success_at).filter((x): x is string => x !== null).map((l) => quandoNoFuso(l, c.r.period.timezone, c.agora)))];
  // "lido hoje, 06:12 e 06:20": o "hoje" uma vez só quando as duas leituras são de hoje.
  const deHoje = lidas.length > 1 && lidas.every((l) => l.startsWith('hoje, '));
  const quando = lidas.length ? ` · lido ${deHoje ? `hoje, ${juntar(lidas.map((l) => l.slice(6)))}` : juntar(lidas)}` : '';
  return `${nomes.length ? juntar(nomes) : 'Plataformas de anúncio'} · gasto · ${c.periodo}${quando}`;
}

function juntar(itens: string[]): string {
  if (itens.length <= 1) return itens.join('');
  return `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`;
}

function comparacao(c: Contexto, agora: string, antes: string | null, tomSubida: 'bom' | 'neutro'): Stat['sub'] {
  const v = variacaoEntre(agora, antes);
  if (!v) return { texto: [{ t: 'sem semana anterior para comparar' }], tom: 'neutro', seta: null };
  const fonte = `Liame · comparação com ${intervaloEscrito(c.r.previous.from, c.r.previous.to)} · calculada pelo sistema`;
  const tom = tomSubida === 'neutro' ? 'neutro' : v.sobe ? 'bom' : 'ruim';
  return { texto: [{ num: c.fontes.n(v.texto, fonte) }, { t: ` ${v.sobe ? 'a mais' : 'a menos'} que na semana anterior` }], tom, seta: v.sobe ? 'sobe' : 'desce' };
}

/** Os três números do topo, como no protótipo: vendas que vieram do marketing, gasto e o que sobrou. */
export function statsDo(r: SummaryResponse, fontes: Fontes, agora: Date): Stat[] {
  const c = contextoDe(r, fontes, agora);
  const m = r.money;
  const primeira = r.state === 'primeira_semana';
  const semRegem = r.state === 'sem_regem';
  const ainda = 'Ainda sem 7 dias completos';
  const caixa = `Regem · confirmado no caixa · ${c.periodo}`;

  const vendas: Stat = primeira
    ? { id: 'vendas', rotulo: 'Vendas que vieram do marketing', valor: null, vazio: ainda, sub: null, foco: false }
    : semRegem
      ? {
          id: 'vendas',
          rotulo: 'Vendas que vieram do marketing',
          valor: null,
          vazio: 'Sem o Regem, não dá para saber',
          sub: { texto: [{ t: 'O caixa da loja é que confirma cada venda.' }], tom: 'neutro', seta: null },
          foco: false,
        }
      : {
          id: 'vendas',
          rotulo: 'Vendas que vieram do marketing',
          valor: fontes.n(reais0(m.revenue_micros.now), caixa),
          vazio: null,
          sub: comparacao(c, m.revenue_micros.now, m.revenue_micros.before, 'bom'),
          foco: false,
        };

  const gasto: Stat = primeira
    ? { id: 'gasto', rotulo: 'Gasto com anúncios', valor: null, vazio: ainda, sub: null, foco: false }
    : {
        id: 'gasto',
        rotulo: 'Gasto com anúncios',
        valor: fontes.n(reais0(m.spend_micros.now), fonteDoGasto(c)),
        vazio: null,
        sub: comparacao(c, m.spend_micros.now, m.spend_micros.before, 'neutro'),
        foco: false,
      };

  let sobra: Stat;
  if (primeira || semRegem) {
    sobra = { id: 'sobra', rotulo: 'Sobrou depois de pagar os anúncios', valor: null, vazio: primeira ? ainda : 'Sem o Regem, não dá para saber', sub: null, foco: false };
  } else if (m.left_micros.now === null) {
    // A margem conhecida cobre menos de 80% da receita (no piloto, sem o custo dos produtos): o Liame não diz.
    const cobre = m.margin_coverage_pct;
    sobra = {
      id: 'sobra',
      rotulo: 'Sobrou depois de pagar os anúncios',
      valor: null,
      vazio: 'Ainda não dá para dizer',
      sub: {
        texto:
          cobre === null || m.margin_known_micros === null
            ? [{ t: 'nenhuma venda tem o custo dos produtos no Regem' }]
            : [{ t: 'só ' }, { num: fontes.n(porcentagem(cobre), `Regem · parte da receita com custo cadastrado · ${c.periodo}`) }, { t: ' das vendas têm custo no Regem' }],
        tom: 'neutro',
        seta: null,
      },
      foco: false,
    };
  } else {
    const valor = BigInt(m.left_micros.now);
    const faltou = valor < 0n;
    sobra = {
      id: 'sobra',
      rotulo: faltou ? 'Faltou para pagar os anúncios' : 'Sobrou depois de pagar os anúncios',
      valor: fontes.n(reais0(faltou ? -valor : valor), 'Liame · margem conhecida − investimento · calculado pelo sistema'),
      vazio: null,
      sub: {
        texto: [{ t: 'a margem conhecida cobre ' }, { num: fontes.n(porcentagem(m.margin_coverage_pct), `Regem · parte da receita com custo cadastrado · ${c.periodo}`) }, { t: ' da receita' }],
        tom: 'neutro',
        seta: null,
      },
      foco: !faltou,
    };
  }
  return [vendas, gasto, sobra];
}

// ------------------------------------------------------------------ o veredito

export type Veredito = { frase: Texto; conectarRegem: boolean };

/** "a Combo sexta", "a Combo sexta e a Smash em dobro" (nomes como vieram). */
function campanhas(lista: SummaryResponse['campaigns']['profit']): string {
  return juntar(lista.map((c) => `a ${c.name}`));
}

/**
 * A frase grande debaixo dos números. O veredito é o de Resultados (dito pelo servidor); a tela só o escreve,
 * com as campanhas de cada lado. Sem margem suficiente, diz que ainda não dá para dizer, como em Resultados.
 */
export function vereditoDo(r: SummaryResponse): Veredito {
  const n = (t: string): Trecho => ({ t, b: true });
  if (r.state === 'primeira_semana') {
    return { frase: [n('Os primeiros 7 dias completos ainda não fecharam.'), { t: ' Até lá, a Atenção avisa se alguma conta parar ou se algo sair do normal.' }], conectarRegem: false };
  }
  if (r.state === 'sem_regem') {
    return { frase: [n('Sem o Regem, o Liame vê o gasto, não as vendas.'), { t: ' Conecte o Regem para saber o que cada campanha trouxe no caixa.' }], conectarRegem: true };
  }
  const m = r.money;
  if (BigInt(m.spend_micros.now) === 0n) return { frase: [n('Sem gasto com anúncios nos últimos 7 dias.'), { t: ' Os pedidos da loja aparecem abaixo.' }], conectarRegem: false };
  if (r.orders.marketing === 0) {
    return { frase: [n('Nenhum pedido com prova de anúncio nos últimos 7 dias.'), { t: ' Sem venda ligada a um anúncio, não há margem para descontar do gasto.' }], conectarRegem: false };
  }
  const { profit, loss } = r.campaigns;
  const lucro = profit.length ? ` ${maiuscula(campanhas(profit))} ${profit.length === 1 ? 'dá' : 'dão'} lucro` : '';
  const prejuizo = loss.length ? `${lucro ? '; ' : ' '}${lucro ? campanhas(loss) : maiuscula(campanhas(loss))} ${loss.length === 1 ? 'gastou' : 'gastaram'} mais do que a margem que ${loss.length === 1 ? 'trouxe' : 'trouxeram'}` : '';
  const porCampanha = lucro || prejuizo ? `${lucro}${prejuizo}.` : '';
  switch (m.verdict) {
    case 'lucro':
      return { frase: [n('O marketing deu lucro.'), { t: porCampanha }], conectarRegem: false };
    case 'empata':
      return { frase: [n('O marketing se pagou, mas sobrou pouco.'), { t: porCampanha }], conectarRegem: false };
    case 'prejuizo':
      return { frase: [n('O marketing não se pagou.'), { t: porCampanha }], conectarRegem: false };
    default:
      return {
        frase: [
          n('Ainda não dá para dizer se sobrou.'),
          {
            t:
              m.margin_known_micros === null
                ? ' Nenhuma venda dos anúncios tem o custo dos produtos no Regem; com menos de 80% das vendas com custo, o Liame não diz se deu lucro.'
                : ` Só ${porcentagem(m.margin_coverage_pct)} das vendas têm custo cadastrado no Regem; com menos de 80%, o Liame não diz se deu lucro.`,
          },
        ],
        conectarRegem: false,
      };
  }
}

/** As perguntas prontas debaixo do veredito (protótipo P8), para a LIA: só quando há o que explicar. */
export function perguntasDoVeredito(r: SummaryResponse): string[] {
  if (r.state !== 'ok') return [];
  const m = r.money;
  if (BigInt(m.spend_micros.now) === 0n || r.orders.marketing === 0) return [];
  const porque =
    m.verdict === 'lucro' ? 'Por que deu lucro?' : m.verdict === 'empata' ? 'Por que sobrou pouco?' : m.verdict === 'prejuizo' ? 'Por que o marketing não se pagou?' : 'O que falta para saber se sobrou?';
  return [porque, 'O que eu faço primeiro?'];
}

/** As perguntas prontas do cartão "Pergunte à LIA", conforme o que a semana tem para mostrar. */
export function perguntasDoResumo(r: SummaryResponse): string[] {
  if (r.state === 'primeira_semana') return ['O que o Liame já leu?', 'Quando sai a primeira revisão?'];
  if (r.state === 'sem_regem') return ['Por que preciso do Regem?', 'Vale pausar alguma campanha?'];
  return ['Como foi a semana?', 'Por que tem pedido sem origem?', 'Vale pausar alguma campanha?'];
}

function maiuscula(s: string): string {
  return s ? `${s.charAt(0).toLocaleUpperCase('pt-BR')}${s.slice(1)}` : s;
}

// ------------------------------------------------------------------ precisa de você

export type ItemPrecisa = {
  chave: string;
  gravidade: 'urgente' | 'atencao' | 'decisao';
  /** O que quem ouve a tela escuta antes do título. */
  falado: string;
  titulo: string;
  sub: Texto;
  botao: { rotulo: string; href: string; primario: boolean } | null;
};

/** Para onde leva o "Ver" de cada aviso: a tela onde se resolve, ou a lista de avisos. */
function destinoDe(item: AttentionItem, podeVerVendas: boolean, podeVerContas: boolean): { rotulo: string; href: string } {
  const acao = acaoDoAviso(item.kind);
  if ((acao === 'abrir-contas' || acao === 'reconectar') && podeVerContas) return { rotulo: acao === 'reconectar' ? 'Reconectar' : 'Ver', href: '/contas' };
  const destino = acao && (podeVerVendas || !destinoPedeVendas(acao)) ? destinoDoAviso(acao) : null;
  if (destino) return { rotulo: 'Ver', href: destino.href };
  return { rotulo: 'Ver', href: '/atencao' };
}

/** O que a pessoa pode decidir: as ações e os planos (em Aprovações) e a promoção de um funcionário (em Sua equipe). */
export interface QuemDecide {
  acoes: boolean;
  planos: boolean;
  autonomia: boolean;
}

/**
 * Os avisos que pedem alguém (críticos primeiro), com os pedidos de decisão depois dos críticos, como no protótipo:
 * o que espera em Aprovações (as ações e os planos do Estrategista que a pessoa pode decidir) e, à parte, a proposta
 * de um funcionário passar a sugerir (decidida em Sua equipe).
 */
export function precisaDe(r: SummaryResponse, podeVerVendas: boolean, podeVerContas: boolean, decide: QuemDecide): ItemPrecisa[] {
  const avisos = r.needs_you.items.map((a, i): ItemPrecisa => {
    const g = gravidadeDe(a.severity);
    const destino = destinoDe(a, podeVerVendas, podeVerContas);
    return {
      chave: `${a.kind}-${a.campaign_id ?? a.connected_account_id ?? a.provider ?? i}`,
      gravidade: g === 'critica' ? 'urgente' : 'atencao',
      falado: g === 'critica' ? 'Urgente' : 'Atenção',
      titulo: a.title,
      sub: [{ t: a.detail }],
      botao: { ...destino, primario: false },
    };
  });
  const acoes = decide.acoes ? r.needs_you.approvals.actions : 0;
  const planos = decide.planos ? r.needs_you.approvals.plans : 0;
  const autonomia = decide.autonomia ? r.needs_you.approvals.autonomy : 0;
  const decisoes: ItemPrecisa[] = [];
  if (acoes + planos > 0) {
    const pedidos = acoes + planos;
    // Com os dois tipos, a frase diz quantos de cada; só com planos, diz que são do Estrategista.
    const quais = acoes && planos ? `${acoes === 1 ? '1 ação' : `${inteiro(acoes)} ações`} e ${planos === 1 ? '1 plano do Estrategista' : `${inteiro(planos)} planos do Estrategista`}. ` : planos ? `${planos === 1 ? 'Um plano' : `${inteiro(planos)} planos`} do Estrategista. ` : '';
    decisoes.push({
      chave: 'decisao',
      gravidade: 'decisao',
      falado: 'Decisão',
      titulo: pedidos === 1 ? '1 pedido espera a sua decisão' : `${inteiro(pedidos)} pedidos esperam a sua decisão`,
      sub: [{ t: `${quais}Nada vai ao ar sem você.` }],
      botao: { rotulo: 'Decidir', href: '/aprovacoes', primario: true },
    });
  }
  if (autonomia > 0) {
    decisoes.push({
      chave: 'autonomia',
      gravidade: 'decisao',
      falado: 'Decisão',
      titulo: 'O Gestor de tráfego espera a sua decisão',
      sub: [{ t: `Em sombra, ele mostrou que acerta. Você decide se ele passa a sugerir mudanças (${autonomia === 1 ? '1 proposta' : `${inteiro(autonomia)} propostas`}).` }],
      botao: { rotulo: 'Ver', href: '/equipe', primario: false },
    });
  }
  if (!decisoes.length) return avisos;
  const criticos = avisos.filter((a) => a.gravidade === 'urgente');
  return [...criticos, ...decisoes, ...avisos.filter((a) => a.gravidade !== 'urgente')];
}

/** O número ao lado de "Resumo" no menu: os avisos que pedem alguém e, havendo pedido esperando, mais um. */
export function contadorDoResumo(avisos: number | null, aprovacoes: number | null): number {
  return (avisos ?? 0) + (aprovacoes ? 1 : 0);
}

/** ", 3 pontos para você" para quem ouve o menu. */
export function pontosFalados(n: number): string {
  return n === 1 ? ', 1 ponto para você' : `, ${n} pontos para você`;
}

// ------------------------------------------------------------------ pedidos e canais

export type MiniStat = { rotulo: string; valor: Num };

export function pedidosDo(r: SummaryResponse, fontes: Fontes): MiniStat[] | null {
  if (r.state !== 'ok') return null;
  const periodo = intervaloEscrito(r.period.from, r.period.to);
  const o = r.orders;
  const lista: MiniStat[] = [{ rotulo: 'Pedidos que vieram do marketing', valor: fontes.n(inteiro(o.marketing), `Regem · confirmado no caixa · ${periodo}`) }];
  if (o.average_micros !== null) {
    lista.push({ rotulo: 'Valor médio desses pedidos', valor: fontes.n(reaisDeMicros(o.average_micros), 'Liame · receita ÷ pedidos com origem provada · calculado pelo sistema') });
  }
  lista.push({ rotulo: 'Pedidos de todos os canais', valor: fontes.n(inteiro(o.all_channels), `Regem · pedidos de todos os canais · ${periodo}`) });
  lista.push({ rotulo: 'Sem origem provada', valor: fontes.n(inteiro(o.without_origin), `Regem · pedidos do cardápio e do WhatsApp sem origem provada · ${periodo}`) });
  return lista;
}

export type Canal = {
  provider: string;
  nome: string;
  pedidos: Num;
  /** Parte da barra (0 a 100), entre os pedidos com origem nos anúncios. */
  parte: number;
  falado: string;
  sub: Texto;
};

/** "Instagram e Facebook" (o que o dono reconhece), "Google"; outra plataforma com o nome dela. */
function nomeDoCanal(provider: string): string {
  if (provider === 'meta_ads') return 'Instagram e Facebook';
  if (provider === 'google_ads') return 'Google';
  return nomesDe(provider).nome;
}

export function canaisDo(r: SummaryResponse, fontes: Fontes): { canais: Canal[]; semOrigem: Num } | null {
  if (r.state !== 'ok') return null;
  const periodo = intervaloEscrito(r.period.from, r.period.to);
  const total = r.platforms.reduce((s, p) => s + p.orders, 0);
  const canais = r.platforms.map((p): Canal => {
    const nome = nomeDoCanal(p.provider);
    const plataforma = nomesDe(p.provider).nome;
    let sub: Texto;
    if (p.left_micros === null) sub = [{ t: 'sem margem conhecida bastante para dizer quanto sobrou' }];
    else {
      const v = BigInt(p.left_micros);
      const fonte = `Liame · margem conhecida − investimento em ${plataforma} · calculado pelo sistema`;
      sub = v >= 0n ? [{ t: 'sobraram ' }, { num: fontes.n(reais0(v), fonte) }, { t: ' depois dos anúncios' }] : [{ t: 'faltaram ' }, { num: fontes.n(reais0(-v), fonte) }, { t: ' para pagar os anúncios' }];
    }
    return {
      provider: p.provider,
      nome,
      pedidos: fontes.n(inteiro(p.orders), `Regem · pedidos com origem em ${plataforma} · ${periodo}`),
      parte: total ? Math.round((p.orders / total) * 100) : 0,
      falado: `${inteiro(p.orders)} de ${inteiro(total)} pedidos com origem provada`,
      sub,
    };
  });
  return { canais, semOrigem: fontes.n(inteiro(r.orders.without_origin), `Regem · pedidos do cardápio e do WhatsApp sem origem provada · ${periodo}`) };
}

// ------------------------------------------------------------------ o que a equipe fez

/** `sep`: o que vai entre o nome e o texto ("Gestor de tráfego, em sombra, anotou…"). */
export type LinhaDaEquipe = { chave: string; icone: 'sparkles' | 'chart' | 'file' | 'shield' | 'megaphone' | 'compass' | 'search'; nome: string; sep: ' ' | ', '; texto: string };

const NOMES: Record<string, string> = {
  lia: 'LIA',
  analista: 'Analista de dados',
  relatorios: 'Relatórios',
  compliance: 'Compliance',
  estrategista: 'Estrategista',
  pesquisador: 'Pesquisador',
  trafego: 'Gestor de tráfego',
};
const ICONES: Record<string, LinhaDaEquipe['icone']> = {
  lia: 'sparkles',
  analista: 'chart',
  relatorios: 'file',
  compliance: 'shield',
  estrategista: 'compass',
  pesquisador: 'search',
  trafego: 'megaphone',
};

const vezesDe = (n: bigint, um: string, varios: string) => `${inteiro(n)} ${n === 1n ? um : varios}`;

/**
 * Uma linha por funcionário que trabalhou no mês, contada pelo código (`/v1/team`). Quem está desligado (pela
 * empresa ou pela Liame) ou parado não entra; quem trabalha mas ainda não fez nada aparece com o que faz.
 */
export function equipeDo(t: TeamResponse): LinhaDaEquipe[] {
  const linhas: LinhaDaEquipe[] = [];
  for (const m of t.members) {
    if (m.status !== 'ativo' && m.status !== 'sombra') continue;
    const s = (k: string) => BigInt(m.stats.find((x) => x.key === k)?.value ?? '0');
    let texto: string | null = null;
    switch (m.key) {
      case 'lia':
        texto = s('respostas') > 0n ? `respondeu ${vezesDe(s('respostas'), 'pergunta', 'perguntas')} na conversa, com a fonte de cada número.` : 'responde na conversa, com os números que existem até agora.';
        break;
      case 'analista':
        texto = s('explicacoes') > 0n ? `explicou ${vezesDe(s('explicacoes'), 'número', 'números')} em Resultados e na Atenção.` : 'explica os números de Resultados e da Atenção quando você pede.';
        break;
      case 'relatorios':
        texto = s('revisoes') > 0n ? `fez ${vezesDe(s('revisoes'), 'revisão', 'revisões')} da semana.` : 'faz a revisão da semana toda segunda-feira.';
        break;
      case 'compliance':
        texto = 'confere todo texto feito por IA antes de ele aparecer.';
        break;
      case 'estrategista': {
        const feitos = s('planos_aprovados') + s('planos_recusados') + s('planos_esperando');
        const esperando = s('planos_esperando');
        texto = feitos > 0n ? `montou ${vezesDe(feitos, 'plano', 'planos')}${esperando > 0n ? `: ${esperando === 1n ? '1 espera' : `${inteiro(esperando)} esperam`} você.` : '.'}` : 'monta planos quando você pede, e a pauta de cada segunda-feira.';
        break;
      }
      case 'pesquisador':
        texto = s('paginas_lidas') > 0n ? `leu ${vezesDe(s('paginas_lidas'), 'página', 'páginas')} que você indicou.` : 'lê as páginas que você indicar em Minha marca.';
        break;
      case 'trafego':
        // Na A3 o Gestor de tráfego só trabalha em sombra: anota o que faria e compara, sem mexer em nada.
        texto = m.status === 'sombra' ? `em sombra, anotou ${vezesDe(s('recomendacoes'), 'recomendação', 'recomendações')}, sem mexer em nada.` : null;
        break;
    }
    if (!texto) continue;
    linhas.push({ chave: m.key, icone: ICONES[m.key] ?? 'sparkles', nome: NOMES[m.key] ?? m.key, sep: m.key === 'trafego' ? ', ' : ' ', texto });
  }
  return linhas;
}

// ------------------------------------------------------------------ contexto da página

/** "Os últimos 7 dias: 22/09 a 28/09." para quem ouve a tela e para a linha de baixo do título. */
export function periodoDoResumo(r: SummaryResponse): string {
  return `${diaMes(r.period.from)} a ${diaMes(r.period.to)}`;
}

/** A fonte de mídia ou do caixa está atrasada? (A tela avisa ao lado do período, como em Resultados.) */
export function fontesAtrasadas(sources: SourceFreshness[]): string[] {
  return sources.filter((s) => s.status !== 'ativa' || s.freshness === 'delayed' || s.freshness === 'stale').map((s) => nomesDe(s.provider).nome);
}
