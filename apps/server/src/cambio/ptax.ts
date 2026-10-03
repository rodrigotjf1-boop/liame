import { z } from 'zod';

// Câmbio de referência (A3, D-A3-14; base §10.1): a PTAX de venda do Banco Central, dos dados abertos (sem
// credencial; licença ODbL, com a fonte dita na tela). O custo de IA é medido e limitado em dólar; a cotação serve só
// para MOSTRAR o valor aproximado em reais, com a data dela. Aqui ficam o endereço fixo, a leitura da resposta e a
// conta em inteiros; quem grava é o worker (`worker/cambio.service.ts`).

/** O único site de onde a cotação vem. */
export const HOST_DA_PTAX = 'olinda.bcb.gov.br';
/** O nome da fonte em `exchange_rate.source`. */
export const FONTE_PTAX = 'bcb_ptax_venda';
const LIMITE_BYTES = 64_000;

const dataDoBcb = (dia: string) => `${dia.slice(5, 7)}-${dia.slice(8, 10)}-${dia.slice(0, 4)}`;

/** O endereço da consulta de um período (dias `AAAA-MM-DD`; o Banco Central espera `MM-DD-AAAA`). */
export function enderecoDaPtax(de: string, ate: string): string {
  const u = new URL(`https://${HOST_DA_PTAX}/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)`);
  u.searchParams.set('@dataInicial', `'${dataDoBcb(de)}'`);
  u.searchParams.set('@dataFinalCotacao', `'${dataDoBcb(ate)}'`);
  u.searchParams.set('$format', 'json');
  u.searchParams.set('$select', 'cotacaoVenda,dataHoraCotacao');
  return u.toString();
}

const RespostaDaPtax = z.object({
  value: z
    .array(
      z.object({
        // Reais por dólar; a faixa barra resposta trocada (outro campo, outra moeda) sem travar numa crise de câmbio.
        cotacaoVenda: z.number().min(0.5).max(100),
        // "2026-10-02 13:03:16.256632", no horário de Brasília.
        dataHoraCotacao: z.string().max(40).regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/),
      }),
    )
    .max(400),
});

export interface Cotacao {
  /** O dia do boletim (`AAAA-MM-DD`, horário de Brasília). */
  dia: string;
  /** Reais por dólar, com quatro casas, em texto. */
  taxa: string;
  /** A hora do boletim, em ISO (Brasília está em UTC−3 o ano todo desde 2019). */
  publicadaEm: string;
}

/** As cotações da resposta do Banco Central: uma por dia (o último boletim do dia), em ordem de data. */
export function cotacoesDaPtax(json: unknown): Cotacao[] {
  const r = RespostaDaPtax.safeParse(json);
  if (!r.success) throw new Error('resposta da PTAX fora do formato');
  const porDia = new Map<string, Cotacao>();
  for (const v of r.data.value) {
    const dia = v.dataHoraCotacao.slice(0, 10);
    const publicadaEm = new Date(`${dia}T${v.dataHoraCotacao.slice(11, 19)}-03:00`).toISOString();
    const atual = porDia.get(dia);
    if (!atual || publicadaEm > atual.publicadaEm) porDia.set(dia, { dia, taxa: v.cotacaoVenda.toFixed(4), publicadaEm });
  }
  return [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia));
}

/** Lê a PTAX de um período no Banco Central: endereço fixo, sem redirecionamento, com prazo e limite de tamanho. */
export async function buscarPtax(de: string, ate: string, tempoLimiteMs = 15_000): Promise<Cotacao[]> {
  const r = await fetch(enderecoDaPtax(de, ate), { redirect: 'error', signal: AbortSignal.timeout(tempoLimiteMs), headers: { accept: 'application/json', 'user-agent': 'Liame/1.0' } });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`PTAX: HTTP ${r.status}`);
  }
  const texto = await r.text();
  if (texto.length > LIMITE_BYTES) throw new Error('PTAX: resposta grande demais');
  return cotacoesDaPtax(JSON.parse(texto) as unknown);
}

/** Micros de dólar em micros de real, pela cotação em texto ("5.2238"), só com inteiros (metade para cima). */
export function emReais(usdMicros: bigint, taxa: string): bigint {
  const [inteira = '0', fracao = ''] = taxa.split('.');
  const taxaE6 = BigInt(inteira) * 1_000_000n + BigInt((fracao + '000000').slice(0, 6));
  return (usdMicros * taxaE6 + 500_000n) / 1_000_000n;
}
