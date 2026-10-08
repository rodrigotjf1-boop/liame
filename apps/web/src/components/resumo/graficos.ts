import type { SummaryResponse } from '@liame/contracts';
import type { ParteDaBarra, SeloDoPeriodo } from '@/components/resultados/graficos';
import { decimosDe, type Frase, intervaloEscrito, nomesDe, parte, porcentagem, quandoNoFuso, type Trecho } from '@/components/resultados/textos';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { type Fontes, type Num, type Texto, variacaoEntre, type Veredito, vereditoDo } from './textos';

// Os desenhos do Resumo (mockups/prototipo-resumo-graficos.html, aprovado pelo dono em 07/10/2026; caminho B, "uma
// pergunta, um desenho", já no ar em Resultados). Mudam só os cartões de análise: os três números do topo ganham uma
// barra (esta semana) com a marca da semana anterior; a frase do veredito vira "Para onde foi cada real vendido"; os
// pedidos viram uma barra só; e cada canal de anúncio mostra o que sobrou ou faltou. A conta é do servidor
// (`GET /v1/summary`): aqui só se escolhe o que desenhar e em que tamanho, com inteiros (micros), e todo valor escrito
// continua levando à fonte dele. Funções puras.

const reais = (micros: string | bigint) => reaisDeMicros(micros);
const reais0 = (micros: string | bigint) => reaisDeMicros(micros, 0);
const n = (t: string): Trecho => ({ t, b: true });
const juntar = (itens: string[]) => (itens.length <= 1 ? (itens[0] ?? '') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
/** Micros em centavos, como número: só para o tamanho relativo das barras. */
const centavos = (micros: bigint): number => Number(micros / 10_000n);
const absoluto = (v: bigint): bigint => (v < 0n ? -v : v);
/** A dica do desenho ("título|complemento"): reforça o valor, que também fica escrito ao lado. */
const dica = (titulo: string, sub = ''): string => (sub ? `${titulo}|${sub}` : titulo);
const MIDIA = new Set(['meta_ads', 'google_ads']);

// ------------------------------------------------------------------ a barra contra a semana anterior

/** Posições na régua do número (0 a 100): de onde a barra sai, o tamanho dela, o zero (só quando há valor negativo) e a marca. */
export type GeometriaDaBala = { de: number; largura: number; negativa: boolean; zero: number | null; marca: number | null };

/**
 * A barra é esta semana; a marca, a semana anterior. As duas ficam na mesma régua, que começa no zero; quando algum
 * dos dois valores é negativo (faltou dinheiro), a régua se estende para a esquerda do zero.
 */
export function balaDe(agora: bigint, antes: bigint | null): GeometriaDaBala {
  const outro = antes ?? 0n;
  const menor = [0n, agora, outro].reduce((a, b) => (b < a ? b : a));
  const maior = [0n, agora, outro].reduce((a, b) => (b > a ? b : a));
  const vao = maior - menor;
  const posicao = (v: bigint) => (vao === 0n ? 0 : Number(((v - menor) * 10_000n) / vao) / 100);
  const [zero, ponta] = [posicao(0n), posicao(agora)];
  return { de: Math.min(zero, ponta), largura: Math.abs(ponta - zero), negativa: agora < 0n, zero: menor < 0n ? zero : null, marca: antes === null ? null : posicao(antes) };
}

export type BalaDoNumero = GeometriaDaBala & {
  /** A cor da coisa: o que voltou e o que sobrou no foco; o gasto no cinza 1; o que ficou sem prova, no cinza 2. Barra negativa leva o vermelho de estado. */
  cor: 'foco' | 'c1' | 'c2';
  /** O que quem ouve a tela escuta no lugar do desenho. */
  rotulo: string;
  dicaAgora: string;
  dicaAntes: string | null;
};

export type Stat = {
  id: 'vendas' | 'gasto' | 'sobra';
  rotulo: string;
  /** O valor com a fonte; nulo quando ainda não dá para dizer (o texto vai em `vazio`, com a `nota` embaixo). */
  valor: Num | null;
  vazio: string | null;
  nota: Texto | null;
  bala: BalaDoNumero | null;
  /** Quanto mudou contra a semana anterior ("17,5% a mais"); nulo sem a semana anterior ou com ela em zero. */
  mudou: { texto: Texto; tom: 'bom' | 'ruim' | 'neutro'; seta: 'sobe' | 'desce' | null } | null;
  /** O valor da semana anterior, ao lado da marca ("semana anterior: R$ 3.068"); nulo quando não há com o que comparar. */
  anterior: Texto | null;
  foco: boolean;
};



/** "Meta Ads e Google Ads · gasto · 22/09 a 28/09 · lido hoje, 06:12 e 06:20" (das fontes de mídia da marca). */
function fonteDoGasto(r: SummaryResponse, periodo: string, agora: Date | null): string {
  const midia = r.sources.filter((s) => MIDIA.has(s.provider));
  const nomes = [...new Set(midia.map((s) => nomesDe(s.provider).nome))];
  const base = `${nomes.length ? juntar(nomes) : 'Plataformas de anúncio'} · gasto · ${periodo}`;
  if (!agora) return base;
  const lidas = [...new Set(midia.map((s) => s.last_success_at).filter((x): x is string => x !== null).map((l) => quandoNoFuso(l, r.period.timezone, agora)))];
  // "lido hoje, 06:12 e 06:20": o "hoje" uma vez só quando as duas leituras são de hoje.
  const deHoje = lidas.length > 1 && lidas.every((l) => l.startsWith('hoje, '));
  return `${base}${lidas.length ? ` · lido ${deHoje ? `hoje, ${juntar(lidas.map((l) => l.slice(6)))}` : juntar(lidas)}` : ''}`;
}

/** Reais inteiros com sinal, arredondados como a tela escreve: a diferença entre dois números escritos bate com eles. */
function emReais(micros: bigint): bigint {
  const r = (absoluto(micros) + 500_000n) / 1_000_000n;
  return micros < 0n ? -r : r;
}

/** Os três números do topo: vendas que vieram do marketing, gasto e o que sobrou, cada um contra a semana anterior. */
export function statsDo(r: SummaryResponse, fontes: Fontes, agora: Date): Stat[] {
  const m = r.money;
  const periodo = intervaloEscrito(r.period.from, r.period.to);
  const antes = intervaloEscrito(r.previous.from, r.previous.to);
  const primeira = r.state === 'primeira_semana';
  const semRegem = r.state === 'sem_regem';
  const AINDA = 'Ainda sem 7 dias completos';
  const fonteDaVariacao = `Liame · comparação com ${antes} · calculada pelo sistema`;
  const vazio = (id: Stat['id'], rotulo: string, texto: string, nota: Texto | null = null): Stat => ({ id, rotulo, valor: null, vazio: texto, nota, bala: null, mudou: null, anterior: null, foco: false });
  const IGUAL: Stat['mudou'] = { texto: [{ t: 'igual à semana anterior' }], tom: 'neutro', seta: null };

  /** Vendas e gasto: o valor, a barra contra a semana anterior e quanto mudou, em porcentagem. */
  const comparado = (id: 'vendas' | 'gasto', rotulo: string, par: { now: string; before: string | null }, fonte: string, fonteAntes: string, oQue: string): Stat => {
    const [agoraV, antesV] = [BigInt(par.now), par.before === null ? null : BigInt(par.before)];
    const subirEBom = id === 'vendas';
    // A ordem das linhas em "De onde vêm os números" é a da tela: o valor, quanto mudou e o valor de antes.
    const valor = fontes.n(reais0(agoraV), fonte);
    let mudou: Stat['mudou'] = null;
    if (antesV !== null && antesV === agoraV) mudou = IGUAL;
    else {
      const v = variacaoEntre(par.now, par.before);
      if (v) mudou = { texto: [{ num: fontes.n(v.texto, fonteDaVariacao) }, { t: v.sobe ? ' a mais' : ' a menos' }], tom: subirEBom ? (v.sobe ? 'bom' : 'ruim') : 'neutro', seta: v.sobe ? 'sobe' : 'desce' };
    }
    return {
      id,
      rotulo,
      valor,
      vazio: null,
      nota: null,
      bala: {
        ...balaDe(agoraV, antesV),
        cor: id === 'vendas' ? 'foco' : 'c1',
        rotulo: antesV === null ? `Esta semana, ${reais(agoraV)} ${oQue}.` : `Esta semana, ${reais(agoraV)} ${oQue}; na semana anterior, ${reais(antesV)}.`,
        dicaAgora: dica(reais(agoraV), `esta semana · ${periodo}`),
        dicaAntes: antesV === null ? null : dica(reais(antesV), `semana anterior · ${antes}`),
      },
      mudou,
      anterior: antesV === null ? null : [{ t: 'semana anterior: ' }, { num: fontes.n(reais0(antesV), fonteAntes) }],
      foco: false,
    };
  };

  if (primeira) {
    return [vazio('vendas', 'Vendas que vieram do marketing', AINDA), vazio('gasto', 'Gasto com anúncios', AINDA), vazio('sobra', 'Sobrou depois de pagar os anúncios', AINDA)];
  }
  const vendas = semRegem
    ? vazio('vendas', 'Vendas que vieram do marketing', 'Sem o Regem, não dá para saber', [{ t: 'O caixa da loja é que confirma cada venda.' }])
    : comparado('vendas', 'Vendas que vieram do marketing', m.revenue_micros, `Regem · confirmado no caixa · ${periodo}`, `Regem · confirmado no caixa · ${antes}`, 'em vendas que vieram do marketing');
  const gasto = comparado('gasto', 'Gasto com anúncios', m.spend_micros, fonteDoGasto(r, periodo, agora), fonteDoGasto(r, antes, null), 'em anúncios');

  const SOBROU = 'Sobrou depois de pagar os anúncios';
  let sobra: Stat;
  if (semRegem) sobra = vazio('sobra', SOBROU, 'Sem o Regem, não dá para saber');
  else if (m.left_micros.now === null) {
    // Sem pedido dos anúncios não há margem para descontar; com a margem conhecida abaixo de 80% da receita, o Liame não diz.
    const cobre = m.margin_coverage_pct;
    const nota: Texto =
      r.orders.marketing === 0
        ? [{ t: 'nenhuma venda veio dos anúncios' }]
        : cobre === null || m.margin_known_micros === null
          ? [{ t: 'nenhuma venda tem o custo dos produtos no Regem' }]
          : [{ t: 'só ' }, { num: fontes.n(porcentagem(cobre), `Regem · parte da receita com custo cadastrado · ${periodo}`) }, { t: ' das vendas têm custo no Regem' }];
    sobra = vazio('sobra', SOBROU, 'Ainda não dá para dizer', nota);
  } else {
    const agoraV = BigInt(m.left_micros.now);
    const antesV = m.left_micros.before === null ? null : BigInt(m.left_micros.before);
    const faltou = agoraV < 0n;
    const dizer = (v: bigint) => (v < 0n ? `faltaram ${reais(-v)}` : `sobraram ${reais(v)}`);
    const valor = fontes.n(reais0(absoluto(agoraV)), 'Liame · margem conhecida − investimento · calculado pelo sistema');
    // O que sobrou muda em reais: porcentagem de base pequena (ou com troca de sinal) engana.
    let mudou: Stat['mudou'] = null;
    if (antesV !== null) {
      const d = emReais(agoraV) - emReais(antesV);
      mudou = d === 0n ? IGUAL : { texto: [{ num: fontes.n(reais0(absoluto(d) * 1_000_000n), fonteDaVariacao) }, { t: d > 0n ? ' a mais' : ' a menos' }], tom: d > 0n ? 'bom' : 'ruim', seta: d > 0n ? 'sobe' : 'desce' };
    }
    sobra = {
      id: 'sobra',
      rotulo: faltou ? 'Faltou para pagar os anúncios' : SOBROU,
      valor,
      vazio: null,
      nota: null,
      bala: {
        ...balaDe(agoraV, antesV),
        cor: 'foco',
        rotulo: antesV === null ? `Esta semana, ${dizer(agoraV)}.` : `Esta semana, ${dizer(agoraV)}; na semana anterior, ${dizer(antesV)}.`,
        dicaAgora: dica(reais(absoluto(agoraV)), `${faltou ? 'faltaram' : 'sobraram'} esta semana · ${periodo}`),
        dicaAntes: antesV === null ? null : dica(reais(absoluto(antesV)), `${antesV < 0n ? 'faltaram' : 'sobraram'} na semana anterior · ${antes}`),
      },
      mudou,
      anterior:
        antesV === null
          ? null
          : [{ t: antesV < 0n ? 'semana anterior: faltaram ' : 'semana anterior: ' }, { num: fontes.n(reais0(absoluto(antesV)), `Liame · margem conhecida − investimento · ${antes} · calculado pelo sistema`) }],
      foco: !faltou,
    };
  }
  return [vendas, gasto, sobra];
}

// ------------------------------------------------------------------ para onde foi cada real vendido

/** Uma parte da barra com o valor que leva à fonte (o `valor` em texto é o da dica e do leitor de tela). */
export type ParteComFonte = ParteDaBarra & { num: Num };

export type DinheiroDoResumo =
  /** Ainda não há o que desenhar: a frase diz por quê (a mesma do veredito de antes). */
  | { tipo: 'vago'; veredito: Veredito }
  | {
      tipo: 'barra';
      /** "55 pedidos com prova de anúncio · 22/09 a 28/09". */
      sub: Texto;
      selo: SeloDoPeriodo | null;
      partes: ParteComFonte[];
      /** Quando faltou: onde termina o que foi vendido (a barra continua com o que faltou). */
      marca: { posicao: number; antes: number; texto: string } | null;
      rotulo: string;
      /** Só com a margem incompleta: por que ainda não dá para dizer. */
      frase: Frase | null;
      /** As campanhas de cada lado do veredito (até 3 cada, o maior gasto primeiro), como o servidor manda. */
      lados: { lucro: string[]; prejuizo: string[] };
    };

const SELO_DA_SEMANA: Record<string, SeloDoPeriodo> = {
  lucro: { rotulo: 'Deu lucro', classe: 'bom' },
  empata: { rotulo: 'Empatou', classe: 'atencao' },
  prejuizo: { rotulo: 'Deu prejuízo', classe: 'ruim' },
};

/** O veredito desenhado: o selo da semana, a barra "para onde foi cada real vendido" e as campanhas de cada lado. */
export function dinheiroDo(r: SummaryResponse, fontes: Fontes): DinheiroDoResumo {
  const m = r.money;
  const gasto = BigInt(m.spend_micros.now);
  if (r.state !== 'ok' || gasto <= 0n || r.orders.marketing === 0) return { tipo: 'vago', veredito: vereditoDo(r) };
  const periodo = intervaloEscrito(r.period.from, r.period.to);
  const receita = BigInt(m.revenue_micros.now);
  const pedidos = r.orders.marketing;
  const sub: Texto = [{ num: fontes.n(inteiro(pedidos), `Regem · confirmado no caixa · ${periodo}`) }, { t: ` ${pedidos === 1 ? 'pedido' : 'pedidos'} com prova de anúncio · ${periodo}` }];
  // A receita com margem conhecida vem da rota; resposta de antes de 07/10/2026 não a traz: cai na porcentagem.
  const comCusto =
    m.revenue_with_margin_micros !== undefined ? BigInt(m.revenue_with_margin_micros) : m.margin_coverage_pct === null ? 0n : (receita * BigInt(decimosDe(m.margin_coverage_pct))) / 1000n;
  const semCusto = receita > comCusto ? receita - comCusto : 0n;
  const daReceita = (v: bigint) => parte(v, receita);
  const fonteSemCusto = `Regem · vendas de itens sem custo cadastrado · ${periodo}`;
  const lados = { lucro: r.campaigns.profit.map((c) => c.name), prejuizo: r.campaigns.loss.map((c) => c.name) };

  if (m.left_micros.now === null || m.margin_known_micros === null) {
    const cobertura = m.margin_coverage_pct === null ? '0%' : porcentagem(m.margin_coverage_pct);
    const partes: ParteComFonte[] = [
      {
        classe: 'foco',
        peso: centavos(comCusto),
        valor: cobertura,
        num: fontes.n(cobertura, `Regem · parte da receita com custo cadastrado · ${periodo}`),
        rotulo: 'das vendas com custo no Regem',
        dica: dica(reais(comCusto), `em vendas com custo no Regem (${cobertura})`),
      },
      { classe: 'semcusto', peso: centavos(semCusto), valor: reais0(semCusto), num: fontes.n(reais0(semCusto), fonteSemCusto), rotulo: 'em itens sem custo', dica: dica(reais(semCusto), 'em vendas de itens sem custo') },
    ];
    return {
      tipo: 'barra',
      sub,
      selo: { rotulo: 'Margem incompleta', classe: 'incompleta' },
      partes: partes.filter((p) => p.peso > 0),
      marca: { posicao: 0.8, antes: 0, texto: 'precisa de 80%' },
      rotulo: `${cobertura} das vendas têm custo cadastrado no Regem. A partir de 80%, o Liame diz para onde foi cada real.`,
      frase: [n('Ainda não dá para dizer se sobrou.'), { t: ' Falta o custo de alguns itens no Regem.' }],
      lados: { lucro: [], prejuizo: [] },
    };
  }

  const margem = BigInt(m.margin_known_micros);
  const sobra = BigInt(m.left_micros.now);
  const custo = comCusto > margem ? comCusto - margem : 0n;
  const falta = sobra < 0n ? -sobra : 0n;
  const coberto = gasto < margem ? gasto : margem > 0n ? margem : 0n;
  const fonteDaSobra = 'Liame · margem conhecida − investimento · calculado pelo sistema';
  const partes: ParteComFonte[] = [
    {
      classe: 'c2',
      peso: centavos(custo),
      valor: reais0(custo),
      num: fontes.n(reais0(custo), `Regem · custo dos produtos vendidos · ${periodo}`),
      rotulo: 'custo dos produtos',
      dica: dica(reais(custo), `custo dos produtos · ${daReceita(custo)} do que foi vendido`),
    },
    {
      classe: 'semcusto',
      peso: centavos(semCusto),
      valor: reais0(semCusto),
      num: fontes.n(reais0(semCusto), fonteSemCusto),
      rotulo: 'em itens sem custo no Regem',
      dica: dica(reais(semCusto), `em itens sem custo no Regem · ${daReceita(semCusto)} do que foi vendido`),
    },
    // A barra dos anúncios vai até onde a margem cobre; o valor escrito é o gasto inteiro.
    { classe: 'c1', peso: centavos(coberto), valor: reais0(gasto), num: fontes.n(reais0(gasto), fonteDoGasto(r, periodo, null)), rotulo: 'anúncios', dica: dica(reais(gasto), `anúncios · ${daReceita(gasto)} do que foi vendido`) },
    sobra >= 0n
      ? { classe: 'foco', peso: centavos(sobra), valor: reais0(sobra), num: fontes.n(reais0(sobra), fonteDaSobra), rotulo: 'sobrou', dica: dica(reais(sobra), `sobrou · ${daReceita(sobra)} do que foi vendido`) }
      : { classe: 'falta', peso: centavos(falta), valor: reais0(falta), num: fontes.n(reais0(falta), fonteDaSobra), rotulo: 'faltou', dica: dica(reais(falta), 'faltou para pagar os anúncios') },
  ];
  const visiveis = partes.filter((p) => p.peso > 0);
  const lido = visiveis.map((p) =>
    p.rotulo === 'sobrou' ? `${p.valor} que sobraram` : p.rotulo === 'faltou' ? `${p.valor} que faltaram para pagar os anúncios` : p.rotulo.startsWith('em ') ? `${p.valor} ${p.rotulo}` : `${p.valor} de ${p.rotulo}`,
  );
  const total = receita + falta;
  return {
    tipo: 'barra',
    sub,
    selo: m.verdict ? (SELO_DA_SEMANA[m.verdict] ?? null) : null,
    partes: visiveis,
    marca: falta > 0n && total > 0n ? { posicao: Number((receita * 100_000n) / total) / 100_000, antes: visiveis.length - 1, texto: `vendido: ${reais0(receita)}` } : null,
    rotulo: `Dos ${reais(receita)} vendidos: ${juntar(lido)}.`,
    frase: null,
    lados,
  };
}

// ------------------------------------------------------------------ de onde vieram os pedidos

export type PedidosDoResumo = {
  /** Todos os pedidos confirmados da semana, de todos os canais. */
  total: Num;
  partes: ParteComFonte[];
  rotulo: string;
  /** Quanto valeu, em média, cada pedido que veio dos anúncios; nulo sem pedido. */
  medio: Num | null;
};

/** Os pedidos da semana numa barra só: de anúncios com prova, de aplicativos e balcão, e sem prova de anúncio. */
export function pedidosDo(r: SummaryResponse, fontes: Fontes): PedidosDoResumo | null {
  if (r.state !== 'ok') return null;
  const periodo = intervaloEscrito(r.period.from, r.period.to);
  const o = r.orders;
  const total = fontes.n(inteiro(o.all_channels), `Regem · pedidos de todos os canais · ${periodo}`);
  // Os pedidos de balcão e de aplicativo que entraram numa campanha por cupom já contam em "anúncios".
  const outros = Math.max(0, o.all_channels - o.marketing - o.without_origin);
  const linha = (classe: ParteDaBarra['classe'], quantos: number, rotulo: string, fonte: string): ParteComFonte => ({
    classe,
    peso: quantos,
    valor: inteiro(quantos),
    num: fontes.n(inteiro(quantos), fonte),
    rotulo,
    dica: dica(`${inteiro(quantos)} ${quantos === 1 ? 'pedido' : 'pedidos'}`, `${rotulo} · ${parte(quantos, o.all_channels)}`),
  });
  const partes = [
    ...(o.marketing > 0 ? [linha('foco', o.marketing, 'de anúncios, com prova', `Regem · confirmado no caixa · ${periodo}`)] : []),
    ...(outros > 0 ? [linha('c1', outros, 'de aplicativos de entrega e balcão', `Regem · pedidos de aplicativos de entrega e balcão · ${periodo}`)] : []),
    ...(o.without_origin > 0 ? [linha('c2', o.without_origin, 'do cardápio e do WhatsApp, sem prova de anúncio', `Regem · pedidos do cardápio e do WhatsApp sem origem provada · ${periodo}`)] : []),
  ];
  return {
    total,
    partes,
    rotulo: `Dos ${inteiro(o.all_channels)} pedidos da semana: ${juntar(partes.map((p) => `${p.valor} ${p.rotulo}`))}.`,
    medio: o.average_micros === null ? null : fontes.n(reais(o.average_micros), 'Liame · receita ÷ pedidos com origem provada · calculado pelo sistema'),
  };
}

// ------------------------------------------------------------------ cada canal de anúncio

export type LinhaDoCanal = {
  provider: string;
  nome: string;
  pedidos: Num;
  umPedido: boolean;
  /** `ganho` (sobrou, para a direita), `perda` (faltou, para a esquerda), `neutro` (sem pedido) ou `semcusto` (margem incompleta). */
  tipo: 'ganho' | 'perda' | 'neutro' | 'semcusto';
  /** Tamanho da barra, em porcentagem da régua (só em `ganho` e `perda`). */
  largura: number;
  /** O valor com o sinal ("+", "−") e a fonte; nulo quando o que vai escrito é `texto`. */
  valor: { sinal: '+' | '−'; num: Num } | null;
  texto: string | null;
  rotulo: string;
  dica: string;
};

export type CanaisDoResumo =
  | { tipo: 'vazio'; frase: string }
  | {
      tipo: 'lista';
      /** Onde fica o zero da régua (0 a 100): o mesmo para todas as linhas. */
      zero: number;
      linhas: LinhaDoCanal[];
      legenda: { faltou: boolean; sobrou: boolean };
    };

/** "Instagram e Facebook" (o que o dono reconhece), "Google"; outra plataforma com o nome dela. */
export function nomeDoCanal(provider: string): string {
  if (provider === 'meta_ads') return 'Instagram e Facebook';
  if (provider === 'google_ads') return 'Google';
  return nomesDe(provider).nome;
}

/** Cada canal de anúncio na mesma régua: sobrou (para a direita) ou faltou (para a esquerda), depois de pagar o anúncio. */
export function canaisDo(r: SummaryResponse, fontes: Fontes): CanaisDoResumo | null {
  if (r.state !== 'ok') return null;
  if (!r.platforms.length) {
    // Conta de anúncio conectada, mas nada gasto nem vendido por ela na semana, não é o mesmo que não ter conta.
    return { tipo: 'vazio', frase: r.sources.some((s) => MIDIA.has(s.provider)) ? 'Nenhum anúncio gastou nos últimos 7 dias.' : 'Nenhuma conta de anúncio conectada a esta marca.' };
  }
  const periodo = intervaloEscrito(r.period.from, r.period.to);
  const medidos = r.platforms.filter((p) => p.orders > 0 && p.left_micros !== null).map((p) => BigInt(p.left_micros!));
  const pos = medidos.reduce((a, v) => (v > a ? v : a), 0n);
  const neg = medidos.reduce((a, v) => (-v > a ? -v : a), 0n);
  let zero = pos + neg > 0n ? Number((neg * 10_000n) / (pos + neg)) / 100 : 0;
  if (neg > 0n) zero = Math.max(zero, 20);
  if (pos > 0n) zero = Math.min(zero, 60);
  else if (neg > 0n) zero = 60;
  // Micros por ponto percentual: a mesma régua dos dois lados do zero.
  const regua = Math.max(Number(pos) / (100 - zero), neg > 0n ? Number(neg) / zero : 0) || 1;
  const linhas = r.platforms.map((p): LinhaDoCanal => {
    const nome = nomeDoCanal(p.provider);
    const plataforma = nomesDe(p.provider).nome;
    const pedidos = fontes.n(inteiro(p.orders), `Regem · pedidos com origem em ${plataforma} · ${periodo}`);
    const comum = { provider: p.provider, nome, pedidos, umPedido: p.orders === 1 };
    const gastou = p.spend_micros === undefined ? null : BigInt(p.spend_micros);
    if (p.orders === 0) {
      const texto = gastou === null ? 'sem pedido na semana' : `gastou ${reais0(gastou)}`;
      return { ...comum, tipo: 'neutro', largura: 0, valor: null, texto, rotulo: `${nome}: sem pedido na semana${gastou === null ? '' : `; gastou ${reais(gastou)}`}`, dica: dica('Sem pedido na semana', gastou === null ? '' : `gastou ${reais(gastou)}`) };
    }
    if (p.left_micros === null) {
      return {
        ...comum,
        tipo: 'semcusto',
        largura: 0,
        valor: null,
        texto: 'margem incompleta',
        rotulo: `${nome}: sem margem conhecida bastante para dizer quanto sobrou`,
        dica: dica('Margem incompleta', 'com menos de 80% das vendas com custo, o Liame não diz se sobrou'),
      };
    }
    const sobra = BigInt(p.left_micros);
    const ganho = sobra >= 0n;
    const quanto = absoluto(sobra);
    const detalhe = `${inteiro(p.orders)} ${p.orders === 1 ? 'pedido' : 'pedidos'}${gastou === null ? '' : ` · gastou ${reais(gastou)}`}`;
    return {
      ...comum,
      tipo: ganho ? 'ganho' : 'perda',
      largura: Math.round((Number(quanto) / regua) * 100) / 100,
      valor: { sinal: ganho ? '+' : '−', num: fontes.n(reais0(quanto), `Liame · margem conhecida − investimento em ${plataforma} · calculado pelo sistema`) },
      texto: null,
      rotulo: `${nome}: ${ganho ? 'sobraram' : 'faltaram'} ${reais(quanto)} depois de pagar o anúncio`,
      dica: dica(`${ganho ? 'Sobraram' : 'Faltaram'} ${reais(quanto)}`, detalhe),
    };
  });
  return { tipo: 'lista', zero, linhas, legenda: { faltou: neg > 0n, sobrou: pos > 0n } };
}
