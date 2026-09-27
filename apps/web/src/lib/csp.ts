// Content Security Policy do web (blindagem; decisão do dono em 27/09/2026).
// - Telas de entrada (públicas): pré-renderizadas pelo Cache Components (ADR-001). Sem nonce possível,
//   os scripts inline do React/Next só passam com 'unsafe-inline' (testado: sem ele a hidratação quebra).
// - Todo o resto (app logado e qualquer rota nova): renderizado a cada acesso, com nonce novo por
//   requisição e 'strict-dynamic'; sem 'unsafe-inline' nos scripts. O script do tema (no layout raiz,
//   comum às duas) entra pelo hash do texto.
// Sem dependência de Node: este módulo roda no next.config e no proxy.

/** Rotas públicas (grupo `(entrada)`): as únicas com a CSP das páginas pré-renderizadas. */
export const ROTAS_PUBLICAS = [
  '/entrar',
  '/criar-conta',
  '/confirmar-email',
  '/esqueci-a-senha',
  '/redefinir-senha',
  '/segundo-fator',
  '/segundo-fator/ativar',
  '/convite',
] as const;

export function ehRotaPublica(caminho: string): boolean {
  const limpo = caminho.length > 1 ? caminho.replace(/\/+$/, '') : caminho;
  return (ROTAS_PUBLICAS as readonly string[]).includes(limpo);
}

type Base = { isDev: boolean; api: string };

function diretivas({ isDev, api }: Base, scriptSrc: string): string {
  return [
    "default-src 'self'",
    scriptSrc,
    // Atributos style do React: não executam código.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${api}${isDev ? ' ws:' : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** Telas de entrada (pré-renderizadas). No desenvolvimento, o React usa eval para mostrar os erros. */
export function cspPublica(base: Base): string {
  return diretivas(base, `script-src 'self' 'unsafe-inline'${base.isDev ? " 'unsafe-eval'" : ''}`);
}

/** Demais rotas: nonce da requisição, 'strict-dynamic' e o hash do script do tema. */
export function cspComNonce(base: Base & { nonce: string; hashTema: string }): string {
  return diretivas(base, `script-src 'self' 'nonce-${base.nonce}' 'strict-dynamic' ${base.hashTema}${base.isDev ? " 'unsafe-eval'" : ''}`);
}

/** `'sha256-…'` de um script inline (Web Crypto: vale no Node e no proxy). */
export async function hashDeScript(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
}
