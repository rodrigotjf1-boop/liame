import { z } from 'zod';

// Os números da região pela API de agregados do IBGE (plano da região, R2; base de conhecimento §19.2 e §19.5): cada
// leitura é uma tabela com as variáveis que interessam, pedida pelo código do lugar (sem chave). O período "-1" é o mais
// recente que a tabela tem ("-4", os quatro mais recentes). Os valores voltam como texto; "-", "..." e "X" são "sem o
// dado". O IBGE recebe só códigos de lugar.
//
// Os recortes (D-RG-1; parte 3 a pedido do dono, que apontou o Censo de 2022 como desatualizado): o município da loja;
// a UF (os 2 primeiros dígitos); a capital (só os 27 municípios que a PNAD representa); a região metropolitana da PNAD
// e do IPCA (o código da UF e "01"; o município entra se estiver na RM legal da capital da UF); e o Brasil.

export const HOST_DO_IBGE = 'servicodados.ibge.gov.br';

/** O texto tem exatamente `n` dígitos (sem expressão regular: a varredura de segurança do CI recusa regex sobre entrada). */
export function digitos(texto: string, n: number): boolean {
  if (texto.length !== n) return false;
  for (const c of texto) if (c < '0' || c > '9') return false;
  return true;
}

export type NivelDaLeitura = 'municipio' | 'uf' | 'capital' | 'rm' | 'ipca_local' | 'brasil';

export interface LeituraDoMunicipio {
  /** A fonte no catálogo (`region_fact.source` e `region_source_read.source`). */
  fonte: string;
  tabela: number;
  periodo: string;
  /** A variável do IBGE → o indicador do Liame. */
  variaveis: Record<string, string>;
  classificacao?: string;
  /** Quando a mesma variável vem em várias categorias da classificação: a categoria → o indicador. */
  categorias?: Record<string, string>;
  /** O recorte da leitura (padrão: o município). */
  nivel?: NivelDaLeitura;
  /** O período vem como "AAAA0T" (trimestre): guardado como o mês em que o trimestre termina ("2026-06"). */
  trimestral?: boolean;
  /** Guarda todos os períodos da resposta (a média de 4 trimestres), não só o mais novo. */
  todos?: boolean;
  /** De quanto em quanto tempo ler de novo (a tabela muda uma vez por ano, por mês ou nunca). */
  renovaDias: number;
}

export const LEITURAS_DO_MUNICIPIO: readonly LeituraDoMunicipio[] = [
  // Censo 2022: população residente e densidade.
  { fonte: 'ibge_4714', tabela: 4714, periodo: '2022', variaveis: { '93': 'populacao', '614': 'densidade' }, renovaDias: 180 },
  // Estimativas de população (uma vez por ano; série com base própria: não se compara com o Censo, §19.5).
  { fonte: 'ibge_6579', tabela: 6579, periodo: '-1', variaveis: { '9324': 'populacao_estimada' }, renovaDias: 30 },
  // Censo 2022: renda domiciliar per capita, média e mediana (valor de 2022).
  { fonte: 'ibge_10295', tabela: 10295, periodo: '2022', variaveis: { '13431': 'renda_pc_media', '13534': 'renda_pc_mediana' }, renovaDias: 180 },
  // Cadastro Central de Empresas: unidades locais da CNAE 56.11-2 (restaurantes e outros serviços de alimentação e bebidas).
  { fonte: 'ibge_9528', tabela: 9528, periodo: '-1', variaveis: { '706': 'restaurantes' }, classificacao: '12762[117551]', renovaDias: 30 },
  // IPCA, número-índice: o de julho de 2022 (o mês do Censo) e o mais novo — duas chamadas (as duas juntas dão 500).
  { fonte: 'ibge_1737_censo', tabela: 1737, periodo: '202207', variaveis: { '2266': 'ipca_indice' }, nivel: 'brasil', renovaDias: 3650 },
  { fonte: 'ibge_1737', tabela: 1737, periodo: '-1', variaveis: { '2266': 'ipca_indice' }, nivel: 'brasil', renovaDias: 7 },
  // PNAD Contínua anual: renda domiciliar per capita da UF (2025) e da região metropolitana.
  { fonte: 'ibge_7531', tabela: 7531, periodo: '-1', variaveis: { '10824': 'renda_pc_pnad' }, classificacao: '1019[49243]', nivel: 'uf', renovaDias: 30 },
  { fonte: 'ibge_7395', tabela: 7395, periodo: '-1', variaveis: { '4196': 'renda_pc_pnad' }, nivel: 'rm', renovaDias: 30 },
  // PNAD Contínua trimestral: renda do trabalho na capital (os 4 trimestres mais novos, para a média).
  { fonte: 'ibge_6472', tabela: 6472, periodo: '-4', variaveis: { '5933': 'renda_trabalho' }, nivel: 'capital', trimestral: true, todos: true, renovaDias: 15 },
  // IPCA de comer fora em 12 meses: na RM ou no município que o IPCA cobre, e no Brasil (para comparar).
  {
    fonte: 'ibge_7060',
    tabela: 7060,
    periodo: '-1',
    variaveis: { '2265': 'ipca_12m' },
    classificacao: '315[7432,7434,7435]',
    categorias: { '7432': 'ipca_fora_12m', '7434': 'ipca_refeicao_12m', '7435': 'ipca_lanche_12m' },
    nivel: 'ipca_local',
    renovaDias: 7,
  },
  {
    fonte: 'ibge_7060_brasil',
    tabela: 7060,
    periodo: '-1',
    variaveis: { '2265': 'ipca_12m' },
    classificacao: '315[7432,7434,7435]',
    categorias: { '7432': 'ipca_fora_12m', '7434': 'ipca_refeicao_12m', '7435': 'ipca_lanche_12m' },
    nivel: 'brasil',
    renovaDias: 7,
  },
];

