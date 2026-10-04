import type { ActionResponse, PlanSummary } from '@liame/contracts';
import { grupoDoPlano } from './planos-textos';
import { type Grupo, grupoDe } from './textos';

// A lista de Aprovações junta dois tipos de pedido (protótipo P8): as ações que alguém pediu e os planos do
// Estrategista. A fila de quem decide é uma só: o que expira primeiro vem primeiro, seja ação ou plano.

export type ItemDaLista =
  | { chave: string; tipo: 'acao'; grupo: Grupo; acao: ActionResponse; expira: string; mexido: string }
  | { chave: string; tipo: 'plano'; grupo: Grupo; plano: PlanSummary; expira: string; mexido: string };

export const chaveDaAcao = (id: string) => `a:${id}`;
export const chaveDoPlano = (id: string) => `p:${id}`;

/** Os pedidos e os planos nos grupos da lista: o que espera decisão, o que a política fez sozinha e o decidido hoje. */
export function montarLista(acoes: ActionResponse[], planos: PlanSummary[], agora: Date): Record<Grupo, ItemDaLista[]> {
  const grupos: Record<Grupo, ItemDaLista[]> = { pendente: [], auto: [], feito: [] };
  for (const acao of acoes) {
    const grupo = grupoDe(acao, agora);
    if (grupo) grupos[grupo].push({ chave: chaveDaAcao(acao.id), tipo: 'acao', grupo, acao, expira: acao.expires_at, mexido: acao.updated_at });
  }
  for (const plano of planos) {
    const grupo = grupoDoPlano(plano, agora);
    // O plano que expirou conta pelo dia em que expirou (ninguém mexeu nele).
    if (grupo) grupos[grupo].push({ chave: chaveDoPlano(plano.id), tipo: 'plano', grupo, plano, expira: plano.expires_at, mexido: plano.status === 'expirado' ? plano.expires_at : plano.updated_at });
  }
  // As datas chegam em ISO de mesmo formato: comparar o texto é comparar o instante.
  grupos.pendente.sort((x, y) => x.expira.localeCompare(y.expira));
  for (const g of ['auto', 'feito'] as const) grupos[g].sort((x, y) => y.mexido.localeCompare(x.mexido));
  return grupos;
}

/** Quantos pedidos esperam a decisão de quem está vendo: as ações só para quem aprova ações, os planos só para quem decide planos. */
export function pendentesDe(grupos: Record<Grupo, ItemDaLista[]>, podeAprovarAcoes: boolean, podeDecidirPlanos: boolean): number {
  return grupos.pendente.filter((i) => (i.tipo === 'acao' ? podeAprovarAcoes : podeDecidirPlanos)).length;
}
