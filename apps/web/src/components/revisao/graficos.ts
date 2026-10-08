import type { WeeklyReview, WeeklyReviewCampaign, WeeklyReviewChange } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import type { SeloDoPeriodo } from '@/components/resultados/graficos';
import { centesimosDe, diaMes, nomesDe } from '@/components/resultados/textos';
import { type BalaDoNumero, balaDe } from '@/components/resumo/graficos';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import { mudancaDe, razao, valorDe, variacao, vereditoDaSemana } from './textos';

// Os desenhos da "Revisão da semana" (mockups/prototipo-revisao-graficos.html, aprovado pelo dono em 07/10/2026;
// caminho B, "uma pergunta, um desenho", já no ar em Resultados e no Resumo). Mudam os números do topo, "O que cada
// campanha trouxe no caixa" e as listas do que mudou; a leitura da semana e "Precisa de decisão" ficam como estão. A
// revisão vem pronta da API, como foi gerada na segunda-feira: aqui nada é calculado além do tamanho das barras, com
// inteiros. Funções puras.

/** A dica do desenho ("título|complemento"): reforça o valor, que também fica escrito ao lado. */
const dica = (titulo: string, sub = ''): string => (sub ? `${titulo}|${sub}` : titulo);

/** O valor de um número da revisão como inteiro, para o tamanho da barra: micros, contagem ou centésimos da razão. */
function grandeza(m: WeeklyReviewChange, qual: 'before' | 'now'): bigint | null {
  const v = m[qual];
  if (v === null) return null;
  return m.unit === 'razao' ? centesimosDe(v) : BigInt(v);
}

/** A cor da coisa: o gasto com anúncios é o cinza 1; o que ficou sem prova, o cinza 2; o que voltou, o foco. */
function corDe(kind: string): BalaDoNumero['cor'] {
  if (kind === 'investimento') return 'c1';
  if (kind === 'pedidos_sem_origem') return 'c2';
  return 'foco';
}

/** A barra desta semana com a marca da semana anterior; nula quando o número desta semana não existe. */
function balaDaMudanca(m: WeeklyReviewChange, nome: string, semanas: { agora: string; antes: string }): BalaDoNumero | null {
  const agora = grandeza(m, 'now');
  if (agora === null) return null;
  const antes = grandeza(m, 'before');
  const [de, para] = [valorDe(m, 'before'), valorDe(m, 'now')];
  return {
    ...balaDe(agora, antes),
    cor: corDe(m.kind),
    rotulo: antes === null ? `${nome}: ${para} nesta semana.` : `${nome}: ${para} nesta semana; ${de} na semana anterior.`,
    dicaAgora: dica(para, `esta semana · ${semanas.agora}`),
    dicaAntes: antes === null ? null : dica(de, `semana anterior · ${semanas.antes}`),
  };
}

// ------------------------------------------------------------------ os quatro números do topo

export type NumeroDaRevisao = {
  id: string;
  rotulo: string;
  valor: string;
  bala: BalaDoNumero | null;
  /** Quanto mudou ("12,8% a mais", "subiu"); nulo sem a semana anterior ou sem a variação. */
  mudou: { texto: string; tom: 'bom' | 'ruim' | 'neutro'; seta: 'sobe' | 'desce' | null } | null;
  /** O valor da semana anterior, ao lado da marca; nulo quando não há com o que comparar. */
  anterior: string | null;
};

const ROTULO_DO_TOPO: Record<string, string> = {
  investimento: 'Investido em anúncios',
  pedidos_de_anuncios: 'Pedidos de anúncios',
  receita_confirmada: 'Receita confirmada no caixa',
  roas_confirmado: 'ROAS confirmado no caixa',
};

/** Quanto o número mudou sobre a semana anterior. Gastar mais não é bom nem ruim: a seta fica, a cor é neutra. */
function mudouDe(m: WeeklyReviewChange): NumeroDaRevisao['mudou'] {
  const [antes, agora] = [grandeza(m, 'before'), grandeza(m, 'now')];
  if (antes === null || agora === null) return null;
  if (antes === agora) return { texto: 'igual à semana anterior', tom: 'neutro', seta: null };
  const sobe = agora > antes;
  const tom = m.kind === 'investimento' ? 'neutro' : sobe ? 'bom' : 'ruim';
  // No ROAS a revisão não manda a porcentagem (o protótipo mostra só os dois valores): diz se subiu ou caiu.
  const v = m.unit === 'razao' ? null : variacao(m.change_pct);
  const texto = v ? `${v.replace(/^[+-]/, '')} ${sobe ? 'a mais' : 'a menos'}` : sobe ? 'subiu' : 'caiu';
  return { texto, tom, seta: sobe ? 'sobe' : 'desce' };
}

const semanasDe = (r: Pick<WeeklyReview, 'week' | 'previous_week'>) => ({ agora: `${diaMes(r.week.from)} a ${diaMes(r.week.to)}`, antes: `${diaMes(r.previous_week.from)} a ${diaMes(r.previous_week.to)}` });

