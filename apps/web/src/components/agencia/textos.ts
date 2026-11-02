import type { AgencyClientResponse, AgencyMemberResponse, AgencyRequestResponse, AgencyRole, PartnerRole } from '@liame/contracts';
import { dataDe } from '@/components/equipe/textos';
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

/** O acesso de quem é da agência neste cliente (o membro, P27): "Seu acesso: Gestor · aprova sozinho até R$ 500 por ação". */
export function seuAcesso(a: NonNullable<AgencyClientResponse['my_access']>): string {
  const nivel = `Seu acesso: ${NIVEIS[a.role].nome}`;
  if (!APROVAM.has(a.role)) return nivel;
  return `${nivel} · ${a.approve_limit_micros === null ? 'aprova sem limite' : `aprova sozinho até ${moeda(a.approve_limit_micros)} por ação`}`;
}

export type AvisoDoCliente = { tom: 'ok' | 'atencao' | 'perigo' | 'info'; icone: 'check-circle' | 'clock' | 'plug' | 'lock' | 'info'; texto: string };

/**
 * O que pede atenção num cliente (P27; A7, W7, parte 2; D-A7-52), do que o servidor mandou: ele já tirou o que o nível da
 * pessoa ali não deixa ver. A empresa inteira suspensa vem sozinha. Um tipo que esta tela ainda não conhece fica de
 * fora (a lista cresce; ERR-015).
 */
export function avisosDoCliente(c: Pick<AgencyClientResponse, 'attention'>, escolheQuemEntra: boolean): AvisoDoCliente[] {
  const avisos: AvisoDoCliente[] = [];
  for (const a of c.attention ?? []) {
    const n = a.count ?? 0;
    const dono = a.owner_name ?? 'o dono';
    if (a.kind === 'suspensa') {
      avisos.push({ tom: 'perigo', icone: 'lock', texto: `A conta está suspensa${a.since ? ` desde ${dataDe(a.since)}` : ''}: só o dono entra. Fale com ${dono}.` });
    } else if (a.kind === 'marca_suspensa') {
      const marcas = n === 1 ? 'Uma marca está suspensa' : `${n} marcas estão suspensas`;
      avisos.push({ tom: 'perigo', icone: 'lock', texto: `${marcas}${a.since ? ` desde ${dataDe(a.since)}` : ''}: só o dono entra ${n === 1 ? 'nela' : 'nelas'}. Fale com ${dono}.` });
    } else if (a.kind === 'aprovacoes' && n > 0) {
      avisos.push({ tom: 'atencao', icone: 'clock', texto: `${n} ${n === 1 ? 'aprovação esperando' : 'aprovações esperando'} você` });
    } else if (a.kind === 'conta_desconectada' && n > 0) {
      const contas = n === 1 ? 'Uma conta perdeu o acesso' : `${n} contas perderam o acesso`;
      avisos.push({ tom: 'atencao', icone: 'plug', texto: `${contas}: reconecte em Contas conectadas.` });
    } else if (a.kind === 'fora_do_time') {
      avisos.push({
        tom: 'info',
        icone: 'info',
        texto: escolheQuemEntra
          ? 'Você não está no time desta empresa. Coloque-se em "Escolher quem entra" para ver o que pede atenção.'
          : 'Você não está no time desta empresa.',
      });
    } else if (a.kind === 'em_dia') {
      avisos.push({ tom: 'ok', icone: 'check-circle', texto: 'Tudo em dia: nada esperando você.' });
    }
  }
  return avisos;
}

/** A empresa inteira suspensa: ninguém da agência entra (D-A7-40), então "Abrir a empresa" some. */
export function empresaFechada(c: Pick<AgencyClientResponse, 'attention'>): boolean {
  return (c.attention ?? []).some((a) => a.kind === 'suspensa');
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
