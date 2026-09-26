import { ActionProposal, type PolicyDecision } from '@liame/contracts';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, SetMetadata } from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { RequestWithAuth } from '../auth/access.js';
import { currentTx, requestStore } from '../context/request-context.js';
import { AppProblem, issuesToErrors, ValidationProblem } from '../errors/problems.js';
import { PolicyService } from './policy.service.js';

// ABAC por política (ADR-013): a rota declara a ação e de onde tirar a proposta; o motor decide
// antes do handler, na transação da requisição. Negou → 422 com cada regra; permitiu → o handler
// lê a decisão (o modo de autonomia) com `currentPolicyDecision()`.
export const POLICY_KEY = 'liame:politica';

export interface PolicyDeclaration {
  action: string;
  /** Monta a proposta a partir da requisição (corpo, parâmetros). A ação vem da declaração. */
  proposal: (req: { body?: unknown; params?: Record<string, string> }) => Record<string, unknown>;
}

export const Politica = (action: string, proposal: PolicyDeclaration['proposal']) =>
  SetMetadata(POLICY_KEY, { action, proposal } satisfies PolicyDeclaration);

const decisions = new WeakMap<object, PolicyDecision>();

/** A decisão da política para a requisição atual (rotas com `@Politica`). */
export function currentPolicyDecision(): PolicyDecision {
  const store = requestStore.getStore();
  const decision = store ? decisions.get(store) : undefined;
  if (!decision) throw new Error('sem decisão de política: a rota não declara @Politica');
  return decision;
}

@Injectable()
export class PolicyInterceptor implements NestInterceptor {
  constructor(private readonly policies: PolicyService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const declaration = Reflect.getMetadata(POLICY_KEY, ctx.getHandler()) as PolicyDeclaration | undefined;
    if (!declaration) return next.handle();
    return from(this.run(ctx, declaration, next));
  }

  private async run(ctx: ExecutionContext, declaration: PolicyDeclaration, next: CallHandler): Promise<unknown> {
    const req = ctx.switchToHttp().getRequest<RequestWithAuth & { body?: unknown; params?: Record<string, string> }>();
    const auth = req.auth;
    const store = requestStore.getStore();
    // Roda dentro da unidade de trabalho (registrada antes): sem ela, é erro de montagem.
    if (!auth?.tenantId || !store) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    const parsed = ActionProposal.safeParse({ ...declaration.proposal(req), action: declaration.action });
    if (!parsed.success) throw new ValidationProblem(issuesToErrors(parsed.error.issues));
    const decision = await this.policies.evaluate(currentTx(), auth.tenantId, parsed.data);
    if (!decision.allowed) {
      throw new AppProblem(
        422,
        'politica-negou',
        'A política não permite',
        'Esta ação fere uma regra da política da empresa ou da plataforma.',
        {},
        decision.violations.map((v) => ({ path: `politica.${v.source}.${v.rule_index}`, message: v.message })),
      );
    }
    decisions.set(store, decision);
    return lastValueFrom(next.handle(), { defaultValue: undefined });
  }
}
