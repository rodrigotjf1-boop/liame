import type { RegionFoodCount, RegionNumber, RegionOverviewResponse, RegionSourceStatus } from '@liame/contracts';
import { FONTE_CENSO_BAIRRO } from './censo.js';
import { FONTE_DO_CNPJ } from './cnpj.js';
import { FONTE_DA_RM, FONTE_DO_PIX, LEITURAS_DO_MUNICIPIO, lugarDaLeitura } from './ibge.js';

// Sua região (plano da região, R2): as contas puras do retrato, sem banco e sem rede. Os números vêm das tabelas do
// sistema (migration 0137); aqui só se escolhe o mais novo de cada lugar, se calcula o que é conta (densidade, por 10 mil
// habitantes, a posição entre os bairros, a correção pelo IPCA, a média dos trimestres, o mesmo mês do ano anterior) e
// se diz a situação de cada fonte.

/** O mês do Censo 2022 (a renda do Censo é corrigida pelo IPCA a partir dele). */
export const MES_DO_CENSO = '2022-07';

export type NumeroGuardado = {
  geo_level?: string;
  geo_code?: string;
  indicator: string;
  period: string;
  value: number | string;
  source: string;
};

export type LeituraGuardada = {
  source: string;
  geo_code: string;
  last_ok_at: Date | string | null;
  last_error: string | null;
  next_try_at: Date | string | null;
};

/** As fontes (e o lugar de cada uma) que o retrato de uma loja usa: o Censo, a RM, as tabelas de cada recorte e o Pix. */
export function fontesDoRetrato(municipio: string, rm: string | null): Array<{ fonte: string; lugar: string }> {
  const lista = [
    { fonte: FONTE_CENSO_BAIRRO, lugar: '0' },
    { fonte: FONTE_DA_RM, lugar: municipio },
  ];
  for (const l of LEITURAS_DO_MUNICIPIO) {
    const lugar = lugarDaLeitura(l, municipio, rm);
    if (lugar) lista.push({ fonte: l.fonte, lugar: lugar.codigo });
  }
  lista.push({ fonte: FONTE_DO_PIX, lugar: municipio });
  // O CNPJ da Receita vale para o país inteiro (uma leitura por mês, de horas): por último, e não segura o retrato.
  lista.push({ fonte: FONTE_DO_CNPJ, lugar: '0' });
  return lista;
}

const iso = (v: Date | string | null): string | null => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());

const doLugar = (n: NumeroGuardado, nivel?: string, codigo?: string) => (nivel === undefined || n.geo_level === nivel) && (codigo === undefined || n.geo_code === codigo);

/** O número mais novo de um indicador (o período maior), com a fonte; só do lugar pedido, quando ele vem. */
export function numeroMaisNovo(numeros: readonly NumeroGuardado[], indicador: string, nivel?: string, codigo?: string): RegionNumber | null {
  let melhor: NumeroGuardado | null = null;
  for (const n of numeros) if (n.indicator === indicador && doLugar(n, nivel, codigo) && (!melhor || n.period > melhor.period)) melhor = n;
  return melhor ? { value: Number(melhor.value), period: melhor.period, source: melhor.source } : null;
}

/** O valor de um indicador num período exato. */
function noPeriodo(numeros: readonly NumeroGuardado[], indicador: string, periodo: string, nivel?: string, codigo?: string): number | null {
  const n = numeros.find((x) => x.indicator === indicador && x.period === periodo && doLugar(x, nivel, codigo));
  return n ? Number(n.value) : null;
}

/** Pessoas por km², com uma casa; nulo sem pessoas ou sem área. */
export function densidade(pessoas: number | null, areaKm2: number | null): number | null {
  if (pessoas === null || areaKm2 === null || areaKm2 <= 0) return null;
  return Math.round((pessoas / areaKm2) * 10) / 10;
}

/** Quantos por 10 mil habitantes, com uma casa. */
export function por10Mil(quantos: number | null, populacao: number | null): number | null {
  if (quantos === null || populacao === null || populacao <= 0) return null;
  return Math.round((quantos / populacao) * 100_000) / 10;
}

/** Acima de quantos por cento dos bairros com renda (inteiro, para baixo). */
export function acimaDe(abaixo: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((abaixo / total) * 100);
}

