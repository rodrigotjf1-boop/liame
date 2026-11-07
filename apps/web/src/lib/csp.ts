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
  '/confirmar-resposta',
  '/esqueci-a-senha',
  '/redefinir-senha',
  '/segundo-fator',
  '/segundo-fator/ativar',
  '/segundo-fator/recuperacao',
  '/convite',
] as const;

export function ehRotaPublica(caminho: string): boolean {
  const limpo = caminho.length > 1 ? caminho.replace(/\/+$/, '') : caminho;
  return (ROTAS_PUBLICAS as readonly string[]).includes(limpo);
}

/** `imagens`: a origem das fotos dos produtos (o bucket do S3; ADR-021), só nas telas do app. */
type Base = { isDev: boolean; api: string; imagens?: string | null };

const NOME_DO_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REGIAO = /^[a-z]{2}-[a-z]+-\d$/;
const ENDERECO_LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;

/**
 * A origem das fotos dos produtos (A6 · Z4; ADR-021): o bucket privado do S3, que a tela lê por endereço assinado de 5
 * minutos. O nome do bucket tem o número da conta: vem do ambiente quando o servidor do web sobe (`IMAGENS_BUCKET`, o
 * mesmo da API), nunca do repositório. Sem o bucket, ou com o nome fora do formato, nenhuma origem a mais. A região é a
 * da API (São Paulo, se não vier).
 * O S3 local do roteiro de navegador do vídeo (A6 · Z10; `IMAGENS_S3_ENDPOINT`, o mesmo da API) só vale com a API
 * também nesta máquina (`api` em localhost): o roteiro roda o build de produção do web, e em produção a API é a pública.
 */
export function origemDasImagens(ambiente: Readonly<Record<string, string | undefined>>, api = ''): string | null {
  // A expressão é ancorada, sem repetição aninhada (tempo linear), e os dois textos passam antes pelo teto de 64
  // caracteres (ERR-040, V41).
  const curto = (s: string) => s.length <= 64;
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
  const local = (ambiente['IMAGENS_S3_ENDPOINT'] ?? '').trim();
  if (local && curto(api) && ENDERECO_LOCAL.test(api)) return curto(local) && ENDERECO_LOCAL.test(local) ? local : null;
  const bucket = (ambiente['IMAGENS_BUCKET'] ?? '').trim();
  const regiao = (ambiente['AWS_REGION'] ?? '').trim() || 'sa-east-1';
  if (!NOME_DO_BUCKET.test(bucket) || !REGIAO.test(regiao)) return null;
  return `https://${bucket}.s3.${regiao}.amazonaws.com`;
}

/**
 * As miniaturas de "Do seu Instagram" (A6 · Z10, parte 5b; D-A6-83): a imagem que o Instagram serve, no endereço da
 * própria Meta (nada é guardado no Liame). Só imagem, só nas telas do app.
 */
export const IMAGENS_DA_META = ['https://*.cdninstagram.com', 'https://*.fbcdn.net'] as const;

function diretivas({ isDev, api, imagens }: Base, scriptSrc: string, imagemDaApi = false): string {
  return [
    "default-src 'self'",
    scriptSrc,
    // Atributos style do React: não executam código.
    "style-src 'self' 'unsafe-inline'",
    // A API só entra no img-src das telas do app: o logo público da agência no relatório do dono (A7, W7, parte 5a); e
    // as miniaturas do Instagram, no endereço da Meta ("Do seu Instagram").
    `img-src 'self' blob: data:${imagemDaApi ? ` ${api} ${IMAGENS_DA_META.join(' ')}` : ''}${imagens ? ` ${imagens}` : ''}`,
    // O vídeo das Fotos (A6 · Z10): toca do bucket (endereço assinado) e, antes do envio, do próprio arquivo (`blob:`).
    `media-src 'self' blob:${imagens ? ` ${imagens}` : ''}`,
    "font-src 'self'",
    // O vídeo vai do navegador direto ao bucket (o endereço de envio assinado), sem passar pela API.
    `connect-src 'self' ${api}${imagens ? ` ${imagens}` : ''}${isDev ? ' ws:' : ''}`,
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
  return diretivas(base, `script-src 'self' 'nonce-${base.nonce}' 'strict-dynamic' ${base.hashTema}${base.isDev ? " 'unsafe-eval'" : ''}`, true);
}

/** `'sha256-…'` de um script inline (Web Crypto: vale no Node e no proxy). */
export async function hashDeScript(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
}
