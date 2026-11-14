import type { AttentionItem } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemAviso } from '@/components/atencao/item-aviso';
import { acaoDoAviso, destinoDoRitmo, destinoDoTeste } from '@/components/atencao/textos';

// Plano da região, R8 (protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-80): os avisos do teste de criativo
// na Atenção, sem servidor. O botão leva ao teste em Aprovações, só para quem recebeu o pedido dele (o "Precisa de
// você" do Resumo usa o mesmo destino).

const ID = '0190d2b0-0000-7000-8000-0000000000a1';
const PEDIDO = '0190d2b0-0000-7000-8000-0000000000b2';

describe('os avisos do teste de criativo na Atenção (R8)', () => {
  const aviso = (o: Partial<AttentionItem>): AttentionItem => ({
    kind: 'teste_com_vencedor',
    severity: 'atencao',
    title: 'O criativo A venceu o teste "Teste · Combo sexta"',
    detail: 'Em 14 dias, o criativo A trouxe 45 pedidos no caixa e o criativo B, 9 pedidos, com a mesma verba. A campanha de teste continua no ar com os dois: o Liame avisa e não pausa sozinho.',
    action: 'Veja o teste em Aprovações: de lá você pede para pausar o criativo B, ou encerra o teste.',
    connected_account_id: ID,
    campaign_id: null,
    provider: 'meta_ads',
    brand_id: ID,
    ...o,
  });
  const cartao = (item: AttentionItem) => renderToStaticMarkup(createElement(ItemAviso, { item, podeVerContas: true, podeConectar: true, podeVerVendas: false, aoReconectar: () => {} }));

  it('o botão leva ao teste em Aprovações, só para quem recebeu o pedido dele', () => {
    const comPedido = { id: ID, action_id: PEDIDO };
    for (const kind of ['teste_com_vencedor', 'teste_sem_vencedor', 'teste_interrompido']) {
      expect(destinoDoTeste(aviso({ kind, test: comPedido }))).toEqual({ href: `/aprovacoes?pedido=${PEDIDO}`, rotulo: 'Ver o teste em Aprovações', curto: 'Ver o teste' });
      // Os avisos do teste não têm outra tela onde se resolvem.
      expect(acaoDoAviso(kind)).toBeNull();
    }
    // Quem não vê os pedidos recebe o aviso sem o pedido: fica só o texto.
    expect(destinoDoTeste(aviso({ test: { id: ID, action_id: null } }))).toBeNull();
    expect(destinoDoTeste(aviso({}))).toBeNull();
    // Outro aviso nunca leva ao teste, mesmo que venha com o campo; e o aviso do teste não leva ao ritmo.
    expect(destinoDoTeste(aviso({ kind: 'ritmo_sem_volta', test: comPedido }))).toBeNull();
    expect(destinoDoRitmo(aviso({ test: comPedido, rhythm: comPedido }))).toBeNull();
  });

  it('o cartão: a etiqueta da Meta, o que fazer e o botão do teste', () => {
    const html = cartao(aviso({ test: { id: ID, action_id: PEDIDO } }));
    expect(html).toContain('O criativo A venceu o teste');
    expect(html).toContain('>Meta Ads<');
    expect(html).toContain('<b>O que fazer:</b> veja o teste em Aprovações: de lá você pede para pausar o criativo B, ou encerra o teste.');
    expect(html).toContain(`href="/aprovacoes?pedido=${PEDIDO}"`);
    expect(html).toContain('Ver o teste em Aprovações');
    expect(cartao(aviso({ test: { id: ID, action_id: null } }))).not.toContain('href=');
  });
});