/** Os números do topo, na ordem em que a API manda (investimento, pedidos, receita e ROAS), cada um contra a semana anterior. */
export function numerosDaRevisao(r: Pick<WeeklyReview, 'totals' | 'week' | 'previous_week'>): NumeroDaRevisao[] {
  const semanas = semanasDe(r);
  return r.totals.map((m) => {
    const rotulo = ROTULO_DO_TOPO[m.kind] ?? m.kind.replaceAll('_', ' ');
    return { id: m.kind, rotulo, valor: valorDe(m, 'now'), bala: balaDaMudanca(m, rotulo, semanas), mudou: mudouDe(m), anterior: m.before === null ? null : valorDe(m, 'before') };
  });
}

// ------------------------------------------------------------------ o que cada campanha trouxe no caixa

export type CampanhaDaRevisao = {
  id: string;
  nome: string;
  /** "Meta Ads · 26 pedidos" / "Meta Ads · sem pedido na semana". */
  sub: string;
  investido: { valor: string; largura: number; dica: string };
  /** O que o caixa confirmou; largura zero quando não houve pedido (a barra não aparece). */
  caixa: { valor: string; largura: number; dica: string };
  selo: SeloDoPeriodo | null;
  rotulo: string;
};

export type CampanhasDaRevisao = {
  linhas: CampanhaDaRevisao[];
  /** Os pedidos provados só na plataforma, sem a campanha: contam no total. */
  notas: string[];
};

const largura = (v: bigint, maior: bigint): number => (maior <= 0n ? 0 : Number((v * 10_000n) / maior) / 100);
const pedidosEscritos = (n: number) => `${inteiro(n)} ${n === 1 ? 'pedido' : 'pedidos'}`;

/** O selo de uma campanha: o veredito da semana; sem pedido, "Sem pedido" (o que o protótipo mostra no lugar do veredito). */
function seloDaCampanha(c: WeeklyReviewCampaign): SeloDoPeriodo | null {
  if (c.orders === 0) return { rotulo: 'Sem pedido', classe: 'neutro' };
  return vereditoDaSemana(c.verdict, c.orders, c.spend_micros);
}

/** Cada campanha com o que foi investido e o que voltou no caixa, na mesma régua para todas (a do e-mail da revisão). */
export function campanhasDaRevisao(r: Pick<WeeklyReview, 'campaigns' | 'platform_only'>): CampanhasDaRevisao {
  const maior = r.campaigns.reduce((m, c) => [BigInt(c.spend_micros), BigInt(c.revenue_micros)].reduce((a, v) => (v > a ? v : a), m), 0n);
  const linhas = r.campaigns.map((c): CampanhaDaRevisao => {
    const [gasto, receita] = [BigInt(c.spend_micros), BigInt(c.revenue_micros)];
    const [investido, noCaixa] = [reaisDeMicros(gasto), reaisDeMicros(receita)];
    return {
      id: c.campaign_id,
      nome: c.name,
      sub: `${plataforma(c.provider).nome} · ${c.orders === 0 ? 'sem pedido na semana' : pedidosEscritos(c.orders)}`,
      investido: { valor: investido, largura: largura(gasto, maior), dica: dica(investido, 'investido na semana') },
      caixa: { valor: noCaixa, largura: largura(receita, maior), dica: dica(noCaixa, c.roas === null ? 'confirmado no caixa' : `confirmado no caixa · ROAS ${razao(c.roas)}`) },
      selo: seloDaCampanha(c),
      rotulo: c.orders === 0 ? `${c.name}: ${investido} investidos e nenhum pedido confirmado no caixa.` : `${c.name}: ${investido} investidos e ${noCaixa} no caixa, em ${pedidosEscritos(c.orders)}.`,
    };
  });
  const notas = r.platform_only
    .filter((p) => p.orders > 0)
    .map((p) => {
      const de = nomesDe(p.provider).de;
      const valor = p.revenue_micros === null ? '' : ` (${reaisDeMicros(p.revenue_micros)})`;
      return p.orders === 1 ? `Mais 1 pedido${valor} veio ${de} sem dizer a campanha: conta no total.` : `Mais ${inteiro(p.orders)} pedidos${valor} vieram ${de} sem dizer a campanha: contam no total.`;
    });
  return { linhas, notas };
}

// ------------------------------------------------------------------ o que melhorou e o que piorou

export type MudancaDesenhada = {
  chave: string;
  /** "Pedidos de anúncios", "Combo sexta: ROAS no caixa". */
  nome: string;
  de: string;
  para: string;
  /** "+12,8%"; nula no ROAS (só os dois valores). */
  variacao: string | null;
  bala: BalaDoNumero | null;
};

/** Uma linha de "O que melhorou" ou "O que piorou": o nome, de quanto para quanto e a barra com a marca de antes. */
export function mudancaDesenhada(m: WeeklyReviewChange, r: Pick<WeeklyReview, 'week' | 'previous_week'>): MudancaDesenhada {
  const base = mudancaDe(m);
  const nome = base.nome.replace(/:$/, '');
  return { chave: base.chave, nome, de: base.de, para: base.para, variacao: base.variacao, bala: balaDaMudanca(m, nome, semanasDe(r)) };
}
