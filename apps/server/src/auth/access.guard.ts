import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { AppProblem } from '../errors/problems.js';
import { ACCESS_KEY, type Access, DURING_CLOSURE_KEY, type RequestWithAuth } from './access.js';
import { MFA_REQUIRED } from './permissions.js';
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

    // Quem tem app autenticador precisa verificar o código antes de usar a conta (ADR-013).
    if (auth.mfaConfigured && !auth.mfaVerifiedAt && !(access.kind === 'autenticado' && access.beforeMfa)) {
      throw new AppProblem(401, 'segundo-fator-necessario', 'Digite o código do app', 'Confirme o acesso com o código do app autenticador.');
    }

    if (access.kind === 'permissao') {
      if (!auth.tenantId || !auth.roleKey) {
        throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
      }
      // Níveis que mexem em dinheiro ou em pessoas só entram com o app autenticador ativo (ADR-013, ADR-017).
      if (MFA_REQUIRED.has(auth.roleKey) && !auth.mfaConfigured) {
        throw new AppProblem(
          403,
          'segundo-fator-nao-configurado',
          'Ative o app autenticador',
          'Seu nível de acesso exige o segundo fator. Configure o app para continuar.',
        );
      }
      const missing = access.permissions.filter((p) => !auth.permissions.has(p));
      if (missing.length) {
        throw new AppProblem(403, 'sem-permissao', 'Sem permissão', `Falta a permissão: ${missing.join(', ')}.`);
      }
      // Empresa em encerramento: 30 dias de graça só para ler, exportar e reativar (ADR-014).
      const closing = auth.tenantStatus !== null && auth.tenantStatus !== 'ativa';
      const allowed = this.reflector.getAllAndOverride<boolean | undefined>(DURING_CLOSURE_KEY, [ctx.getHandler(), ctx.getClass()]);
      if (closing && MUTATIONS.has(req.method.toUpperCase()) && !allowed) {
        throw new AppProblem(403, 'empresa-em-encerramento', 'Conta em encerramento', 'A conta está encerrando: dá para ver, exportar os dados e reativar, mas não mudar nada.');
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
