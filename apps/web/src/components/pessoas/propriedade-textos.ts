import type { MemberResponse, OwnershipResponse } from '@liame/contracts';
import { NIVEIS } from '@/lib/niveis';

// As frases da propriedade da conta em Pessoas e acessos (P34 aprovado; A7, W8, parte 3; D-A7-59 a D-A7-61). Quem
// decide é o servidor (`propriedade.service.ts`); aqui só se mostra e se evita pedir o que ele recusaria.

/**
 * O que passa para a dona nova (P34). No pedido, dito ao Dono (`quem` = o primeiro nome de quem recebe: "o e-mail de
 * Ana", "inclusive você"); no aceite, a quem recebe (`quem` nulo: "o seu e-mail"). O nome evita supor o gênero.
 */
export function oQuePassa(quem: string | null): string[] {
  return [
    'transferir a propriedade e encerrar a conta',
    `a cobrança: a assinatura, o plano, as faturas e o PIX do mês, que passam a ir para ${quem ? `o e-mail de ${quem}` : 'o seu e-mail'}`,
    `quem tem acesso: convidar, mudar o nível e tirar qualquer pessoa${quem ? ', inclusive você' : ''}`,
    'liberar a cobrança a outro Administrador',
  ];
}

/** O que continua como está (P34). */
export const CONTINUA = [
  'a assinatura e o plano, sem cobrança nova',
  'as contas conectadas e a equipe de IA',
  'as aprovações em andamento',
  'o registro de tudo o que cada pessoa fez',
];

/** O primeiro nome, para as frases curtas. */
export const primeiroNome = (nome: string) => nome.split(/\s+/)[0] || nome;

/** Por que uma pessoa não pode receber a propriedade (nulo: pode). A mesma regra do servidor (D-A7-59). */
export function motivoDeNaoPoder(m: Pick<MemberResponse, 'user_id' | 'role' | 'mfa_enabled' | 'partner'>, podem: ReadonlySet<string>): string | null {
  if (podem.has(m.user_id)) return null;
  if (m.partner) return `Vem de ${m.partner.agency_name}: a conta é sempre do dono do negócio.`;
  if (m.role !== 'administrador') return `É ${NIVEIS[m.role]?.nome ?? m.role}. Só um Administrador recebe: mude o nível em Alterar acesso antes.`;
  if (!m.mfa_enabled) return 'Ainda não entra com o app autenticador.';
  return 'Não pode receber agora.';
}

/** A situação do cartão da propriedade, para quem é o Dono. */
export function situacaoDoDono(p: OwnershipResponse, agora = new Date()): 'pedido' | 'espera' | 'pode' {
  if (p.pending) return 'pedido';
  if (p.can_transfer_from && new Date(p.can_transfer_from).getTime() > agora.getTime()) return 'espera';
  return 'pode';
}

/** O que o Dono antigo vira, dito para quem lê o pedido. */
export function depoisDoAceite(fica: boolean, empresa: string): string {
  return fica ? 'Administrador, sem a cobrança' : `Sai da ${empresa}`;
}

/** A mesma coisa numa frase: "você fica como Administrador, sem a cobrança" ou "Paulo sai da Mister Burgers". */
export function fraseDepoisDoAceite(quem: string, fica: boolean, empresa: string): string {
  return fica ? `${quem} fica como Administrador, sem a cobrança` : `${quem} sai da ${empresa}`;
}
