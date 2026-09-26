import type { InvitationResponse, MemberResponse } from '@liame/contracts';
import { dataCompleta, dia, moeda, vencimento } from '@/lib/formato';
import { APROVAM, NIVEIS } from '@/lib/niveis';

// Frases da lista de "Pessoas e acessos", do jeito do protótipo aprovado.

/** O que a pessoa pode fazer, em uma linha. `souDono` troca "você" por "o dono" para quem não é o dono. */
export function detalhesDe(p: MemberResponse, souDono: boolean): string {
  if (p.role === 'dono') return NIVEIS.dono.desc;
  const quem = souDono ? 'você também aprova' : 'o dono também aprova';
  const partes: string[] = [];
  if (APROVAM.has(p.role)) {
    if (p.approve_limit_micros === null) partes.push('aprova sem limite');
    else if (p.approve_limit_micros > 0)
      partes.push(`aprova sozinho até ${moeda(p.approve_limit_micros)} por ação${p.dual_approval ? `; acima disso, ${quem}` : ''}`);
    else partes.push(souDono ? 'todo gasto passa também por você' : 'todo gasto passa também pelo dono');
  }
  if (p.billing_access) partes.push('vê e paga a cobrança');
  partes.push(p.expires_at ? `acesso até ${dataCompleta(p.expires_at)}` : 'sem prazo');
  return partes.join(' · ');
}

export function envioDe(c: InvitationResponse): string {
  const quando = dia(c.created_at);
  return `Convite enviado ${quando === 'hoje' ? 'hoje' : `em ${quando}`} · ${vencimento(c.expires_at)}`;
}

export function contagem(pessoas: number, convites: number): string {
  const p = `${pessoas} ${pessoas === 1 ? 'pessoa' : 'pessoas'}`;
  if (!convites) return `${p}.`;
  return `${p} e ${convites} ${convites === 1 ? 'convite esperando resposta' : 'convites esperando resposta'}.`;
}
