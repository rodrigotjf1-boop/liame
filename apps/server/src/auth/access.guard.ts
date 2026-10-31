import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { AuthContext } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { ACCESS_KEY, type Access, DURING_CLOSURE_KEY, DURING_SUSPENSION_KEY, OPEN_DURING_SUSPENSION_KEY, type RequestWithAuth } from './access.js';
import { MFA_REQUIRED } from './permissions.js';
import { readCookie, SESSION_COOKIE, SessionService } from './session.service.js';

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** A função da cobrança (`FLAG_COBRANCA` de `cobranca/assinatura.ts`): desligada, a suspensão não trava ninguém. */
const FLAG_DA_COBRANCA = 'cobranca';
/** A marca no caminho: `/v1/brands/<id>/...` (arquivar, reativar). */
const MARCA_NO_CAMINHO = /\/brands\/([0-9a-f-]{36})(?:[/?#]|$)/i;

interface GuardRequest extends RequestWithAuth {
  method: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
}

/** As marcas que o pedido nomeia: `brand_id` na query ou no corpo, e a marca no caminho. */
function marcasDoPedido(req: GuardRequest): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') out.push(v.toLowerCase());
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x.toLowerCase());
  };
  add(req.query?.brand_id);
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) add((req.body as Record<string, unknown>).brand_id);
  const caminho = req.url ? MARCA_NO_CAMINHO.exec(req.url) : null;
  if (caminho) add(caminho[1]);
  return out;
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
    private readonly modules: ModuleRef,
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
      // A marca suspensa no 30º dia de atraso (Termos 10.4; D-A7-6, D-A7-40): só o Dono entra, para pagar ou exportar.
      // A rota que diz quem resolve fica aberta a todos (D-A7-41).
      const aberta = this.reflector.getAllAndOverride<boolean | undefined>(OPEN_DURING_SUSPENSION_KEY, [ctx.getHandler(), ctx.getClass()]);
      if (!aberta && (await this.marcaSuspensa(req, auth))) {
        if (auth.roleKey !== 'dono') {
          throw new AppProblem(
            403,
            'marca-suspensa',
            'Conta suspensa',
            'A conta desta marca está suspensa por uma mensalidade em aberto: só o Dono entra, para pagar ou exportar os dados. Pagou, a equipe entra de novo na hora.',
          );
        }
        const pagar = this.reflector.getAllAndOverride<boolean | undefined>(DURING_SUSPENSION_KEY, [ctx.getHandler(), ctx.getClass()]);
        if (MUTATIONS.has(req.method.toUpperCase()) && !pagar) {
          throw new AppProblem(
            403,
            'marca-suspensa',
            'Conta suspensa',
            'A conta desta marca está suspensa por uma mensalidade em aberto: dá para pagar e exportar os dados, mas não mudar nada. Pagou, tudo volta na hora.',
          );
        }
      }
    }
    return true;
  }

  /**
   * O pedido é de uma marca suspensa: a marca que ele nomeia está suspensa, ou todas as marcas vivas da empresa estão
   * (aí vale para toda rota da empresa). Só com a função `cobranca` ligada: desligada, a situação gravada não trava
   * ninguém. A função só é lida quando há marca suspensa (o caso raro); o resto do pedido não paga nada a mais.
   */
  private async marcaSuspensa(req: GuardRequest, auth: AuthContext): Promise<boolean> {
    if (!auth.tenantId || auth.suspendedBrands.size === 0) return false;
    const alvo = auth.allBrandsSuspended ? [...auth.suspendedBrands] : marcasDoPedido(req).filter((b) => auth.suspendedBrands.has(b));
    if (!alvo.length) return false;
    const flags = this.flags();
    if (!flags) return false;
    for (const brandId of alvo) {
      if (await flags.isEnabled(FLAG_DA_COBRANCA, flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId }))) return true;
    }
    return false;
  }

  /** As funções ficam no módulo do app, não no de autenticação: lidas pelo contêiner inteiro (como o `setup.ts` faz). */
  private flags(): FlagService | null {
    try {
      return this.modules.get(FlagService, { strict: false });
    } catch {
      return null;
    }
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
