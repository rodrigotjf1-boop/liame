import type { AgencyClientResponse, AgencyMemberResponse, AgencyRequestResponse, AgencyRole, PartnerRole } from '@liame/contracts';
import { dia, moeda } from '@/lib/formato';
import { APROVAM, NIVEIS } from '@/lib/niveis';

// As frases das telas da agência (P27 aprovado; A7, W6, parte 5): Clientes, os pedidos, o time e quem entra em cada
// cliente. Quem decide é o servidor (`vinculo.service.ts`); aqui só se mostra e se evita pedir o que ele recusaria.

/** Os níveis que a agência pede ou dá ao time, do maior ao menor. */
export const NIVEIS_DA_AGENCIA: PartnerRole[] = ['administrador', 'gestor', 'aprovador', 'somente_leitura'];

/** O que cada papel faz na agência (P27). */
export const DESC_PAPEL: Record<AgencyRole, string> = {
  agencia_dona: 'Tudo na agência: pede acesso a clientes, convida o time, escolhe quem entra em cada cliente e fecha a conta da agência.',
  agencia_admin: 'Pede acesso a clientes, convida o time e escolhe quem entra em cada cliente.',
  agencia_membro: 'Trabalha só nos clientes em que for colocado.',
};

/** O nome curto do papel, como na tabela dos papéis do P27. */
export const PAPEL_CURTO: Record<AgencyRole, string> = { agencia_dona: 'Dona', agencia_admin: 'Administrador', agencia_membro: 'Membro' };

/** A situação de um pedido da agência: o texto, a cor e o rótulo (P27). */
export function situacaoDoPedido(p: AgencyRequestResponse, agora = new Date()): { texto: string; tom: 'aguardando' | 'perigo' | 'espera'; rotulo: string } {
  if (p.status === 'recusado') return { texto: `O dono não aceitou o pedido, em ${dia(p.decided_at ?? p.created_at, agora)}.`, tom: 'perigo', rotulo: 'Não aceito' };
  if (p.status === 'vencido') return { texto: `Venceu em ${dia(p.expires_at, agora)}, sem resposta.`, tom: 'espera', rotulo: 'Vencido' };
  const enviado = dia(p.created_at, agora);
  return {
    texto: `Enviado ${enviado === 'hoje' ? 'hoje' : `em ${enviado}`} · vale até ${dia(p.expires_at, agora)} · pede ${NIVEIS[p.requested_role].nome}`,
    tom: 'aguardando',
    rotulo: 'Esperando o dono',
  };
}

/** O que o dono deu à agência neste cliente: "A agência pode até Gestor · até R$ 500 por ação". */
export function acessoDaAgencia(c: Pick<AgencyClientResponse, 'max_role' | 'approve_limit_micros'>): string {
  const nivel = `A agência pode até ${NIVEIS[c.max_role].nome}`;
  if (!APROVAM.has(c.max_role)) return nivel;
  return `${nivel} · ${c.approve_limit_micros === null ? 'sem limite' : `até ${moeda(c.approve_limit_micros)} por ação`}`;
}

/** "Caio (Gestor), Bia (Aprovador)" ou "ninguém ainda". */
export function timeDoCliente(c: Pick<AgencyClientResponse, 'team'>): string {
  const time = c.team ?? [];
  if (!time.length) return 'ninguém ainda';
  return time.map((p) => `${p.name.split(/\s+/)[0]} (${NIVEIS[p.role].nome})`).join(', ');
}

/** O máximo do dono, dito na gaveta de quem entra (P27). */
export function maximoTxt(c: Pick<AgencyClientResponse, 'max_role' | 'approve_limit_micros'>): string {
  if (!APROVAM.has(c.max_role)) return `O dono deu à agência ${NIVEIS[c.max_role].nome}. Ninguém do time passa disso.`;
  const limite = c.approve_limit_micros === null ? 'sem limite' : `aprovando sozinho até ${moeda(c.approve_limit_micros)} por ação`;
  return `O dono deu à agência até ${NIVEIS[c.max_role].nome}, ${limite}. Ninguém do time passa disso.`;
}

/** A contagem do time: "4 pessoas e 1 convite esperando resposta." */
export function contagemDoTime(pessoas: number, convites: number): string {
  const p = `${pessoas} ${pessoas === 1 ? 'pessoa' : 'pessoas'}`;
  if (!convites) return `${p}.`;
  return `${p} e ${convites} ${convites === 1 ? 'convite esperando resposta' : 'convites esperando resposta'}.`;
}

/** Em que clientes cada pessoa do time está: "Clientes: Mister Burgers (Gestor)" ou "Em nenhum cliente ainda". */
export function clientesDaPessoa(m: Pick<AgencyMemberResponse, 'user_id'>, clientes: AgencyClientResponse[]): string {
  const onde = clientes
    .filter((c) => c.status === 'ativo')
    .flatMap((c) => (c.team ?? []).filter((p) => p.user_id === m.user_id).map((p) => `${c.organization.name} (${NIVEIS[p.role].nome})`));
  return onde.length ? `Clientes: ${onde.join(', ')}` : 'Em nenhum cliente ainda';
}
