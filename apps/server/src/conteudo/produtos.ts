// O ranking dos produtos do cardápio para o plano de conteúdo e as campanhas (plano de conteúdo, PC4, parte 1; seção 6.2;
// D-PC-2). Contas puras, sem banco: o serviço traz as linhas já agrupadas pelo CÓDIGO do produto do Regem
// (`order_item_fact.product_external_id`), nunca pelo nome escrito no pedido. Cada canal escreve o mesmo produto de um
// jeito ("TRIO 08", "Trio 08 - Burguer + Batata + Refri" e "Burger 08 Trio..." são um produto só na Mister Burgers).
// O item sem o código fica fora do ranking, à parte, em "sem código", com os nomes (D-PC-35). As regras de pedido são as de Resultados: conta o pedido confirmado, no
// dia do pedido do cliente no fuso da loja, nas 4 semanas completas até ontem (V57). Nada de pessoa: só somas da loja.

import { nomeComparavel } from '../regiao/coordenada.js';
import { diasAntes, JANELA_DIAS } from '../regiao/demanda.js';

export { JANELA_DIAS };
/** Abaixo disto na janela, o ranking ainda não diz nada (a resposta diz "poucos pedidos"). */
export const MINIMO_DE_PEDIDOS = 20;
/** Quantos produtos a resposta traz, dos que mais venderam (o cardápio de uma loja passa pouco disso). */
export const PRODUTOS_NA_RESPOSTA = 100;
/** Quantos nomes de canal vão em cada produto e quantos nomes sem código vão na resposta. */
export const NOMES_POR_PRODUTO = 5;
export const NOMES_SEM_CODIGO = 10;
/** A tendência só muda de "estável" com esta diferença nos pedidos, e pelo menos esta quantidade de pedidos. */
export const TENDENCIA_PORCENTO = 20;
export const TENDENCIA_MINIMO = 5;
/** "Vende bem": entre os 20% que mais vendem (pelo menos os 5 primeiros). */
export const PARTE_QUE_VENDE_BEM = 0.2;
export const VENDE_BEM_MINIMO = 5;
/** "Margem boa, pouca venda" só se compara com pelo menos tantos produtos com o custo conhecido. */
export const MINIMO_COM_MARGEM = 5;

/** Uma linha agrupada por janela e código: as somas da janela. */
export type LinhaDoProduto = {
  janela: 'atual' | 'anterior';
  codigo: string;
  pedidos: number;
  quantidade: string | number;
  receita: string | number;
  /** A soma do custo das linhas que têm custo; só vale com `custo_conhecido`. */
  custo: string | number | null;
  /** Toda linha do produto na janela tem o custo do Regem, maior que zero (o zero é "sem custo cadastrado"). */
  custo_conhecido: boolean;
};

/** Um nome escrito nos pedidos da janela atual para um código, e quantas linhas o usam; `de_canal` = marketplace. */
export type NomeDoProduto = { codigo: string; nome: string; de_canal: boolean; linhas: number };

/** As linhas sem código, por nome (janela atual). */
export type LinhaSemCodigo = { nome: string; pedidos: number; receita: string | number };

/** As linhas sem código da janela atual: os pedidos distintos e a receita somada (um pedido conta uma vez). */
export type TotalSemCodigo = { pedidos: number; receita: string | number };

/** Onde a marca já mostrou alguma coisa: as legendas do Instagram (com a data) e o produto e a descrição de Fotos. */
export type Aparicoes = {
  legendas: ReadonlyArray<{ texto: string; publicado_em: string }>;
  fotos: ReadonlyArray<{ texto: string }>;
};

export const DESTAQUES = ['vende_bem_nunca_apareceu', 'margem_boa_pouca_venda', 'subindo'] as const;
export type Destaque = (typeof DESTAQUES)[number];
export type Tendencia = 'subindo' | 'caindo' | 'estavel' | 'novo';

export interface ProdutoDoRanking {
  rank: number;
  code: string;
  name: string;
  other_names: string[];
  orders: number;
  quantity: string;
  revenue_micros: string;
  previous: { orders: number; quantity: string; revenue_micros: string };
  trend: Tendencia;
  /** A variação dos pedidos contra as 4 semanas antes, em pontos percentuais inteiros; nula sem pedido antes. */
  trend_percent: number | null;
  /** Receita menos custo, só com o custo conhecido em todas as linhas da janela. */
  margin_micros: string | null;
  margin_percent: number | null;
  seen: { instagram_posts: number; last_post_at: string | null; photos: number };
  highlights: Destaque[];
}

export interface RankingDeProdutos {
  status: 'pronto' | 'poucos_pedidos' | 'sem_pedidos';
  from: string;
  to: string;
  previous_from: string;
  previous_to: string;
  days: number;
  minimum_orders: number;
  orders: number;
  products: ProdutoDoRanking[];
  /** Quantos produtos venderam na janela (a lista corta em `PRODUTOS_NA_RESPOSTA`). */
  products_total: number;
  without_code: { orders: number; revenue_micros: string; names: string[] };
}

