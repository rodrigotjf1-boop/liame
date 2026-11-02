import type { OwnershipClaim } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { motivosDaPropriedade, pedidoAnda, podePedir, situacaoDoPedido } from '../src/components/pessoas/propriedade-dms-textos';

// O pedido da propriedade à DMS quando o Dono não está mais (A7, W8, parte 6b; P34 aprovado; D-A7-63): os motivos com o
// nome do Dono, a situação do pedido no cartão e quando o caminho "Pedir a propriedade à DMS" aparece.

const base: OwnershipClaim = {
  id: 'c1',
  protocol: 'PROP-2026-0007',
  status: 'pedido',
  reason: 'saiu_da_sociedade',
  note: null,
  requester: { user_id: 'u2', name: 'Ana Lima' },
  owner_name: 'Rodrigo Teixeira',
  documents: ['documento_com_foto', 'documento_da_empresa'],
  created_at: '2026-11-02T12:00:00Z',
  sent_at: '2026-11-02T12:05:00Z',
  checked_at: null,
  decide_from: null,
  contested_at: null,
  refusal_reason: null,
  closed_at: null,
};

describe('o pedido da propriedade à DMS', () => {
  it('os três motivos do P34, com o nome do Dono', () => {
    expect(motivosDaPropriedade('Rodrigo').map((m) => [m.valor, m.titulo])).toEqual([
      ['saiu_da_sociedade', 'Rodrigo saiu da sociedade'],
      ['faleceu', 'Rodrigo faleceu'],
      ['perdeu_acesso', 'Rodrigo perdeu o e-mail e o celular'],
    ]);
  });

  it('a situação do pedido no cartão de quem pediu', () => {
    expect(situacaoDoPedido({ ...base, status: 'rascunho' }, 'Rodrigo').texto).toBe('Falta mandar os documentos e enviar.');
    expect(situacaoDoPedido(base, 'Rodrigo')).toEqual({
      rotulo: 'Pedido à DMS em análise',
      texto: 'Protocolo PROP-2026-0007. A DMS confere os documentos e marca a videochamada pelo seu e-mail.',
    });
    const espera = situacaoDoPedido({ ...base, status: 'conferido', checked_at: '2026-11-03T12:00:00Z', decide_from: '2026-11-17T12:00:00Z' }, 'Rodrigo');
    expect(espera.texto).toMatch(/^Protocolo PROP-2026-0007\. Avisamos Rodrigo no e-mail; a decisão sai a partir de \d{2}\/\d{2}\/\d{4}\.$/);
    expect(situacaoDoPedido({ ...base, status: 'contestado' }, 'Rodrigo').rotulo).toBe('Rodrigo respondeu');
    expect(situacaoDoPedido({ ...base, status: 'recusado', refusal_reason: 'O contrato não mostra a Ana.' }, 'Rodrigo').texto).toBe(
      'Protocolo PROP-2026-0007. O contrato não mostra a Ana.',
    );
  });

  it('o pedido anda (rascunho incluído) e o caminho aparece só para quem pode pedir', () => {
    for (const s of ['rascunho', 'pedido', 'conferido', 'contestado'] as const) expect(pedidoAnda({ ...base, status: s })).toBe(true);
    for (const s of ['aprovado', 'recusado', 'cancelado'] as const) expect(pedidoAnda({ ...base, status: s })).toBe(false);
    expect(pedidoAnda(null)).toBe(false);
    expect(podePedir(null)).toBe(false);
    expect(podePedir({ claim: null, mine: false, about_me: false, cannot_claim: null })).toBe(true);
    expect(podePedir({ claim: null, mine: false, about_me: false, cannot_claim: 'nao-e-administrador' })).toBe(false);
  });
});