/** A correção pelo IPCA (número-índice do Brasil): de julho de 2022 até o mês mais novo guardado. */
export function correcaoDoIpca(numeros: readonly NumeroGuardado[]): { from: string; to: string; factor: number } | null {
  const base = noPeriodo(numeros, 'ipca_indice', MES_DO_CENSO, 'brasil', '1');
  const ultimo = numeroMaisNovo(numeros, 'ipca_indice', 'brasil', '1');
  if (!base || !ultimo || ultimo.period <= MES_DO_CENSO) return null;
  return { from: MES_DO_CENSO, to: ultimo.period, factor: Math.round((ultimo.value / base) * 10_000) / 10_000 };
}

/** Um valor de 2022 a preços de hoje (reais inteiros). */
export function corrigido(valor: number | null, ipca: { factor: number } | null): number | null {
  return valor === null || !ipca ? null : Math.round(valor * ipca.factor);
}

/** A média dos trimestres mais novos (até 4) de um indicador do município. */
export function mediaDosTrimestres(numeros: readonly NumeroGuardado[], indicador: string, municipio: string): { value: number; period: string; quarters: number; source: string } | null {
  const lista = numeros
    .filter((n) => n.indicator === indicador && doLugar(n, 'municipio', municipio))
    .sort((a, b) => (a.period < b.period ? 1 : -1))
    .slice(0, 4);
  if (!lista.length) return null;
  const soma = lista.reduce((s, n) => s + Number(n.value), 0);
  return { value: Math.round(soma / lista.length), period: lista[0]!.period, quarters: lista.length, source: lista[0]!.source };
}

/** O mês "AAAA-MM" doze meses antes. */
export function anoAntes(periodo: string): string {
  return `${Number(periodo.slice(0, 4)) - 1}${periodo.slice(4)}`;
}

/** O Pix do município: o mês mais novo e o mesmo mês do ano anterior. */
export function pixDoMunicipio(numeros: readonly NumeroGuardado[], municipio: string) {
  const pagadores = numeroMaisNovo(numeros, 'pix_pf_pagadores', 'municipio', municipio);
  if (!pagadores) return null;
  const valor = noPeriodo(numeros, 'pix_pf_valor', pagadores.period, 'municipio', municipio);
  if (valor === null) return null;
  const antes = anoAntes(pagadores.period);
  return {
    period: pagadores.period,
    payers: pagadores.value,
    value: valor,
    payers_prev_year: noPeriodo(numeros, 'pix_pf_pagadores', antes, 'municipio', municipio),
    value_prev_year: noPeriodo(numeros, 'pix_pf_valor', antes, 'municipio', municipio),
  };
}

/** A inflação de comer fora em 12 meses no lugar (RM ou município) e no Brasil, no mês mais novo. */
export function inflacaoDeComerFora(numeros: readonly NumeroGuardado[], nivel: 'rm' | 'municipio' | 'brasil', codigo: string) {
  const fora = numeroMaisNovo(numeros, 'ipca_fora_12m', nivel, codigo);
  if (!fora) return null;
  const p = fora.period;
  const brasilFora = noPeriodo(numeros, 'ipca_fora_12m', p, 'brasil', '1');
  return {
    scope: nivel,
    period: p,
    away: fora.value,
    meal: noPeriodo(numeros, 'ipca_refeicao_12m', p, nivel, codigo),
    snack: noPeriodo(numeros, 'ipca_lanche_12m', p, nivel, codigo),
    brasil:
      brasilFora === null
        ? null
        : { away: brasilFora, meal: noPeriodo(numeros, 'ipca_refeicao_12m', p, 'brasil', '1'), snack: noPeriodo(numeros, 'ipca_lanche_12m', p, 'brasil', '1') },
  };
}

/**
 * A situação de uma fonte: `lendo` enquanto nunca deu certo nem falhou; `falhou` quando nunca deu certo e a última
 * tentativa falhou; `em_dia` quando já deu certo (o número guardado vale, mesmo que a renovação falhe depois).
 */
