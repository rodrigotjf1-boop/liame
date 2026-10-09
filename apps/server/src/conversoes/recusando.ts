// "O Google está recusando as vendas" (A5 · Y1; protótipo P14, parte B, aprovado em 09/10/2026). A regra mora num
// lugar só: é a mesma na situação de cada conta (`GET /v1/conversions/google`, que a linha de Resultados lê) e no aviso
// da Atenção. Uma recusa isolada (um clique que o Google não reconheceu) não é aviso: fica no cartão de Contas
// conectadas e na contagem. Funções puras.

/** A janela em que as recusas contam para o aviso. */
export const JANELA_DAS_RECUSAS_DIAS = 7;
/** Menos que isto é recusa isolada. */
export const MINIMO_DE_RECUSAS = 3;

/**
 * Está recusando: na janela, o Google recusou pelo menos `MINIMO_DE_RECUSAS` vendas e mais da metade das que tiveram
 * resposta (aceitas ou recusadas). `respondidas` inclui as recusadas.
 */
export function estaRecusando(recusadas: number, respondidas: number): boolean {
  return recusadas >= MINIMO_DE_RECUSAS && recusadas * 2 > respondidas;
}
