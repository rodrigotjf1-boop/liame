import type { AppConfig } from '../../config.js';
import { ClienteDmsId } from './integracao-dms.js';

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