const grande = (v: string | number | null): bigint => {
  if (v === null) return 0n;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  return BigInt(v.split('.')[0] || '0');
};

/** A quantidade como o banco escreve (`numeric(14,3)`), sem zeros à direita: "478.000" → "478", "2.500" → "2.5". */
export function quantidadeLimpa(v: string | number): string {
  const s = typeof v === 'number' ? String(v) : v;
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s;
}

/** As janelas a partir de hoje (no fuso da loja): a atual termina ontem; a anterior, no dia antes dela. */
export function janelasDoRanking(hoje: string): { de: string; ate: string; deAnterior: string; ateAnterior: string } {
  const ate = diasAntes(hoje, 1);
  const de = diasAntes(hoje, JANELA_DIAS);
  return { de, ate, deAnterior: diasAntes(de, JANELA_DIAS), ateAnterior: diasAntes(de, 1) };
}

/**
 * O texto comparável: sem acento, em minúsculas, sem pontuação e sem o zero à esquerda dos números ("TRIO 08" e
 * "trio 8" ficam iguais).
 */
export function textoComparavel(texto: string): string {
  return nomeComparavel(texto)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b0+(\d)/g, '$1')
    .trim();
}

/**
 * As chaves que procuram o produto num texto: o nome inteiro e o começo dele, antes do primeiro separador
 * (" - ", "(", "+", ","), quando o começo tem pelo menos 4 letras. "Trio 08 - Burguer + Batata + Refri" procura
 * "trio 8 burguer batata refri" e "trio 8".
 */
export function chavesDoNome(nome: string): string[] {
  const chaves = new Set<string>();
  const inteiro = textoComparavel(nome);
  if (inteiro.length >= 4) chaves.add(inteiro);
  const comeco = textoComparavel(nome.split(/\s-\s|\(|\+|,/)[0] ?? '');
  if (comeco.length >= 4) chaves.add(comeco);
  return [...chaves];
}

/** O texto tem a chave como palavras inteiras ("trio 8" não casa com "trio 80"). */
function contem(texto: string, chave: string): boolean {
  return ` ${texto} `.includes(` ${chave} `);
}

/** A tendência pelos pedidos das duas janelas. */
export function tendencia(atual: number, anterior: number): { trend: Tendencia; percent: number | null } {
  if (anterior === 0) return { trend: atual > 0 ? 'novo' : 'estavel', percent: null };
  const percent = Math.round(((atual - anterior) / anterior) * 100);
  const diferenca = Math.abs(atual - anterior);
  if (diferenca >= TENDENCIA_MINIMO && percent >= TENDENCIA_PORCENTO) return { trend: 'subindo', percent };
  if (diferenca >= TENDENCIA_MINIMO && percent <= -TENDENCIA_PORCENTO) return { trend: 'caindo', percent };
  return { trend: 'estavel', percent };
}

/** A mediana de uma lista de números (a lista não fica vazia aqui). */
function mediana(valores: readonly number[]): number {
  const v = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio]! : (v[meio - 1]! + v[meio]!) / 2;
}

/**
 * O nome do produto: o mais usado nos canais do próprio Regem (balcão, cardápio, totem), que é o nome do cadastro; sem
 * eles, o mais usado em qualquer canal. Empate: o menor em ordem alfabética, para a resposta não mudar de uma leitura
 * para outra.
 */
function nomePrincipal(nomes: readonly NomeDoProduto[]): string {
  const ordem = (a: NomeDoProduto, b: NomeDoProduto) => b.linhas - a.linhas || a.nome.localeCompare(b.nome, 'pt-BR');
  const proprios = nomes.filter((n) => !n.de_canal).sort(ordem);
  return (proprios[0] ?? [...nomes].sort(ordem)[0])?.nome ?? '';
}

