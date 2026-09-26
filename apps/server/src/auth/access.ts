import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthContext } from '../context/request-context.js';

// Toda rota declara quem pode chamá-la (ADR-003 regra 7, ADR-013). Sem declaração, o app não sobe.
export const ACCESS_KEY = 'liame:acesso';

export type Access =
  | { kind: 'publico' }
  | { kind: 'autenticado'; beforeMfa?: boolean }
  | { kind: 'permissao'; permissions: string[] };

/** Rota aberta: health, login, cadastro. Precisa ser explícito. */
export const Publico = () => SetMetadata(ACCESS_KEY, { kind: 'publico' } satisfies Access);

/**
 * Qualquer pessoa com sessão válida, sem exigir empresa ativa (ex.: `GET /v1/me`). Quem tem app autenticador só
 * passa depois de verificar o código, exceto nas rotas `antesDoSegundoFator` (ver quem sou, verificar, sair).
 */
export const Autenticado = (options: { antesDoSegundoFator?: boolean } = {}) =>
  SetMetadata(ACCESS_KEY, { kind: 'autenticado', beforeMfa: options.antesDoSegundoFator ?? false } satisfies Access);

/** Permissão fina na empresa ativa (ADR-013): `@Permissao('pessoas.convidar')`. */
export const Permissao = (...permissions: string[]) =>
  SetMetadata(ACCESS_KEY, { kind: 'permissao', permissions } satisfies Access);

export interface RequestWithAuth {
  auth?: AuthContext;
}

/** O `AuthContext` resolvido pelo guard. */
export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<RequestWithAuth>().auth;
  if (!auth) throw new Error('rota sem AuthContext: faltou @Autenticado ou @Permissao');
  return auth;
});
