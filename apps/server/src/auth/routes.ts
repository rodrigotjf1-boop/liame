import { type INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { API_PREFIX_EXCLUDE, API_PREFIX } from '../setup-constants.js';
import { AUDIT_KEY, type AuditDeclaration } from '../audit/auditar.js';
import { SEM_TRANSACAO_KEY, type SemTransacaoDeclaration } from '../context/sem-transacao.js';
import { ACCESS_KEY, type Access } from './access.js';
import { isKnownPermission } from './permissions.js';

export interface RouteInfo {
  method: string;
  path: string;
  access: Access | undefined;
  audit: AuditDeclaration | undefined;
  /** A rota roda fora da transação da requisição (`@SemTransacao`). */
  semTransacao: SemTransacaoDeclaration | undefined;
  handler: string;
}

const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/** Todas as rotas registradas, com o caminho final e a declaração de acesso (teste A1-4 e checagem na subida). */
export function listRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) continue;
    const bases = ([] as string[]).concat((Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined) ?? '');
    const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name] as object;
      const paths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (paths === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const access = reflector.getAllAndOverride<Access | undefined>(ACCESS_KEY, [handler as () => void, metatype]);
      const audit = reflector.getAllAndOverride<AuditDeclaration | undefined>(AUDIT_KEY, [handler as () => void, metatype]);
      // Só no método: é a mesma leitura que a unidade de trabalho faz.
      const semTransacao = Reflect.getMetadata(SEM_TRANSACAO_KEY, handler) as SemTransacaoDeclaration | undefined;
      for (const base of bases) {
        for (const p of ([] as string[]).concat(paths)) {
          const local = join(base, p);
          const path = API_PREFIX_EXCLUDE.includes(local.slice(1)) ? local : join(API_PREFIX, local);
          routes.push({ method, path, access, audit, semTransacao, handler: `${metatype.name}.${name}` });
        }
      }
    }
  }
  return routes;
}

/** Falha na subida se alguma rota não declarar acesso ou pedir permissão que não existe (fail-closed). */
export function assertAccessDeclarations(app: INestApplication): void {
  const problems: string[] = [];
  for (const route of listRoutes(app)) {
    if (!route.access) problems.push(`${route.method} ${route.path} (${route.handler}) sem @Publico, @Autenticado ou @Permissao`);
    else if (route.access.kind === 'permissao') {
      for (const p of route.access.permissions) {
        if (!isKnownPermission(p)) problems.push(`${route.method} ${route.path} pede a permissão desconhecida "${p}"`);
      }
    }
  }
  if (problems.length) throw new Error(`rotas sem declaração de acesso válida:\n- ${problems.join('\n- ')}`);
}

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ACTION = /^[a-z_]+\.[a-z_]+$/;

/** Falha na subida se alguma rota que muda dado não declarar @Auditar ou @SemAuditoria (A1-6). */
export function assertAuditDeclarations(app: INestApplication): void {
  const problems: string[] = [];
  for (const route of listRoutes(app)) {
    // Fora da transação da requisição não há auditoria automática, e o motivo fica escrito.
    if (route.semTransacao) {
      if (route.semTransacao.motivo.trim().length < 10) problems.push(`${route.method} ${route.path}: @SemTransacao precisa de um motivo`);
      if (route.audit?.kind === 'auditar' && !route.audit.manual) problems.push(`${route.method} ${route.path}: rota @SemTransacao só audita com manual: true (não há transação da requisição)`);
    }
    if (!MUTATIONS.has(route.method)) continue;
    if (!route.audit) problems.push(`${route.method} ${route.path} (${route.handler}) sem @Auditar ou @SemAuditoria`);
    else if (route.audit.kind === 'auditar' && !ACTION.test(route.audit.action)) {
      problems.push(`${route.method} ${route.path}: ação de auditoria "${route.audit.action}" fora do padrão recurso.verbo`);
    } else if (route.audit.kind === 'sem-auditoria' && route.audit.reason.trim().length < 10) {
      problems.push(`${route.method} ${route.path}: @SemAuditoria precisa de um motivo`);
    } else if (route.audit.kind === 'auditar' && !route.audit.manual && route.access?.kind === 'publico') {
      problems.push(`${route.method} ${route.path}: rota pública só audita com manual: true (não há transação da requisição)`);
    }
  }
  if (problems.length) throw new Error(`rotas sem declaração de auditoria válida:\n- ${problems.join('\n- ')}`);
}
