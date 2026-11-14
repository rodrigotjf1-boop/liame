import type { ActionResponse, AttentionItem, CreativeTestResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemAviso } from '@/components/atencao/item-aviso';
import {
  andamentoDoTeste,
  descontoDoTeste,
  diaDoTeste,
  ehPedidoDoTeste,
  idDoTeste,
  linhasDoTeste,
  pausaDoPerdedor,
  pct,
  dicaDoEncerrar,
  podeEncerrar,
  proximaOlhada,
  rotulosDoEncerrar,
  publicoDoTeste,
  sinalDaVisita,
  situacaoDoTeste,
  tituloDoPedidoDoTeste,
  vereditoDoTeste,
} from '@/components/aprovacoes/teste-textos';
import { apresentar } from '@/components/aprovacoes/textos';
import { acaoDoAviso, destinoDoRitmo, destinoDoTeste } from '@/components/atencao/textos';

// Plano da região, R8 (protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-80): os avisos do teste de criativo
// na Atenção e o teste em Aprovações, sem servidor. Na Atenção, o botão leva ao teste em Aprovações, só para quem
// recebeu o pedido dele (o "Precisa de você" do Resumo usa o mesmo destino). Em Aprovações: o pedido, a situação, o
// veredito de cada olhada (D-RG-91), os dois criativos lado a lado, o pedido de pausar o que perdeu (D-RG-80) e encerrar.

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

const TESTE: CreativeTestResponse = {
  id: ID,
  brand_id: ID,
  unit_id: ID,
  name: 'Combo sexta: a foto ou a outra',
  status: 'rodando',
  active: true,
  arms: [
    { letter: 'A', piece_id: ID, piece_version: 1, media_id: ID, title: 'Sexta é dia de combo', ad_text: 'Smash, batata e refri.\n\nCupom SEXTAFOTO: 10% de desconto.', coupon_code: 'SEXTAFOTO', coupon_status: 'criado', meta: { adset_id: '1', ad_id: '2' } },
    { letter: 'B', piece_id: ID, piece_version: 1, media_id: ID, title: 'Combo sexta por R$ 34,90', ad_text: 'Smash na chapa.\n\nCupom SEXTAOUTRA: 10% de desconto.', coupon_code: 'SEXTAOUTRA', coupon_status: 'criado', meta: { adset_id: '3', ad_id: '4' } },
  ],
  discount: { kind: 'percentual', percent: 10, value_cents: null, min_order_cents: 0, valid_until: '2026-12-29' },
  radius_km: 3,
  districts: null,
  daily_budget_micros: 40_000_000,
  min_days: 7,
  max_days: 28,
  link: 'https://cardapio.exemplo.com.br/mister-centro',
  action_id: PEDIDO,
  pending_action_id: null,
  started_on: '2026-11-02',
  ended_on: null,
  error: null,
  reason: null,
  result: null,
  loser_pause: null,
  meta: { account_id: 'act_1', campaign_id: '9' },
  created_at: '2026-11-01T12:00:00.000Z',
};
const resultado = (verdict: 'ainda_nao' | 'venceu' | 'sem_vencedor', winner: 'A' | 'B' | null, looks: Array<[number, number, number, number]>): CreativeTestResponse['result'] => ({
  looks: looks.map(([day, orders_a, orders_b, chance]) => ({ day, orders_a, orders_b, chance })),
  verdict,
  winner,
  arms: [
    { letter: 'A', orders: looks.at(-1)![1], revenue_micros: looks.at(-1)![1] * 42_000_000, spend_micros: 280_000_000, link_clicks: 400 },
    { letter: 'B', orders: looks.at(-1)![2], revenue_micros: looks.at(-1)![2] * 42_000_000, spend_micros: 280_000_000, link_clicks: 350 },
  ],
});