/** As 27 capitais: os únicos municípios que a PNAD Contínua representa. */
export const CAPITAIS: Readonly<Record<string, string>> = {
  '11': '1100205',
  '12': '1200401',
  '13': '1302603',
  '14': '1400100',
  '15': '1501402',
  '16': '1600303',
  '17': '1721000',
  '21': '2111300',
  '22': '2211001',
  '23': '2304400',
  '24': '2408102',
  '25': '2507507',
  '26': '2611606',
  '27': '2704302',
  '28': '2800308',
  '29': '2927408',
  '31': '3106200',
  '32': '3205309',
  '33': '3304557',
  '35': '3550308',
  '41': '4106902',
  '42': '4205407',
  '43': '4314902',
  '50': '5002704',
  '51': '5103403',
  '52': '5208707',
  '53': '5300108',
};

/** As RMs do IPCA (tabela 7060, N7) e os municípios que ele cobre sozinhos (N6). */
export const RMS_DO_IPCA = new Set(['1501', '2301', '2601', '2901', '3101', '3201', '3301', '3501', '4101', '4301']);
export const MUNICIPIOS_DO_IPCA = new Set(['1200401', '2111300', '2800308', '5002704', '5208707', '5300108']);

export interface LugarDaLeitura {
  /** `municipio`, `uf`, `rm` ou `brasil` (em `region_fact.geo_level`). */
  nivel: 'municipio' | 'uf' | 'rm' | 'brasil';
  codigo: string;
  /** O recorte na consulta do IBGE ("N6[3304557]"). */
  localidade: string;
}

/**
 * O lugar de uma leitura para a loja do município, ou nulo quando ela não vale para ele (a capital só para a capital; a
 * RM só com a RM da PNAD/IPCA já resolvida: `rm` é o código "UF01" ou nulo).
 */
export function lugarDaLeitura(l: LeituraDoMunicipio, municipio: string, rm: string | null): LugarDaLeitura | null {
  const uf = municipio.slice(0, 2);
  switch (l.nivel ?? 'municipio') {
    case 'municipio':
      return { nivel: 'municipio', codigo: municipio, localidade: `N6[${municipio}]` };
    case 'uf':
      return { nivel: 'uf', codigo: uf, localidade: `N3[${uf}]` };
    case 'capital':
      return CAPITAIS[uf] === municipio ? { nivel: 'municipio', codigo: municipio, localidade: `N6[${municipio}]` } : null;
    case 'rm':
      return rm ? { nivel: 'rm', codigo: rm, localidade: `N7[${rm}]` } : null;
    case 'ipca_local':
      if (MUNICIPIOS_DO_IPCA.has(municipio)) return { nivel: 'municipio', codigo: municipio, localidade: `N6[${municipio}]` };
      return rm && RMS_DO_IPCA.has(rm) ? { nivel: 'rm', codigo: rm, localidade: `N7[${rm}]` } : null;
    case 'brasil':
      return { nivel: 'brasil', codigo: '1', localidade: 'N1[all]' };
  }
}