export function situacaoDaFonte(fonte: string, leitura: LeituraGuardada | undefined): RegionSourceStatus {
  if (!leitura) return { source: fonte, status: 'lendo', read_at: null, next_try_at: null };
  if (leitura.last_ok_at) return { source: fonte, status: 'em_dia', read_at: iso(leitura.last_ok_at), next_try_at: null };
  return { source: fonte, status: leitura.last_error ? 'falhou' : 'lendo', read_at: null, next_try_at: iso(leitura.next_try_at) };
}

/** A situação do retrato: `lendo` se alguma fonte ainda não foi lida, `parcial` se alguma falhou, senão `pronto`. */
export function situacaoDoRetrato(fontes: readonly RegionSourceStatus[]): 'lendo' | 'parcial' | 'pronto' {
  // A leitura do CNPJ leva horas na primeira vez: a Concorrência mostra o "lendo" dela, e o resto do retrato aparece antes.
  const contam = fontes.filter((f) => f.source !== FONTE_DO_CNPJ);
  if (contam.some((f) => f.status === 'lendo')) return 'lendo';
  if (contam.some((f) => f.status === 'falhou')) return 'parcial';
  return 'pronto';
}

/** Uma linha da `region_food_count` (os números vêm do banco como texto ou número). */
export type ContagemGuardada = {
  area_kind: string;
  area_key: string;
  period: string;
  active: number | string;
  active_restaurant: number | string;
  active_snack: number | string;
  active_bar: number | string;
  active_home: number | string;
  opened_12m: number | string;
  closed_12m: number | string;
};

function contagemDa(linhas: readonly ContagemGuardada[]): RegionFoodCount {
  const soma = (campo: keyof ContagemGuardada) => linhas.reduce((t, l) => t + Number(l[campo]), 0);
  return {
    active: soma('active'),
    restaurant: soma('active_restaurant'),
    snack: soma('active_snack'),
    bar: soma('active_bar'),
    home: soma('active_home'),
    opened_12m: soma('opened_12m'),
    closed_12m: soma('closed_12m'),
  };
}

/**
 * Os restaurantes do retrato (CNPJ da Receita): o município, o bairro da loja, a área do CEP e as áreas de entrega,
 * das linhas guardadas do município. `ativosComBairro` é a soma dos ativos de todos os bairros do município (a cobertura).
 */
export function restaurantesDoRetrato(entrada: {
  linhas: readonly ContagemGuardada[];
  bairro: { codigo: string; areaKm2: number | null } | null;
  prefixoDoCep: string | null;
  bairrosDaEntrega: readonly string[];
  ativosComBairro: number;
  populacao: number | null;
}): RegionOverviewResponse['food_places'] {
  const municipio = entrada.linhas.find((l) => l.area_kind === 'municipio');
  if (!municipio) return null;
  const doBairro = (codigo: string) => entrada.linhas.filter((l) => l.area_kind === 'bairro' && l.area_key === codigo);
  const cidade = contagemDa([municipio]);
  const bairro = entrada.bairro ? doBairro(entrada.bairro.codigo) : [];
  const cep = entrada.prefixoDoCep ? entrada.linhas.filter((l) => l.area_kind === 'cep' && l.area_key === entrada.prefixoDoCep) : [];
  const entrega = [...new Set(entrada.bairrosDaEntrega)].flatMap(doBairro);
  const contagemDoBairro = entrada.bairro ? contagemDa(bairro) : null;
  return {
    period: municipio.period,
    since: `${Number(municipio.period.slice(0, 4)) - 1}${municipio.period.slice(4)}`,
    city: {
      ...cidade,
      per_10k: por10Mil(cidade.active, entrada.populacao),
      district_coverage_pct: cidade.active > 0 ? Math.round((entrada.ativosComBairro / cidade.active) * 100) : null,
    },
    district:
      entrada.bairro && contagemDoBairro
        ? { ...contagemDoBairro, per_km2: densidade(contagemDoBairro.active, entrada.bairro.areaKm2) }
        : null,
    postal: entrada.prefixoDoCep ? { ...contagemDa(cep), prefix: entrada.prefixoDoCep } : null,
    delivery_area: entrada.bairrosDaEntrega.length ? { ...contagemDa(entrega), matched: new Set(entrada.bairrosDaEntrega).size } : null,
  };
}
