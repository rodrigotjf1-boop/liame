import type { RoleKey } from '@liame/contracts';

// Permissões finas (ADR-013): a rota declara a permissão, nunca o nome do papel.
// Os níveis são os do acesso delegado (ADR-017). O conjunto é estático nesta fase; papel editável
// por empresa entra quando houver necessidade (ADR-013), sem mudar as rotas.
export const PERMISSIONS = [
  'empresa.ver',
  'empresa.editar',
  'marcas.ver',
  'marcas.gerenciar',
  'pessoas.ver',
  'pessoas.convidar',
  'pessoas.remover',
  'pessoas.alterar_nivel',
  'cobranca.ver',
  'cobranca.gerenciar',
  'auditoria.ver',
  'acoes.aprovar',
  'campanhas.ver',
  'campanhas.operar',
  'relatorios.ver',
  'agentes.gerenciar',
  'parada.acionar',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<RoleKey, ReadonlySet<Permission>> = {
  dono: ALL,
  administrador: new Set<Permission>([
    'empresa.ver',
    'empresa.editar',
    'marcas.ver',
    'marcas.gerenciar',
    'pessoas.ver',
    'pessoas.convidar',
    'pessoas.remover',
    'pessoas.alterar_nivel',
    'auditoria.ver',
    'acoes.aprovar',
    'campanhas.ver',
    'campanhas.operar',
    'relatorios.ver',
    'agentes.gerenciar',
    'parada.acionar',
  ]),
  gestor: new Set<Permission>([
    'empresa.ver',
    'marcas.ver',
    'pessoas.ver',
    'acoes.aprovar',
    'campanhas.ver',
    'campanhas.operar',
    'relatorios.ver',
    'agentes.gerenciar',
    'parada.acionar',
  ]),
  aprovador: new Set<Permission>(['empresa.ver', 'marcas.ver', 'acoes.aprovar', 'campanhas.ver', 'relatorios.ver']),
  somente_leitura: new Set<Permission>(['empresa.ver', 'marcas.ver', 'campanhas.ver', 'relatorios.ver']),
  // Só recebe o resumo por e-mail: não entra na conta (ADR-017).
  so_relatorios: new Set<Permission>(),
};

/** Níveis que mexem em dinheiro ou em pessoas: segundo fator obrigatório (ADR-013, ADR-017). */
export const MFA_REQUIRED: ReadonlySet<RoleKey> = new Set<RoleKey>(['dono', 'administrador', 'gestor', 'aprovador']);

/** Ordem de poder: ninguém concede um nível acima do próprio (ADR-017). */
export const ROLE_RANK: Record<RoleKey, number> = {
  dono: 100,
  administrador: 80,
  gestor: 60,
  aprovador: 40,
  somente_leitura: 20,
  so_relatorios: 10,
};

export function hasPermission(role: RoleKey, permission: string): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission as Permission) ?? false;
}

export function isKnownPermission(permission: string): permission is Permission {
  return ALL.has(permission as Permission);
}