/** O endereço da consulta de uma tabela para um lugar. */
export function enderecoDoAgregado(l: LeituraDoMunicipio, lugar: string | LugarDaLeitura): string {
  const localidade = typeof lugar === 'string' ? `N6[${lugar}]` : lugar.localidade;
  if (typeof lugar === 'string' && !digitos(lugar, 7)) throw new Error('código de município fora do formato');
  const u = new URL(`https://${HOST_DO_IBGE}/api/v3/agregados/${l.tabela}/periodos/${l.periodo}/variaveis/${Object.keys(l.variaveis).join('|')}`);
  u.searchParams.set('localidades', localidade);
  if (l.classificacao) u.searchParams.set('classificacao', l.classificacao);
  return u.toString();
}

const RespostaDoAgregado = z
  .array(
    z.object({
      id: z.string().max(20),
      resultados: z
        .array(
          z.object({
            classificacoes: z.array(z.object({ categoria: z.record(z.string().max(20), z.string().max(300)) })).max(10).optional(),
            series: z
              .array(z.object({ localidade: z.object({ id: z.string().max(20) }), serie: z.record(z.string().max(10), z.string().max(40).nullable()) }))
              .max(40),
          }),
        )
        .max(40),
    }),
  )
  .max(20);

export interface NumeroDoIbge {
  indicador: string;
  periodo: string;
  valor: number;
}

/** O período como o Liame guarda: o ano, o mês ("202609" → "2026-09") ou o trimestre pelo mês em que termina. */
export function periodoDoIbge(bruto: string, trimestral: boolean): string | null {
  if (digitos(bruto, 4)) return bruto;
  if (!digitos(bruto, 6)) return null;
  const ano = bruto.slice(0, 4);
  const n = Number(bruto.slice(4));
  if (trimestral) return n >= 1 && n <= 4 ? `${ano}-${String(n * 3).padStart(2, '0')}` : null;
  return n >= 1 && n <= 12 ? `${ano}-${bruto.slice(4)}` : null;
}

/**
 * Os números da resposta, só do lugar pedido e dos indicadores do catálogo: o período mais novo de cada um (ou todos,
 * quando a leitura pede). `lugar` é o código que o IBGE devolve na série ("3304557", "33", "3301", "1").
 */
export function numerosDaResposta(corpo: unknown, l: LeituraDoMunicipio, lugar: string): NumeroDoIbge[] {
  const r = RespostaDoAgregado.safeParse(corpo);
  if (!r.success) return [];
  const numeros: NumeroDoIbge[] = [];
  for (const v of r.data) {
    const daVariavel = l.variaveis[v.id];
    if (!daVariavel) continue;
    const porIndicador = new Map<string, NumeroDoIbge[]>();
    for (const res of v.resultados) {
      const categoria = Object.keys(res.classificacoes?.[0]?.categoria ?? {})[0];
      const indicador = l.categorias ? (categoria ? l.categorias[categoria] : undefined) : daVariavel;
      if (!indicador) continue;
      for (const s of res.series) {
        if (s.localidade.id !== lugar) continue;
        for (const [bruto, texto] of Object.entries(s.serie)) {
          const periodo = periodoDoIbge(bruto, l.trimestral === true);
          const valor = Number((texto ?? '').trim());
          if (!periodo || !texto || !Number.isFinite(valor)) continue;
          porIndicador.set(indicador, [...(porIndicador.get(indicador) ?? []), { indicador, periodo, valor }]);
        }
      }
    }
    for (const lista of porIndicador.values()) {
      if (l.todos) numeros.push(...lista);
      else numeros.push(lista.reduce((a, b) => (b.periodo > a.periodo ? b : a)));
    }
  }
  return numeros;
}

/** Lê uma tabela do IBGE (só do servidor do IBGE, sem seguir redirecionamento, com teto de tamanho e de tempo). */
export async function buscarAgregado(url: string, tempoMs = 15_000, buscar: typeof fetch = fetch): Promise<unknown> {
  if (new URL(url).host !== HOST_DO_IBGE) throw new Error('endereço fora do IBGE');
  const r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(tempoMs), headers: { 'user-agent': 'Liame/1.0 (+https://agencialiame.com)', accept: 'application/json' } });
  if (!r.ok) throw new Error(`o IBGE respondeu ${r.status}`);
  const texto = await r.text();
  if (texto.length > 2 * 1024 * 1024) throw new Error('resposta do IBGE maior que o esperado');
  return JSON.parse(texto) as unknown;
}