/** O ranking a partir das linhas agrupadas, dos nomes, das linhas sem código e de onde a marca já mostrou. */
export function rankingDeProdutos(
  linhas: readonly LinhaDoProduto[],
  nomes: readonly NomeDoProduto[],
  semCodigo: readonly LinhaSemCodigo[],
  totalSemCodigo: TotalSemCodigo,
  pedidosDaJanela: number,
  aparicoes: Aparicoes,
  hoje: string,
): RankingDeProdutos {
  const j = janelasDoRanking(hoje);
  const atual = linhas.filter((l) => l.janela === 'atual' && l.pedidos > 0);
  const anterior = new Map(linhas.filter((l) => l.janela === 'anterior').map((l) => [l.codigo, l]));
  const nomesPorCodigo = new Map<string, NomeDoProduto[]>();
  for (const n of nomes) nomesPorCodigo.set(n.codigo, [...(nomesPorCodigo.get(n.codigo) ?? []), n]);
  const legendas = aparicoes.legendas.map((l) => ({ texto: textoComparavel(l.texto), publicado_em: l.publicado_em }));
  const fotos = aparicoes.fotos.map((f) => textoComparavel(f.texto));

  const ordenados = [...atual].sort((a, b) => b.pedidos - a.pedidos || Number(grande(b.receita) - grande(a.receita)) || a.codigo.localeCompare(b.codigo));
  const corte = Math.max(VENDE_BEM_MINIMO, Math.ceil(ordenados.length * PARTE_QUE_VENDE_BEM));

  const produtos: ProdutoDoRanking[] = ordenados.map((l, i) => {
    const nomesDele = nomesPorCodigo.get(l.codigo) ?? [];
    const nome = nomePrincipal(nomesDele) || l.codigo;
    const outros = [...nomesDele]
      .sort((a, b) => b.linhas - a.linhas || a.nome.localeCompare(b.nome, 'pt-BR'))
      .map((n) => n.nome)
      .filter((n) => n !== nome)
      .slice(0, NOMES_POR_PRODUTO);
    const chaves = [...new Set([nome, ...nomesDele.map((n) => n.nome)].flatMap(chavesDoNome))];
    const posts = legendas.filter((p) => chaves.some((c) => contem(p.texto, c)));
    const ultimo = posts.map((p) => p.publicado_em).sort().at(-1) ?? null;
    const nasFotos = fotos.filter((f) => chaves.some((c) => contem(f, c))).length;
    const antes = anterior.get(l.codigo);
    const t = tendencia(l.pedidos, antes?.pedidos ?? 0);
    const receita = grande(l.receita);
    const margem = l.custo_conhecido && receita > 0n ? receita - grande(l.custo) : null;
    return {
      rank: i + 1,
      code: l.codigo,
      name: nome,
      other_names: outros,
      orders: l.pedidos,
      quantity: quantidadeLimpa(l.quantidade),
      revenue_micros: receita.toString(),
      previous: { orders: antes?.pedidos ?? 0, quantity: quantidadeLimpa(antes?.quantidade ?? 0), revenue_micros: grande(antes?.receita ?? 0).toString() },
      trend: t.trend,
      trend_percent: t.percent,
      margin_micros: margem === null ? null : margem.toString(),
      margin_percent: margem === null ? null : Math.round(Number((margem * 1000n) / receita)) / 10,
      seen: { instagram_posts: posts.length, last_post_at: ultimo, photos: nasFotos },
      highlights: [
        // D-PC-35: "apareceu" é a legenda de um post (a foto etiquetada que saiu em post entra com a PC3). A foto que só
        // está em Fotos não conta: ela é o material para o post que ainda não saiu.
        ...(i < corte && posts.length === 0 ? (['vende_bem_nunca_apareceu'] as const) : []),
        ...(t.trend === 'subindo' ? (['subindo'] as const) : []),
      ],
    };
  });

  // "Margem boa, pouca venda": a margem acima da mediana e os pedidos abaixo da mediana, entre os que têm o custo.
  const comMargem = produtos.filter((p) => p.margin_percent !== null);
  if (comMargem.length >= MINIMO_COM_MARGEM) {
    const margemDoMeio = mediana(comMargem.map((p) => p.margin_percent!));
    const pedidosDoMeio = mediana(produtos.map((p) => p.orders));
    for (const p of comMargem) {
      if (p.margin_percent! > margemDoMeio && p.orders < pedidosDoMeio) p.highlights.push('margem_boa_pouca_venda');
    }
  }
  for (const p of produtos) p.highlights.sort((a, b) => DESTAQUES.indexOf(a) - DESTAQUES.indexOf(b));

  const semCodigoOrdenado = [...semCodigo].sort((a, b) => b.pedidos - a.pedidos || a.nome.localeCompare(b.nome, 'pt-BR'));
  return {
    status: pedidosDaJanela === 0 ? 'sem_pedidos' : pedidosDaJanela < MINIMO_DE_PEDIDOS ? 'poucos_pedidos' : 'pronto',
    from: j.de,
    to: j.ate,
    previous_from: j.deAnterior,
    previous_to: j.ateAnterior,
    days: JANELA_DIAS,
    minimum_orders: MINIMO_DE_PEDIDOS,
    orders: pedidosDaJanela,
    products: produtos.slice(0, PRODUTOS_NA_RESPOSTA),
    products_total: produtos.length,
    without_code: {
      orders: totalSemCodigo.pedidos,
      revenue_micros: grande(totalSemCodigo.receita).toString(),
      names: semCodigoOrdenado.slice(0, NOMES_SEM_CODIGO).map((l) => l.nome),
    },
  };
}
