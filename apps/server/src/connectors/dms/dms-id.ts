import type { AppConfig } from '../../config.js';
import { ErroConector } from '../cliente-http.js';
import { ClienteDmsId, ErroDmsId } from './integracao-dms.js';

// O DMS ID do Hub DMS, do lado do Liame (F2): o cliente que pede o token do aplicativo do Liame (client credentials),
// guarda até perto de vencer e renova sozinho. O pacote comum (`integracao-dms.ts`, cópia igual à do hub) faz o
// pedido; aqui só se prende o endereço: o segredo do aplicativo vai para o `/token` do emissor configurado e para mais
// lugar nenhum, sem seguir redirecionamento (V33).

/** O recurso do RegemCast no DMS ID: o endereço da porta MCP, que é o `aud` dos tokens. */
export function recursoDoRegemcast(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/mcp`;
}

/** O cliente do DMS ID para o aplicativo do Liame, preso ao `/token` do emissor. */
export function clienteDoDmsId(dmsId: NonNullable<AppConfig['dmsId']>): ClienteDmsId {
  const permitido = `${dmsId.emissor}/token`;
  const buscar: typeof fetch = (entrada, init) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    if (url !== permitido) return Promise.reject(new Error('endereço fora do DMS ID'));
    return fetch(url, { ...init, redirect: 'error' });
  };
  return new ClienteDmsId({ emissor: dmsId.emissor, aplicativo: dmsId.aplicativo, segredo: dmsId.segredo, buscar });
}

/**
 * O token do DMS ID, com a falha do DMS ID como erro de conector (a tela e o worker já sabem tratar): o DMS ID que
 * recusa o aplicativo do Liame é recusa; o resto (fora do ar, sem resposta) é passageiro.
 */
export async function tokenDoDmsId(cliente: ClienteDmsId, recurso: string, permissoes: readonly string[]): Promise<string> {
  try {
    return await cliente.token(recurso, permissoes);
  } catch (err) {
    if (err instanceof ErroDmsId && (err.status === 400 || err.status === 401)) {
      throw new ErroConector('autenticacao', 'regemcast', `o DMS ID recusou o aplicativo do Liame (${err.codigo ?? err.status})`);
    }
    throw new ErroConector('transitorio', 'regemcast', `o DMS ID não respondeu: ${err instanceof Error ? err.name : 'erro'}`);
  }
}

/**
 * Chama o produto com o token do DMS ID; o token recusado (`token-invalido`: vencido, trocado no DMS ID) é esquecido e
 * pedido de novo, uma vez. O produto confere o token antes de olhar o corpo: nada do pedido é gasto nessa recusa.
 */
export async function comTokenDoDmsId<T>(cliente: ClienteDmsId, recurso: string, permissoes: readonly string[], chamar: (token: string) => Promise<T>): Promise<T> {
  try {
    return await chamar(await tokenDoDmsId(cliente, recurso, permissoes));
  } catch (err) {
    if (!(err instanceof ErroConector && err.tipo === 'autenticacao' && err.codigoProvider === 'token-invalido')) throw err;
    cliente.esquecer(recurso, permissoes);
    return chamar(await tokenDoDmsId(cliente, recurso, permissoes));
  }
}