// ------------------------------------------------------------------------------------------------------------------
// A região metropolitana do município (para a PNAD e o IPCA): a lista das RMs legais do IBGE, com os municípios de cada
// uma; o município está na RM "da capital" da UF quando a mesma RM legal contém ele e a capital. Aproximação nossa: a RM
// da PNAD (N7, "UF01") pode ter composição um pouco diferente da legal (base §19.5).

export const ENDERECO_DAS_RMS = `https://${HOST_DO_IBGE}/api/v1/localidades/regioes-metropolitanas`;
export const FONTE_DA_RM = 'ibge_rm';

const RespostaDasRms = z.array(z.object({ municipios: z.array(z.object({ id: z.number().int() })).max(500) })).max(500);

/** O código da RM da PNAD/IPCA ("3301") do município, ou nulo quando ele não está na RM da capital da UF. */
export function rmDoMunicipio(corpo: unknown, municipio: string): string | null {
  const r = RespostaDasRms.safeParse(corpo);
  if (!r.success) return null;
  const uf = municipio.slice(0, 2);
  const capital = CAPITAIS[uf];
  if (!capital) return null;
  for (const rm of r.data) {
    const ids = new Set(rm.municipios.map((m) => String(m.id)));
    if (ids.has(capital) && ids.has(municipio)) return `${uf}01`;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------
// O Pix por município (Banco Central, dados abertos Olinda; base §19.5): pessoas que pagaram e o valor pago por pessoa
// física, mês a mês. A consulta devolve do mês pedido até o corrente (que vem parcial e fica de fora).

export const HOST_DO_BCB = 'olinda.bcb.gov.br';
export const FONTE_DO_PIX = 'bcb_pix';

export function enderecoDoPix(municipio: string, desde: string): string {
  if (!digitos(municipio, 7) || !digitos(desde, 6)) throw new Error('parâmetro do Pix fora do formato');
  return `https://${HOST_DO_BCB}/olinda/servico/Pix_DadosAbertos/versao/v1/odata/TransacoesPixPorMunicipio(DataBase=@DataBase)?@DataBase='${desde}'&$filter=Municipio_Ibge%20eq%20${municipio}&$format=json`;
}

const RespostaDoPix = z.object({
  value: z
    .array(z.object({ AnoMes: z.number().int(), Municipio_Ibge: z.number().int(), VL_PagadorPF: z.number().nonnegative(), QT_PES_PagadorPF: z.number().int().nonnegative() }))
    .max(60),
});

/** Os meses completos (antes de `mesCorrente`, "AAAAMM") do município: pessoas pagadoras e valor pago por pessoa física. */
export function numerosDoPix(corpo: unknown, municipio: string, mesCorrente: string): NumeroDoIbge[] {
  const r = RespostaDoPix.safeParse(corpo);
  if (!r.success) return [];
  const numeros: NumeroDoIbge[] = [];
  for (const m of r.data.value) {
    const anoMes = String(m.AnoMes);
    if (String(m.Municipio_Ibge) !== municipio || anoMes >= mesCorrente || !digitos(anoMes, 6)) continue;
    const periodo = `${anoMes.slice(0, 4)}-${anoMes.slice(4)}`;
    numeros.push({ indicador: 'pix_pf_pagadores', periodo, valor: m.QT_PES_PagadorPF }, { indicador: 'pix_pf_valor', periodo, valor: Math.round(m.VL_PagadorPF * 100) / 100 });
  }
  return numeros;
}

/** Lê um JSON do Banco Central ou da lista de RMs do IBGE (só esses servidores, sem redirecionamento, com tetos). */
export async function buscarJson(url: string, hosts: readonly string[], tempoMs = 20_000, buscar: typeof fetch = fetch): Promise<unknown> {
  if (!hosts.includes(new URL(url).host)) throw new Error('endereço fora das fontes da região');
  const r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(tempoMs), headers: { 'user-agent': 'Liame/1.0 (+https://agencialiame.com)', accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).host} respondeu ${r.status}`);
  const texto = await r.text();
  if (texto.length > 4 * 1024 * 1024) throw new Error('resposta maior que o esperado');
  return JSON.parse(texto) as unknown;
}
