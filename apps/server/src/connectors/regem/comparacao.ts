// A comparação das duas credenciais do Regem (Hub DMS, F3, parte B; decisão F3-6 do dono, 20/10/2026).
//
// A leitura de hoje vai com o `rgm_it_` da loja; a nova, com o token do DMS ID do aplicativo do Liame e o segredo da
// ligação (`DMS-Ligacao`). As duas leem a MESMA loja, uma logo depois da outra, e o resultado tem de ser igual campo a
// campo (a regra das diferenças é a do RegemCast, `connectors/regemcast/comparacao.ts`). A via nova só passa a valer
// depois de 7 dias seguidos sem diferença, com 30 leituras ou mais de cada rota. Aqui fica só a regra pura; quem chama e
// grava é a rotina do worker. Fica guardado só o caminho do campo que difere, nunca o valor: os pedidos trazem telefone.

/** As 4 leituras que o Liame faz do Regem (contrato v1: a loja, os pedidos, os cupons e os avisos de cliente esquecido). */
export const LEITURAS_DO_REGEM = ['regem_loja', 'regem_pedidos', 'regem_cupons', 'regem_clientes_anonimizados'] as const;
export type LeituraDoRegem = (typeof LEITURAS_DO_REGEM)[number];

/** O escopo da loja que cada leitura pede (a da loja vale com qualquer um); sem ele, a comparação dela fica "sem dado". */
export const ESCOPO_DA_LEITURA_DO_REGEM: Partial<Record<LeituraDoRegem, string>> = {
  regem_pedidos: 'pedidos.ler',
  regem_cupons: 'cupons.ler',
  regem_clientes_anonimizados: 'clientes.anonimizacao.ler',
};

/** A comparação lê a primeira página dos pedidos confirmados nestes últimos dias, e a primeira dos outros conjuntos. */
export const DIAS_DOS_PEDIDOS_COMPARADOS = 3;
export const LIMITE_DA_PAGINA_COMPARADA = 50;

/**
 * O que depende da credencial, e não da loja, sai antes de comparar: só os escopos da `/loja` (pela via nova, vêm os que
 * a ligação E o token do DMS ID têm; pela de hoje, os do `rgm_it_`). O escopo que faltar à via nova aparece nos dados
 * (o telefone ou o custo que vêm nulos, a rota que recusa) e conta como diferença.
 */
export function normalizarDoRegem(leitura: LeituraDoRegem, dado: unknown): unknown {
  if (leitura === 'regem_loja' && dado !== null && typeof dado === 'object' && !Array.isArray(dado)) {
    const { escopos: _escopos, ...resto } = dado as Record<string, unknown>;
    return resto;
  }
  return dado;
}