// O valor em reais na tela leva um espaço que não quebra depois de "R$" (`lib/formato.ts`): os textos abaixo também.
describe('o teste de criativo em Aprovações (R8)', () => {
  it('os três pedidos do teste abrem a mesma tela, pelo id do teste no recurso; a linha da lista diz o que cada um faz', () => {
    expect(['teste_de_criativo_criar', 'teste_de_criativo_ativar', 'teste_de_criativo_pausar', 'cupom_do_teste', 'conjunto_pausar'].map((tool) => ehPedidoDoTeste({ tool }))).toEqual([true, true, true, false, false]);
    expect(idDoTeste(`teste_de_criativo:${ID}`)).toBe(ID);
    expect([idDoTeste(`ritmo:${ID}`), idDoTeste('teste_de_criativo:nao-e-id')]).toEqual([null, null]);
    expect(tituloDoPedidoDoTeste('teste_de_criativo_criar', 'Combo sexta')).toBe('Teste de criativo: Combo sexta');
    expect(tituloDoPedidoDoTeste('teste_de_criativo_ativar', 'Combo sexta')).toBe('Ativar o teste “Combo sexta”');
    expect(tituloDoPedidoDoTeste('teste_de_criativo_pausar', null)).toBe('Encerrar o teste de criativo');
    const pedido = (tool: string) => ({ tool, account_name: 'CA - Mister Burgers', requested_by: { id: ID, name: 'Rodrigo' }, value_micros: 40_000_000, params: {} }) as unknown as ActionResponse;
    expect(apresentar(pedido('teste_de_criativo_criar')).titulo).toBe('Teste de criativo em CA - Mister Burgers, criado pausado');
    expect(apresentar(pedido('teste_de_criativo_ativar'))).toMatchObject({ titulo: 'Ativar o teste de criativo em CA - Mister Burgers', impacto: 'R$ 40,00/dia' });
    // A ativação não tem "Desfazer": a volta é encerrar o teste.
    expect(apresentar(pedido('teste_de_criativo_ativar')).desfazer).toContain('Encerrar o teste');
    expect(apresentar(pedido('teste_de_criativo_pausar')).titulo).toBe('Encerrar o teste de criativo em CA - Mister Burgers');
  });

  it('a situação, quem vê, o desconto e o dia do teste', () => {
    expect(situacaoDoTeste({ ...TESTE, status: 'pedido' })).toEqual({ rotulo: 'Espera a aprovação', tom: 'aguardando' });
    expect(situacaoDoTeste({ ...TESTE, status: 'pronto', pending_action_id: PEDIDO })).toEqual({ rotulo: 'Ativação pedida', tom: 'aguardando' });
    expect(situacaoDoTeste({ ...TESTE, status: 'terminado', result: resultado('venceu', 'B', [[14, 9, 45, 0.000001]]) }).rotulo).toBe('O criativo B venceu');
    expect(situacaoDoTeste({ ...TESTE, status: 'interrompido' })).toEqual({ rotulo: 'Interrompido', tom: 'perigo' });
    expect(publicoDoTeste(TESTE)).toBe('o raio de 3 km em volta da loja');
    expect(publicoDoTeste({ radius_km: null, districts: [{ code: '1', name: 'Centro', meta: true, radius_km: 1 }, { code: '2', name: 'Lapa', meta: true, radius_km: 1 }, { code: '3', name: 'Glória', meta: false, radius_km: 1.5 }] })).toBe('os 3 bairros Centro, Lapa e Glória');
    // Nada de "na primeira compra": o cupom do teste não tem essa regra.
    expect(descontoDoTeste(TESTE.discount)).toBe('10% de desconto');
    expect(descontoDoTeste({ kind: 'valor', percent: null, value_cents: 500, min_order_cents: 3000, valid_until: '2026-12-29' })).toBe('R$ 5,00 de desconto em pedidos a partir de R$ 30,00');
    expect([diaDoTeste(TESTE, '2026-11-01'), diaDoTeste(TESTE, '2026-11-02'), diaDoTeste(TESTE, '2026-11-10')]).toEqual([null, 1, 9]);
    expect(andamentoDoTeste(TESTE, '2026-11-10')).toBe('Os dois criativos estão no ar desde 02/11. Hoje é o dia 9 de no máximo 28; o teste segue sozinho, e a Atenção avisa quando ele acabar.');
    expect(andamentoDoTeste({ ...TESTE, status: 'cancelado', error: 'A Meta recusou o anúncio.' }, '2026-11-10')).toBe('A campanha de teste não foi criada: A Meta recusou o anúncio.');
  });

  it('o veredito de cada olhada (D-RG-91): antes do dia 7, ainda não; abaixo de 1,82%, o vencedor; no dia 28, sem vencedor', () => {
    expect(vereditoDoTeste(TESTE)).toEqual({ titulo: 'Ainda não dá para dizer', texto: 'O Liame olha pela primeira vez no fim do dia 7 (08/11), com a semana inteira. Antes disso, não há vencedor.', venceu: false });
    expect(proximaOlhada(TESTE)).toEqual({ dia: 7, data: '08/11' });
    const semana1 = { ...TESTE, result: resultado('ainda_nao', null, [[7, 11, 7, 0.48]]) };
    expect(vereditoDoTeste(semana1)?.texto).toBe(
      'Na olhada do dia 7: 11 pedidos do criativo A contra 7 do B. Uma diferença assim aparece por acaso em 48% das vezes; o Liame só dá um vencedor quando essa chance fica abaixo de 1,82% numa olhada.',
    );
    expect(proximaOlhada(semana1)).toEqual({ dia: 14, data: '15/11' });
    const venceu = { ...TESTE, status: 'terminado' as const, result: resultado('venceu', 'B', [[7, 5, 9, 0.42], [14, 9, 45, 0.000001]]) };
    expect(vereditoDoTeste(venceu)).toEqual({
      titulo: 'O criativo B venceu',
      texto: 'Combo sexta por R$ 34,90: 45 pedidos no caixa contra 9, com a mesma verba, em 14 dias. A chance de uma diferença assim aparecer por acaso é de menos de 0,1% (o Liame só dá um vencedor abaixo de 1,82% em cada olhada).',
      venceu: true,
    });
    const empate = { ...TESTE, status: 'terminado' as const, result: resultado('sem_vencedor', null, [[28, 24, 21, 0.766]]) };
    expect(vereditoDoTeste(empate)?.titulo).toBe('O teste acabou sem vencedor');
    expect(proximaOlhada({ ...TESTE, result: resultado('ainda_nao', null, [[7, 1, 1, 1], [14, 1, 1, 1], [21, 1, 1, 1], [28, 1, 1, 1]]) })).toBeNull();
    expect([pct(0.48), pct(0.023), pct(0.0182), pct(0.0004)]).toEqual(['48%', '2,3%', '1,8%', 'menos de 0,1%']);
  });

  it('a tabela dos dois criativos e o sinal da visita mais barata (não é prova)', () => {
    const t = { ...TESTE, status: 'terminado' as const, result: resultado('sem_vencedor', null, [[28, 24, 21, 0.766]]) };
    const linhas = linhasDoTeste(t);
    expect(linhas.map((l) => l.rotulo)).toEqual(['Gasto', 'Visitas ao cardápio', 'Pedidos no caixa', 'Receita no caixa', 'Custo por pedido']);
    expect(linhas[1]!.valores.A).toEqual({ texto: '400', sub: 'R$ 0,70 por visita', forte: false });
    expect(linhas[2]!.valores).toEqual({ A: { texto: '24', sub: null, forte: true }, B: { texto: '21', sub: null, forte: true } });
    expect(linhas[4]!.valores.B.texto).toBe('R$ 13,33');
    expect(sinalDaVisita(t)).toBe('Pelo sinal (não é prova): o criativo A traz a visita mais barata, R$ 0,70 contra R$ 0,80 por visita. Você pode ficar com os dois, ou testar outra coisa (a oferta, o texto).');
    // Sem a leitura da Meta, o gasto fica em branco, com o motivo; a tabela não aparece antes da primeira olhada.
    const semGasto = { ...t, result: { ...t.result!, arms: t.result!.arms.map((a) => ({ ...a, spend_micros: null, link_clicks: null })) } };
    expect(linhasDoTeste(semGasto)[0]!.valores.A).toEqual({ texto: '—', sub: 'ainda sem a leitura da Meta', forte: false });
    expect(sinalDaVisita(semGasto)).toBeNull();
    expect(linhasDoTeste(TESTE)).toEqual([]);
  });

  it('pausar o criativo que perdeu (D-RG-80): só no teste com vencedor e com a campanha no ar; o pedido em aberto e o feito', () => {
    const venceu = { ...TESTE, status: 'terminado' as const, result: resultado('venceu', 'A', [[14, 45, 9, 0.000001]]) };
    expect(pausaDoPerdedor(venceu)).toMatchObject({ tipo: 'pedir', perdeu: 'B', venceu: 'A' });
    expect((pausaDoPerdedor(venceu) as { dica: string }).dica).toContain('O criativo A segue com a verba dele, R$ 20,00 por dia');
    expect(pausaDoPerdedor({ ...venceu, loser_pause: { action_id: PEDIDO, status: 'aguardando_aprovacao' } })).toEqual({
      tipo: 'esperando',
      perdeu: 'B',
      actionId: PEDIDO,
      texto: 'O pedido para pausar o criativo B espera a decisão em Aprovações.',
    });
    expect(pausaDoPerdedor({ ...venceu, loser_pause: { action_id: PEDIDO, status: 'executada' } })).toMatchObject({ tipo: 'feito', texto: 'O criativo B foi pausado. O criativo A segue no ar com a verba dele, R$ 20,00 por dia.' });
    // O pedido recusado deixa pedir de novo, dizendo que o anterior não foi feito.
    expect((pausaDoPerdedor({ ...venceu, loser_pause: { action_id: PEDIDO, status: 'cancelada' } }) as { dica: string }).dica).toContain('O pedido anterior não foi feito (foi recusado ou cancelado).');
    expect(pausaDoPerdedor({ ...venceu, active: false })).toEqual({ tipo: 'nenhum' });
    expect(pausaDoPerdedor({ ...TESTE, status: 'terminado', result: resultado('sem_vencedor', null, [[28, 24, 21, 0.7]]) })).toEqual({ tipo: 'nenhum' });
    expect(pausaDoPerdedor(TESTE)).toEqual({ tipo: 'nenhum' });
  });

  it('encerrar: do teste pronto ao terminado ainda no ar; nunca antes de existir na Meta nem depois de encerrado', () => {
    expect(['pedido', 'criando', 'pronto', 'rodando', 'encerrado', 'cancelado'].map((status) => podeEncerrar({ status: status as CreativeTestResponse['status'], active: status === 'rodando' }))).toEqual([false, false, true, true, false, false]);
    expect([podeEncerrar({ status: 'terminado', active: true }), podeEncerrar({ status: 'terminado', active: false }), podeEncerrar({ status: 'interrompido', active: true })]).toEqual([true, false, true]);
    // Antes da hora, encerrar pausa a campanha de teste; depois do fim, não mexe na Meta (D-RG-95).
    expect(rotulosDoEncerrar({ status: 'rodando' })).toEqual({ botao: 'Encerrar o teste', confirmar: 'Encerrar o teste agora' });
    expect(dicaDoEncerrar({ status: 'rodando', active: true })).toContain('pausa a campanha de teste');
    expect(rotulosDoEncerrar({ status: 'terminado' })).toEqual({ botao: 'Encerrar o teste sem mudar nada', confirmar: 'Encerrar sem mudar nada' });
    expect(dicaDoEncerrar({ status: 'terminado', active: true })).toContain('encerrar não mexe na Meta. A campanha de teste continua no ar e gastando com os dois criativos');
    expect(andamentoDoTeste({ ...TESTE, status: 'encerrado', active: true }, '2026-11-30')).toContain('encerrado sem mudar nada na Meta');
    expect(andamentoDoTeste({ ...TESTE, status: 'encerrado', active: false }, '2026-11-30')).toContain('a campanha de teste está pausada');
  });
});
