import type { RoleKey } from '@liame/contracts';

// Níveis de acesso como o dono os vê (ADR-017; textos do protótipo aprovado). Quem decide é o servidor:
// aqui só se escondem ou desabilitam as opções que ele recusaria.

export const NIVEIS: Record<RoleKey, { nome: string; desc: string; chip: string }> = {
  dono: { nome: 'Dono', desc: 'Único que transfere a propriedade, muda a cobrança e exclui a conta.', chip: 'dono' },
  administrador: {
    nome: 'Administrador',
    desc: 'Cuida de tudo por você: campanhas, equipe, aprovações até o limite e pessoas (menos o dono). Não mexe na propriedade da conta.',
    chip: 'admin',
  },
  gestor: { nome: 'Gestor', desc: 'Opera campanhas e aprova até o limite. Não convida nem remove pessoas.', chip: 'gestor' },
  aprovador: { nome: 'Aprovador', desc: 'Aprova ou recusa o que a equipe propõe, até o limite. Não altera campanhas.', chip: 'aprovador' },
  somente_leitura: { nome: 'Somente leitura', desc: 'Vê resultados e relatórios. Não aprova nem altera nada.', chip: 'leitura' },
  so_relatorios: { nome: 'Só relatórios por e-mail', desc: 'Recebe o resumo da semana por e-mail. Não entra na conta.', chip: 'email' },
};

/** Ordem de poder, a mesma do servidor (auth/permissions.ts): ninguém concede acima do próprio nível. */
export const RANK: Record<RoleKey, number> = {
  dono: 100,
  administrador: 80,
  gestor: 60,
  aprovador: 40,
  somente_leitura: 20,
  so_relatorios: 10,
};

export type NivelConvidavel = Exclude<RoleKey, 'dono'>;
export const CONVIDAVEIS: NivelConvidavel[] = ['administrador', 'gestor', 'aprovador', 'somente_leitura', 'so_relatorios'];

/** Níveis que aprovam gasto e, por isso, têm limite por ação. */
export const APROVAM = new Set<RoleKey>(['administrador', 'gestor', 'aprovador']);

/** Níveis que só usam a conta com o app autenticador ativo (ADR-013). */
export const EXIGEM_APP = new Set<RoleKey>(['dono', 'administrador', 'gestor', 'aprovador']);
