import type { GoogleVisibilityPeriod, GoogleVisibilityQueryRow, GoogleVisibilityResponse } from '@liame/contracts';
import { inteiro } from '@/lib/formato';
import { taxa } from './anuncios';
import type { BarraDividida } from './graficos';
import { type Frase, type Periodo, parte } from './textos';

// "Como te acham no Google" em Resultados (mockups/prototipo-como-te-acham.html, P18, aprovado pelo dono em
// 15/10/2026): o perfil da empresa no Google e o site no Search Console, cada um com a contagem dele (as duas partes
// não se somam), e as buscas que mais trouxeram cliques na última semana fechada. Funções puras: a tela e o teste
// desenham a mesma coisa.

/** As buscas que o modo simples mostra; o resto (até 10) fica em "Ver as N buscas" e no Pro. */
export const BUSCAS_NO_SIMPLES = 5;

const negrito = (t: string) => ({ t, b: true as const });
const plural = (n: bigint, um: string, varios: string) => `${inteiro(n)} ${n === 1n ? um : varios}`;

/** "26/09" a partir de "2026-09-26". */
export function diaCurto(iso: string): string {
  const [, m = '', d = ''] = iso.split('-');
  return `${d}/${m}`;
}

/** A posição média com uma casa ("6,8"), arredondada sem ponto flutuante; "—" sem posição. */
export function posicaoComUmaCasa(p: string | null): string {
  if (p === null) return '—';
  const [i = '0', f = ''] = p.split('.');
  const centesimos = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
  const decimos = (centesimos + 5n) / 10n;
  return `${inteiro(decimos / 10n)},${decimos % 10n}`;
}

export type Variacao = { sentido: 'sobe' | 'cai' | 'igual'; frase: Frase };

/** "164 vezes a mais que nos 7 dias anteriores (2.090)"; nula sem nenhum número lido nos dias de antes. */
export function variacaoDe(agora: bigint, antes: string | null, unidade: [string, string], dias: number): Variacao | null {
  if (antes === null) return null;
  const a = BigInt(antes);
  const periodo = dias === 1 ? 'no dia anterior' : `nos ${dias} dias anteriores`;
  const dif = agora - a;
  if (dif === 0n) return { sentido: 'igual', frase: [{ t: `Igual ${dias === 1 ? 'ao dia anterior' : `aos ${dias} dias anteriores`}.` }] };
  const abs = dif < 0n ? -dif : dif;
  return { sentido: dif > 0n ? 'sobe' : 'cai', frase: [negrito(`${plural(abs, unidade[0], unidade[1])} ${dif > 0n ? 'a mais' : 'a menos'}`), { t: ` que ${periodo} (${inteiro(a)})` }] };
}

export type Acao = { valor: string; rotulo: string };
export type LinhaDosCliques = {
  /** Cada dia: a posição (0 a 100), a altura do ponto (0 a 100, de cima) e a dica. */
  pontos: { x: number; y: number; dica: string }[];
  linha: string;
  area: string;
  /**
   * As datas embaixo da linha. `extra`: as que somem no minigráfico estreito, onde ficam a primeira, a do meio e a última
   * (com as sete no celular, as das pontas se sobrepunham às vizinhas; o protótipo tinha o mesmo desenho).
   */
  marcas: { x: number; texto: string; extra: boolean }[];
  ultimo: { valor: string; quando: string; y: number };
  rotulo: string;
};
export type BuscaNaTela = { busca: string; largura: number; curta: Frase; completa: Frase; rotulo: string };

export type ParteDoGoogle =
  /** A parte da função desligada não aparece (não dá para ligar sem a função: o convite levaria a um beco sem saída). */
  | { tipo: 'fora' }
  | { tipo: 'convite'; texto: string; contas: boolean }
  | { tipo: 'aviso'; destaque: string; texto: string }
  | { tipo: 'perfil'; ate: string | null; total: string; variacao: Variacao | null; barra: BarraDividida; acoes: Acao[] }
  | { tipo: 'site'; ate: string | null; cliques: string; variacao: Variacao | null; sub: Frase; dias: LinhaDosCliques | null };

export type CartaoDoGoogle =
  | { tipo: 'desligado' }
  | {
      tipo: 'ok';
      sub: string;
      perfil: ParteDoGoogle;
      site: ParteDoGoogle;
      buscas: { semana: string; lista: BuscaNaTela[]; poucas: string | null; vazia: boolean } | null;
    };

const CONVITE_DO_PERFIL =
  'O perfil da empresa no Google (o que aparece na busca e no Maps) não está ligado. Ligado, aqui aparecem quantas vezes ele foi visto e o que as pessoas fizeram: rotas, ligações e cliques no site e no cardápio.';
const CONVITE_DO_SITE =
  'O site da empresa no Search Console (a ferramenta do Google que mostra as buscas que levam ao site) não está ligado. Ligado, aqui aparecem os cliques que as buscas trazem ao site e as buscas que mais trazem gente.';

