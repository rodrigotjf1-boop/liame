import { z } from 'zod';

// Os números do município pela API de agregados do IBGE (plano da região, R2; base de conhecimento §19.2): cada leitura
// é uma tabela com as variáveis que interessam, pedida pelo código do município (sem chave). O período "-1" é o mais
// recente que a tabela tem. Os valores voltam como texto; "-", "..." e "X" são "sem o dado".

export const HOST_DO_IBGE = 'servicodados.ibge.gov.br';

export interface LeituraDoMunicipio {
  /** A fonte no catálogo (`region_fact.source` e `region_source_read.source`). */
  fonte: string;
  tabela: number;
  periodo: string;
  /** A variável do IBGE → o indicador do Liame. */
  variaveis: Record<string, string>;
  classificacao?: string;
  /** De quanto em quanto tempo ler de novo (a tabela muda uma vez por ano ou nunca). */
  renovaDias: number;
}

export const LEITURAS_DO_MUNICIPIO: readonly LeituraDoMunicipio[] = [
  // Censo 2022: população residente e densidade.
  { fonte: 'ibge_4714', tabela: 4714, periodo: '2022', variaveis: { '93': 'populacao', '614': 'densidade' }, renovaDias: 180 },
  // Estimativas de população (uma vez por ano).
  { fonte: 'ibge_6579', tabela: 6579, periodo: '-1', variaveis: { '9324': 'populacao_estimada' }, renovaDias: 30 },
  // Censo 2022: renda domiciliar per capita, média e mediana (valor de 2022).
  { fonte: 'ibge_10295', tabela: 10295, periodo: '2022', variaveis: { '13431': 'renda_pc_media', '13534': 'renda_pc_mediana' }, renovaDias: 180 },
  // Cadastro Central de Empresas: unidades locais da CNAE 56.11-2 (restaurantes e outros serviços de alimentação e bebidas).
  { fonte: 'ibge_9528', tabela: 9528, periodo: '-1', variaveis: { '706': 'restaurantes' }, classificacao: '12762[117551]', renovaDias: 30 },
];

/** O endereço da consulta de uma tabela para um município. */
export function enderecoDoAgregado(l: LeituraDoMunicipio, municipio: string): string {
  if (!/^[0-9]{7}$/.test(municipio)) throw new Error('código de município fora do formato');
  const u = new URL(`https://${HOST_DO_IBGE}/api/v3/agregados/${l.tabela}/periodos/${l.periodo}/variaveis/${Object.keys(l.variaveis).join('|')}`);
  u.searchParams.set('localidades', `N6[${municipio}]`);
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
            series: z
              .array(z.object({ localidade: z.object({ id: z.string().max(20) }), serie: z.record(z.string().max(10), z.string().max(40).nullable()) }))
              .max(20),
          }),
        )
        .max(20),
    }),
  )
  .max(20);

export interface NumeroDoIbge {
  indicador: string;
  periodo: string;
  valor: number;
}

/** Os números da resposta, só do município pedido e dos indicadores do catálogo; o período mais novo de cada um. */
export function numerosDaResposta(corpo: unknown, l: LeituraDoMunicipio, municipio: string): NumeroDoIbge[] {
  const r = RespostaDoAgregado.safeParse(corpo);
  if (!r.success) return [];
  const numeros: NumeroDoIbge[] = [];
  for (const v of r.data) {
    const indicador = l.variaveis[v.id];
    if (!indicador) continue;
    let melhor: NumeroDoIbge | null = null;
    for (const res of v.resultados) {
      for (const s of res.series) {
        if (s.localidade.id !== municipio) continue;
        for (const [periodo, bruto] of Object.entries(s.serie)) {
          if (!/^[0-9]{4}(-[0-9]{2})?$/.test(periodo) && !/^[0-9]{6}$/.test(periodo)) continue;
          const valor = Number((bruto ?? '').trim());
          if (!bruto || !Number.isFinite(valor)) continue;
          const p = /^[0-9]{6}$/.test(periodo) ? `${periodo.slice(0, 4)}-${periodo.slice(4)}` : periodo;
          if (!melhor || p > melhor.periodo) melhor = { indicador, periodo: p, valor };
        }
      }
    }
    if (melhor) numeros.push(melhor);
  }
  return numeros;
}

/** Lê uma tabela do IBGE (só do servidor do IBGE, sem seguir redirecionamento, com teto de tamanho e de tempo). */
export async function buscarAgregado(url: string, tempoMs = 15_000, buscar: typeof fetch = fetch): Promise<unknown> {
  if (new URL(url).host !== HOST_DO_IBGE) throw new Error('endereço fora do IBGE');
  const r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(tempoMs), headers: { 'user-agent': 'Liame/1.0 (+https://agencialiame.com)', accept: 'application/json' } });
  if (!r.ok) throw new Error(`o IBGE respondeu ${r.status}`);
  const texto = await r.text();
  if (texto.length > 256 * 1024) throw new Error('resposta do IBGE maior que o esperado');
  return JSON.parse(texto) as unknown;
}
