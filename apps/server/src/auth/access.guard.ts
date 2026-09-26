import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AppProblem } from '../errors/problems.js';
import { ACCESS_KEY, type Access, type RequestWithAuth } from './access.js';
import { hasPermission } from './permissions.js';
import { readCookie, SESSION_COOKIE, SessionService } from './session.service.js';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface GuardRequest extends RequestWithAuth {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Guard global que nega por padrão (ADR-003 regra 7, ADR-013): rota sem declaração não passa;
 * rota não pública exige sessão válida; `@Permissao` exige empresa ativa e a permissão no papel.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!access) {
      throw new AppProblem(403, 'rota-sem-declaracao', 'Sem permissão', 'Esta rota não declara quem pode usá-la.');
    }
    const req = ctx.switchToHttp().getRequest<GuardRequest>();
    this.checkOrigin(req);
    if (access.kind === 'publico') return true;

    const cookie = req.headers.cookie;
    const token = readCookie(typeof cookie === 'string' ? cookie : undefined, SESSION_COOKIE);
    const auth = token ? await this.sessions.resolve(token) : null;
    if (!auth) throw new AppProblem(401, 'nao-autenticado', 'Entre de novo', 'A sessão acabou ou não foi enviada.');
    req.auth = auth;

    if (access.kind === 'permissao') {
      if (!auth.tenantId || !auth.roleKey) {
        throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
      }
      const missing = access.permissions.filter((p) => !hasPermission(auth.roleKey!, p));
      if (missing.length) {
        throw new AppProblem(403, 'sem-permissao', 'Sem permissão', `Falta a permissão: ${missing.join(', ')}.`);
      }
    }
    return true;
  }

  /** Mutação vinda de navegador precisa vir de uma origem conhecida (defesa contra CSRF, além do SameSite). */
  private checkOrigin(req: GuardRequest): void {
    if (!MUTATIONS.has(req.method.toUpperCase())) return;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && !this.config.allowedOrigins.has(origin)) {
      throw new AppProblem(403, 'origem-nao-permitida', 'Origem não permitida', 'Esta operação só pode ser feita pelo app do Liame.');
    }
  }
}