/** "de 21 a 27/09"; "de 29/09 a 05/10" quando a semana vira o mês. */
export function semanaEmPalavras(s: GoogleVisibilityPeriod): string {
  const [de, ate] = [diaCurto(s.from), diaCurto(s.to)];
  return de.slice(3) === ate.slice(3) ? `de ${de.slice(0, 2)} a ${ate}` : `de ${de} a ${ate}`;
}

/** "7 dias até 26/09" (o rótulo de um período lido). */
const rotuloDoPeriodo = (p: GoogleVisibilityPeriod, dias: number) => `${dias} dias até ${diaCurto(p.to)}`;

function partePerfil(r: GoogleVisibilityResponse, podeVerContas: boolean, ateNaParte: boolean): ParteDoGoogle {
  const p = r.profile;
  if (!p.enabled) return { tipo: 'fora' };
  if (!p.accounts.length) {
    if (p.waiting_google) {
      return {
        tipo: 'aviso',
        destaque: 'Esperando o Google.',
        texto: 'O Google ainda não liberou o acesso do Liame ao perfil da empresa. O Liame procura de novo todo dia, e os números aparecem aqui assim que o Google liberar.',
      };
    }
    return { tipo: 'convite', texto: CONVITE_DO_PERFIL, contas: podeVerContas };
  }
  if (!p.period) return { tipo: 'aviso', destaque: 'Primeira leitura.', texto: 'O perfil foi ligado agora: os números dos últimos 90 dias chegam em até um dia.' };
  const busca = BigInt(p.views_search);
  const maps = BigInt(p.views_maps);
  const total = busca + maps;
  const partes = [
    { classe: 'foco' as const, n: busca, rotulo: 'na busca do Google' },
    { classe: 'c1' as const, n: maps, rotulo: 'no Google Maps' },
  ];
  return {
    tipo: 'perfil',
    ate: ateNaParte ? `Nos ${rotuloDoPeriodo(p.period, r.days)}.` : null,
    total: inteiro(total),
    variacao: variacaoDe(total, p.previous_views, ['vez', 'vezes'], r.days),
    barra: {
      partes: partes.map((x) => ({ classe: x.classe, peso: Number(x.n), valor: inteiro(x.n), rotulo: x.rotulo, dica: `${plural(x.n, 'vez', 'vezes')}|${x.rotulo} · ${parte(x.n, total)}` })),
      marca: null,
      rotulo: `O perfil apareceu ${plural(total, 'vez', 'vezes')}: ${inteiro(busca)} na busca do Google e ${inteiro(maps)} no Google Maps.`,
    },
    acoes: [
      { valor: inteiro(BigInt(p.direction_requests)), rotulo: BigInt(p.direction_requests) === 1n ? 'pedido de rota' : 'pedidos de rota' },
      { valor: inteiro(BigInt(p.call_clicks)), rotulo: BigInt(p.call_clicks) === 1n ? 'ligação' : 'ligações' },
      { valor: inteiro(BigInt(p.website_clicks)), rotulo: BigInt(p.website_clicks) === 1n ? 'clique no site' : 'cliques no site' },
      { valor: inteiro(BigInt(p.menu_clicks)), rotulo: BigInt(p.menu_clicks) === 1n ? 'clique no cardápio' : 'cliques no cardápio' },
    ],
  };
}

/** A linha dos cliques por dia: só a linha (aqui não há gasto), um alvo por dia e as datas embaixo. */
export function linhaDosCliques(daily: { day: string; clicks: string }[]): LinhaDosCliques | null {
  if (daily.length < 2) return null;
  const valores = daily.map((d) => Number(d.clicks));
  const max = Math.max(...valores) || 1;
  const ultimo = daily.length - 1;
  const x = (i: number) => (i / ultimo) * 100;
  const y = (v: number) => 100 - (v / max) * 92;
  const pts = valores.map((v, i) => `${x(i).toFixed(2)} ${y(v).toFixed(2)}`);
  const essenciais = [0, Math.floor(ultimo / 2), ultimo];
  const indices = daily.length <= 7 ? daily.map((_, i) => i) : essenciais;
  const melhor = valores.reduce((a, v, i) => (v > valores[a]! ? i : a), 0);
  const cliques = (v: number) => plural(BigInt(v), 'clique', 'cliques');
  return {
    pontos: daily.map((d, i) => ({ x: x(i), y: y(valores[i]!), dica: `${diaCurto(d.day)}|${cliques(valores[i]!)}` })),
    linha: `M${pts.join(' L')}`,
    area: `M0 100 L${pts.join(' L')} L100 100 Z`,
    marcas: indices.map((i) => ({ x: x(i), texto: diaCurto(daily[i]!.day), extra: !essenciais.includes(i) })),
    ultimo: { valor: inteiro(BigInt(valores[ultimo]!)), quando: `em ${diaCurto(daily[ultimo]!.day)}`, y: y(valores[ultimo]!) },
    rotulo: `Cliques vindos das buscas por dia, de ${diaCurto(daily[0]!.day)} a ${diaCurto(daily[ultimo]!.day)}. O dia com mais cliques teve ${cliques(valores[melhor]!)}; o último, ${cliques(valores[ultimo]!)}.`,
  };
}

