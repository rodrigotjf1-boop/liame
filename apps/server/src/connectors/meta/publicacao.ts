// A publicação na Meta (A6 · Z5; `base-conhecimento.md` §2.2, reconferida em 21/10/2026): as regras puras que o teste
// da D-A6-10 (`scripts/teste-foto-meta.ts`) usa e que o post de verdade vai usar. Sem rede e sem banco.

/**
 * A proporção que o post do feed do Instagram aceita (content publishing, 21/10/2026): de 4:5 (em pé) a 1,91:1 (deitada).
 * Fora disso, a Meta recusa o contêiner pela proporção, e o teste da foto não diria nada sobre o endereço.
 */
export const PROPORCAO_DO_INSTAGRAM = { minima: 4 / 5, maxima: 1.91 } as const;

export function cabeNoInstagram(largura: number, altura: number): boolean {
  if (!(largura > 0) || !(altura > 0)) return false;
  const p = largura / altura;
  return p >= PROPORCAO_DO_INSTAGRAM.minima && p <= PROPORCAO_DO_INSTAGRAM.maxima;
}

export type ContaDoInstagram = { paginaId: string; pagina: string; instagramId: string; usuario: string | null };

const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * A conta do Instagram ligada a uma Página, na resposta de `GET /me/accounts?fields=id,name,instagram_business_account{id,username}`:
 * a primeira Página que tem uma. Sem nenhuma, nulo (a autorização não incluiu o Instagram, ou ele não está ligado à Página).
 */
export function contaDoInstagram(resposta: unknown): ContaDoInstagram | null {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  for (const p of data as Array<Record<string, unknown>>) {
    const ig = p?.instagram_business_account as Record<string, unknown> | undefined;
    const paginaId = texto(p?.id);
    const instagramId = texto(ig?.id);
    if (paginaId && instagramId) return { paginaId, pagina: texto(p.name) ?? paginaId, instagramId, usuario: texto(ig?.username) };
  }
  return null;
}

/**
 * A permissão está concedida no token? Lê a resposta de `GET /me/permissions` (developers.facebook.com/docs/graph-api/
 * reference/user/permissions, lida em 28/10/2026): `data` com `permission` e `status` (`granted`, `declined` ou
 * `expired`). Só `granted` vale. É a Meta que diz: a troca do código da Meta não grava as permissões na conexão (a coluna
 * `scopes` fica vazia, ERR-179), e a pessoa pode desmarcar uma permissão na hora de autorizar.
 */
export function permissaoConcedida(resposta: unknown, permissao: string): boolean {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return false;
  return (data as Array<Record<string, unknown> | null>).some((p) => p?.permission === permissao && p?.status === 'granted');
}

/** O que o `debug_token` diz de uma permissão: concedida, ausente do token, ou o token não vale mais. */
export type PermissaoNoDebug = 'concedida' | 'ausente' | 'token_invalido';

/**
 * A permissão pela resposta de `GET /debug_token?input_token=…` (developers.facebook.com/docs/graph-api/reference/
 * debug_token, lida em 28/10/2026): `data.is_valid` e `data.scopes`, as permissões que a pessoa concedeu ao app no token.
 * É a conferência que a Meta documenta para qualquer token, com o token do app; a do `me/permissions` não diz se serve ao
 * token de usuário do sistema que o Facebook Login for Business entrega, então esta fica para quando aquela é recusada.
 */
export function permissaoNoDebug(resposta: unknown, permissao: string): PermissaoNoDebug {
  const d = (resposta as { data?: Record<string, unknown> | null } | null)?.data;
  if (!d || d.is_valid !== true) return 'token_invalido';
  return Array.isArray(d.scopes) && d.scopes.includes(permissao) ? 'concedida' : 'ausente';
}

/** A situação do contêiner (`status_code`): pronto para publicar, ainda processando, com erro, vencido ou já publicado. */
export type SituacaoDoConteiner = 'pronto' | 'processando' | 'erro' | 'vencido' | 'publicado' | 'desconhecida';

export function situacaoDoConteiner(statusCode: unknown): SituacaoDoConteiner {
  switch (statusCode) {
    case 'FINISHED':
      return 'pronto';
    case 'IN_PROGRESS':
      return 'processando';
    case 'ERROR':
      return 'erro';
    case 'EXPIRED':
      return 'vencido';
    case 'PUBLISHED':
      return 'publicado';
    default:
      return 'desconhecida';
  }
}

/**
 * O erro da Graph API em uma linha, para quem roda o teste: a mensagem, o código, o subcódigo e o texto que a Meta
 * escreve para a pessoa, quando vêm. Nunca leva o token (a Meta não o devolve no erro).
 */
export function erroDaMeta(corpo: unknown): string {
  const e = (corpo as { error?: Record<string, unknown> } | null)?.error;
  if (!e) return 'a Meta respondeu sem dizer o erro';
  const partes = [texto(e.message) ?? 'erro sem mensagem'];
  if (typeof e.code === 'number') partes.push(`código ${e.code}`);
  if (typeof e.error_subcode === 'number') partes.push(`subcódigo ${e.error_subcode}`);
  const paraPessoa = texto(e.error_user_msg);
  if (paraPessoa) partes.push(paraPessoa);
  return partes.join(' · ').slice(0, 500);
}
