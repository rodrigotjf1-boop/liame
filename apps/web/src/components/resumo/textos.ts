import type { AttentionItem, SourceFreshness, SummaryResponse, TeamResponse } from '@liame/contracts';
import { acaoDoAviso, destinoDoAviso, destinoPedeVendas, gravidadeDe } from '@/components/atencao/textos';
import { inteiro } from '@/lib/formato';
import { diaMes, nomesDe, porcentagem, type Trecho } from '@/components/resultados/textos';

// Regras e frases do Resumo (A3 · P8, aprovado em 03/10/2026): a página inicial do Lite. Os números chegam
// prontos de `GET /v1/summary` (os mesmos de Resultados); a tela só os escreve, com a fonte de cada um. Os cartões
// de análise (os três números, o dinheiro, os pedidos e os canais) são desenhos e estão em `graficos.ts`.

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

// ------------------------------------------------------------------ a comparação com a semana anterior

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

function juntar(itens: string[]): string {
  if (itens.length <= 1) return itens.join('');
  return `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`;
}

// ------------------------------------------------------------------ o veredito

export type Veredito = { frase: Texto; conectarRegem: boolean };

/** "a Combo sexta", "a Combo sexta e a Smash em dobro" (nomes como vieram). */
function campanhas(lista: SummaryResponse['campaigns']['profit']): string {
  return juntar(lista.map((c) => `a ${c.name}`));
}

/**
 * O veredito em frase. Desde 07/10/2026 a tela o desenha (o selo, a barra e as campanhas de cada lado, em
 * `graficos.ts`); a frase aparece quando ainda não há o que desenhar: primeira semana, sem o Regem, sem gasto e sem
 * pedido de anúncio. O veredito é o de Resultados (dito pelo servidor).
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

/**
 * O que a pessoa pode decidir: as ações e os planos (em Aprovações), as peças do Criativo (em Criativos) e a promoção
 * de um funcionário (em Sua equipe).
 */
export interface QuemDecide {
  acoes: boolean;
  planos: boolean;
  pecas: boolean;
  autonomia: boolean;
}

/** A oferta dentro de uma frase: sem o ponto final que ela possa trazer. */
const ofertaNaFrase = (oferta: string): string => oferta.trim().replace(/[.!?…]+$/u, '');

/**
 * Os avisos que pedem alguém (críticos primeiro), com os pedidos de decisão depois dos críticos, como no protótipo:
 * o que espera em Aprovações (as ações e os planos do Estrategista que a pessoa pode decidir), as peças do Criativo
 * que passaram na conferência (decididas em Criativos; A4 · P10) e, à parte, a proposta de um funcionário passar a
 * sugerir (decidida em Sua equipe).
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
  // As peças que dá para aprovar agora (o servidor só as conta para quem acompanha as campanhas). A barrada não pede
  // a decisão de ninguém aqui: ela é citada, e está na tela de Criativos.
  const pecas = decide.pecas ? r.needs_you.approvals.pieces : undefined;
  if (pecas && pecas.ready > 0) {
    const para = pecas.offer ? `Para ${ofertaNaFrase(pecas.offer)}. ` : pecas.offers > 1 ? `Para ${inteiro(pecas.offers)} ofertas. ` : '';
    const barrou = pecas.barred ? ` e barrou ${pecas.barred === 1 ? 'outra' : `outras ${inteiro(pecas.barred)}`}` : '';
    decisoes.push({
      chave: 'pecas',
      gravidade: 'decisao',
      falado: 'Decisão',
      titulo: pecas.ready === 1 ? '1 peça do Criativo espera a sua decisão' : `${inteiro(pecas.ready)} peças do Criativo esperam a sua decisão`,
      sub: [{ t: `${para}O Compliance já conferiu${barrou}. ` }, { t: 'Nada vai para a Meta sem o seu pedido.', b: true }],
      botao: { rotulo: 'Ver', href: '/criativos', primario: false },
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

/**
 * O número ao lado de "Resumo" no menu: os avisos que pedem alguém e, havendo pedido esperando, mais um; havendo
 * peça do Criativo para decidir, mais um (cada um é um item do "Precisa de você").
 */
export function contadorDoResumo(avisos: number | null, aprovacoes: number | null, pecas: number | null = null): number {
  return (avisos ?? 0) + (aprovacoes ? 1 : 0) + (pecas ? 1 : 0);
}

/** ", 3 pontos para você" para quem ouve o menu. */
export function pontosFalados(n: number): string {
  return n === 1 ? ', 1 ponto para você' : `, ${n} pontos para você`;
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