function parteSite(r: GoogleVisibilityResponse, podeVerContas: boolean, ateNaParte: boolean): ParteDoGoogle {
  const s = r.site;
  if (!s.enabled) return { tipo: 'fora' };
  if (!s.accounts.length) return { tipo: 'convite', texto: CONVITE_DO_SITE, contas: podeVerContas };
  if (!s.period) {
    return { tipo: 'aviso', destaque: 'Primeira leitura.', texto: 'O site foi ligado agora: os cliques dos últimos 90 dias e as buscas das últimas 12 semanas chegam em até um dia.' };
  }
  const cliques = BigInt(s.clicks);
  const vezes = BigInt(s.impressions);
  const sub: Frase = vezes > 0n
    ? [{ t: 'O site apareceu ' }, negrito(inteiro(vezes)), { t: ` ${vezes === 1n ? 'vez' : 'vezes'} nas buscas, em média na posição ` }, negrito(posicaoComUmaCasa(s.position)), { t: ' (1 é o primeiro lugar).' }]
    : [{ t: 'O site não apareceu nas buscas nestes dias.' }];
  return {
    tipo: 'site',
    ate: ateNaParte ? `Nos ${rotuloDoPeriodo(s.period, r.days)}.` : null,
    cliques: inteiro(cliques),
    variacao: variacaoDe(cliques, s.previous_clicks, ['clique', 'cliques'], r.days),
    sub,
    dias: linhaDosCliques(s.daily),
  };
}

/** Uma busca da lista: a barra na régua da busca com mais cliques, o texto curto (simples) e o completo (Pro). */
export function buscaNaTela(b: GoogleVisibilityQueryRow, maximo: bigint): BuscaNaTela {
  const cliques = BigInt(b.clicks);
  const vezes = BigInt(b.impressions);
  const curta: Frase = [negrito(inteiro(cliques)), { t: ` ${cliques === 1n ? 'clique' : 'cliques'} · apareceu ${plural(vezes, 'vez', 'vezes')}` }];
  const completa: Frase = [...curta, { t: ` · ${taxa(cliques, vezes)} clicaram · posição ${posicaoComUmaCasa(b.position)}` }];
  return {
    busca: b.query,
    largura: maximo > 0n ? Number((cliques * 10_000n) / maximo) / 100 : 0,
    curta,
    completa,
    rotulo: `“${b.query}”: ${plural(cliques, 'clique', 'cliques')}`,
  };
}

/**
 * O cartão a partir da resposta da rota. `periodo` = o da tela: em "Hoje" a tela pede 7 dias e o cartão diz que o dia
 * de hoje ainda não chegou. Cada parte acaba no último dia que o Google informou dela; quando o perfil e o site acabam em
 * dias diferentes, a data vai em cada parte, e o subtítulo não diz um dia só.
 */
export function montarCartaoDoGoogle(r: GoogleVisibilityResponse, periodo: Periodo, podeVerContas: boolean): CartaoDoGoogle {
  if (!r.enabled) return { tipo: 'desligado' };
  const fins = [r.profile.enabled ? r.profile.period : null, r.site.enabled ? r.site.period : null].filter((p): p is GoogleVisibilityPeriod => p !== null);
  const umFim = fins.length > 0 && fins.every((p) => p.to === fins[0]!.to);
  const ateNaParte = fins.length > 1 && !umFim;
  const quando = umFim ? rotuloDoPeriodo(fins[0]!, r.days) : `últimos ${r.days} dias que ele já informou`;
  const sub =
    periodo === 'hoje'
      ? `O Google entrega os números com 2 a 3 dias de atraso: hoje ainda não chegou. Abaixo, os ${quando}.`
      : `Os números que o Google informa, nos ${quando}: ele entrega com 2 a 3 dias de atraso.`;

  const q = r.site.enabled && r.site.accounts.length ? r.site.queries : null;
  let buscas: Extract<CartaoDoGoogle, { tipo: 'ok' }>['buscas'] = null;
  if (q) {
    const maximo = q.items.reduce((m, b) => (BigInt(b.clicks) > m ? BigInt(b.clicks) : m), 0n);
    const lista = q.items.map((b) => buscaNaTela(b, maximo));
    buscas = {
      semana: semanaEmPalavras(q.week),
      lista,
      poucas: lista.length > 0 && lista.length < BUSCAS_NO_SIMPLES ? `Só ${lista.length === 1 ? '1 busca trouxe' : `${lista.length} buscas trouxeram`} cliques nesta semana.` : null,
      vazia: lista.length === 0,
    };
  }
  return { tipo: 'ok', sub, perfil: partePerfil(r, podeVerContas, ateNaParte), site: parteSite(r, podeVerContas, ateNaParte), buscas };
}
