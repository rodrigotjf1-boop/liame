import type { OwnershipClaim, OwnershipClaimReason, OwnershipClaimResponse } from '@liame/contracts';
import { dataCompleta } from '@/lib/formato';

// As frases do pedido da propriedade à DMS quando o Dono não está mais (P34 aprovado; A7, W8, parte 6b; D-A7-63,
// D-A7-64). Quem decide é o servidor (`propriedade-pela-dms.service.ts`): aqui só se mostra e se evita pedir o que ele
// recusaria.

/** O que aconteceu com o Dono, como a gaveta pergunta (o nome é o primeiro nome do Dono). */
export function motivosDaPropriedade(nome: string): readonly { valor: OwnershipClaimReason; titulo: string; texto: string }[] {
  return [
    { valor: 'saiu_da_sociedade', titulo: `${nome} saiu da sociedade`, texto: 'A empresa mudou de sócios, e ninguém responde para transferir.' },
    { valor: 'faleceu', titulo: `${nome} faleceu`, texto: 'A DMS trata o pedido com cuidado e fala com quem representa a empresa.' },
    { valor: 'perdeu_acesso', titulo: `${nome} perdeu o e-mail e o celular`, texto: 'Sem o e-mail, não dá para pedir a recuperação pela entrada.' },
  ];
}

/** O pedido ainda anda (rascunho incluído). */
export const pedidoAnda = (c: OwnershipClaim | null): boolean => c !== null && ['rascunho', 'pedido', 'conferido', 'contestado'].includes(c.status);

/** A situação do pedido de quem pediu, no cartão "A propriedade da conta". */
export function situacaoDoPedido(c: OwnershipClaim, dono: string): { rotulo: string; texto: string } {
  switch (c.status) {
    case 'rascunho':
      return { rotulo: 'Pedido à DMS começado', texto: 'Falta mandar os documentos e enviar.' };
    case 'pedido':
      return { rotulo: 'Pedido à DMS em análise', texto: `Protocolo ${c.protocol}. A DMS confere os documentos e marca a videochamada pelo seu e-mail.` };
    case 'conferido':
      return {
        rotulo: 'Pedido à DMS em espera',
        texto: `Protocolo ${c.protocol}. Avisamos ${dono} no e-mail; a decisão sai a partir de ${c.decide_from ? dataCompleta(c.decide_from) : ''}.`,
      };
    case 'contestado':
      return { rotulo: `${dono} respondeu`, texto: `Protocolo ${c.protocol}. ${dono} respondeu que ainda cuida da conta; a DMS fala com os dois antes de decidir.` };
    case 'aprovado':
      return { rotulo: 'Pedido aprovado', texto: `Protocolo ${c.protocol}. A DMS aprovou: você é a dona da conta.` };
    case 'recusado':
      return { rotulo: 'Pedido recusado pela DMS', texto: `Protocolo ${c.protocol}. ${c.refusal_reason ?? ''}` };
    case 'cancelado':
      return { rotulo: 'Pedido cancelado', texto: `Protocolo ${c.protocol}. Você desistiu do pedido; nada mudou.` };
  }
}

/** Mostrar o caminho "Pedir a propriedade à DMS" no cartão: só para quem pode pedir agora. */
export const podePedir = (r: OwnershipClaimResponse | null): boolean => r !== null && r.cannot_claim === null;
