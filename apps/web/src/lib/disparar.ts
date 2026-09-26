/**
 * Dispara uma ação assíncrona da tela sem esperar por ela (clique, efeito). As ações já tratam os erros da
 * API; o que escapar (bug) vai para o console com o motivo, nunca some calado (LIC-001).
 */
export function disparar(promessa: Promise<unknown>): void {
  promessa.catch((erro: unknown) => console.error('[liame] ação da tela falhou', erro));
}
