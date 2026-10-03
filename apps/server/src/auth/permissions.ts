import type { RoleKey } from '@liame/contracts';

// Permissões finas (ADR-013): a rota declara a permissão, nunca o nome do papel.
// Aqui fica o VOCABULÁRIO (o app não sobe se uma rota pedir permissão fora dele). O que cada papel
// pode é dado: `liame.role_permission` (migration 0006), com o padrão do Liame e, quando houver,
// o conjunto próprio da empresa. A ordem dos níveis e a exigência do app autenticador são do produto.
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
  'webhooks.gerenciar',
  'politicas.gerenciar',
  'orcamento.gerenciar',
  'empresa.encerrar',
  'empresa.exportar',
  'contas.ver',
  'contas.conectar',
  // Ciclo fechado (A2.5, migration 0023).
  'vendas.ver',
  'atribuicao.gerenciar',
  'links.gerenciar',
  'cupons.criar',
  // Minha marca: o dossiê da marca (A3, I8, migration 0033).
  'dossie.ver',
  'dossie.editar',
  // Conversa com a LIA e demandas (A3, I10, migration 0034).
  'conversa.usar',
  'demanda.abrir',
  // Planos do Estrategista (A3, I11, migration 0035).
  'planos.ver',
  'planos.decidir',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = new Set<Permission>(PERMISSIONS);

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

export function isKnownPermission(permission: string): permission is Permission {
  return ALL.has(permission as Permission);
}
