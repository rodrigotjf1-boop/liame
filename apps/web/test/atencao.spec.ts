import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemAviso } from '@/components/atencao/item-aviso';
import { acaoDoAviso, avisosFalados, contadorDoMenu, contagemPorGravidade, destinoDoAviso, gravidadeDe, juntarAvisos, oQueFazer, rotuloDoFiltro } from '@/components/atencao/textos';
import { itemAtual, rotaPessoal, tituloDa } from '@/components/shell/navegacao';

// Regras puras de "Atenção de mídia" (gravidade, contagens, texto do "o que fazer") e do menu.

describe('atenção de mídia', () => {
  const itens = [{ severity: 'critica' }, { severity: 'critica' }, { severity: 'atencao' }, { severity: 'info' }, { severity: 'nova_gravidade' }];

  it('gravidade desconhecida cai em informação (a lista cresce na API, V23)', () => {
    expect(gravidadeDe('critica')).toBe('critica');
    expect(gravidadeDe('atencao')).toBe('atencao');
    expect(gravidadeDe('nova_gravidade')).toBe('info');
  });

  it('contagens dos filtros e o número do menu (informação não conta)', () => {
    expect(contagemPorGravidade(itens)).toEqual({ todas: 5, critica: 2, atencao: 1, info: 2 });
    expect(contadorDoMenu(itens)).toBe(3);
    expect(contadorDoMenu([])).toBe(0);
    expect(avisosFalados(1)).toBe(', 1 aviso');
    expect(avisosFalados(5)).toBe(', 5 avisos');
    expect([rotuloDoFiltro('todas'), rotuloDoFiltro('critica'), rotuloDoFiltro('atencao'), rotuloDoFiltro('info')]).toEqual([
      'Todos',
      'Críticos',
      'Atenção',
      'Informação',
    ]);
  });

  it('"o que fazer" continua a frase em minúscula, sem mexer em sigla ou nome próprio', () => {
    expect(oQueFazer('Conecte o Meta Ads de novo em Contas conectadas.')).toBe('conecte o Meta Ads de novo em Contas conectadas.');
    expect(oQueFazer('Os números desta conta podem não refletir hoje.')).toBe('os números desta conta podem não refletir hoje.');
    expect(oQueFazer('GA4 sem dados de ontem.')).toBe('GA4 sem dados de ontem.');
    expect(oQueFazer('Liame atualiza a integração.')).toBe('Liame atualiza a integração.');
  });

  it('botão de cada aviso, como no protótipo', () => {
    expect(acaoDoAviso('conta_desconectada')).toBe('abrir-contas');
    expect(acaoDoAviso('reconectar_em_breve')).toBe('reconectar');
    expect(acaoDoAviso('gasto_fora_do_normal')).toBeNull();
    expect(acaoDoAviso('tipo_novo')).toBeNull();
  });

  it('avisos do ciclo fechado (F9): cada tipo leva à tela onde se resolve', () => {
    expect(acaoDoAviso('vendas_nao_conectadas')).toBe('abrir-contas');
    expect([acaoDoAviso('anuncio_sem_rastreio'), acaoDoAviso('plataforma_nao_informada')]).toEqual(['abrir-links', 'abrir-links']);
    expect([acaoDoAviso('campanha_sem_cupom'), acaoDoAviso('cupom_sem_uso')]).toEqual(['abrir-cupons', 'abrir-cupons']);
    expect(['campanha_sem_pedido', 'margem_desconhecida', 'plataforma_x_caixa', 'vendas_nao_medidas'].map(acaoDoAviso)).toEqual(Array(4).fill('abrir-resultados'));
    expect(destinoDoAviso('abrir-links')).toEqual({ href: '/links', rotulo: 'Abrir Links e cupons' });
    expect(destinoDoAviso('abrir-cupons')).toEqual({ href: '/links#cupons', rotulo: 'Abrir os cupons' });
    expect(destinoDoAviso('abrir-resultados')).toEqual({ href: '/resultados', rotulo: 'Abrir Resultados' });
    expect(destinoDoAviso('abrir-contas')).toBeNull();
    expect(destinoDoAviso('reconectar')).toBeNull();
  });

  it('fora do normal (A3, I6): vendas, gasto da campanha e custo por pedido se conferem em Resultados', () => {
    expect(['vendas_fora_do_normal', 'gasto_da_campanha_fora_do_normal', 'custo_por_pedido_fora_do_normal'].map(acaoDoAviso)).toEqual(Array(3).fill('abrir-resultados'));
    // O gasto da conta (aviso de mídia, da A2) segue sem botão, como no protótipo.
    expect(acaoDoAviso('gasto_fora_do_normal')).toBeNull();
  });

  it('mídia e ciclo fechado numa lista só: mais grave primeiro e, na mesma gravidade, os de mídia antes', () => {
    const midia = [{ severity: 'critica', kind: 'm1' }, { severity: 'atencao', kind: 'm2' }, { severity: 'info', kind: 'm3' }];
    const ciclo = [{ severity: 'critica', kind: 'c1' }, { severity: 'atencao', kind: 'c2' }, { severity: 'gravidade_nova', kind: 'c3' }];
    expect(juntarAvisos(midia, ciclo).map((i) => i.kind)).toEqual(['m1', 'c1', 'm2', 'c2', 'm3', 'c3']);
    expect(juntarAvisos(midia, [])).toEqual(midia);
    expect(contadorDoMenu(juntarAvisos(midia, ciclo))).toBe(4);
  });

  it('cartão do aviso do ciclo fechado: a etiqueta do Regem e o botão da tela, só para quem vê as vendas', () => {
    const aviso = (o: Partial<AttentionItem>): AttentionItem => ({
      kind: 'campanha_sem_cupom',
      severity: 'atencao',
      title: '6 campanhas ativas sem cupom exclusivo',
      detail: 'Os anúncios levam ao Anota AI, e o clique não chega ao pedido: as vendas delas ficam sem origem.',
      action: 'Crie na plataforma de pedidos um cupom para cada campanha e informe o código em Links e cupons.',
      connected_account_id: null,
      campaign_id: null,
      provider: null,
      ...o,
    });
    const cartao = (item: AttentionItem, podeVerVendas = true) =>
      renderToStaticMarkup(createElement(ItemAviso, { item, podeVerContas: true, podeConectar: true, podeVerVendas, aoReconectar: () => {} }));
    const cupom = cartao(aviso({}));
    expect(cupom).toContain('6 campanhas ativas sem cupom exclusivo');
    expect(cupom).toContain('<b>O que fazer:</b> crie na plataforma de pedidos um cupom');
    expect(cupom).toContain('href="/links#cupons"');
    expect(cupom).toContain('Abrir os cupons');
    expect(cartao(aviso({}), false)).not.toContain('href=');
    const atrasado = cartao(aviso({ kind: 'dado_atrasado', provider: 'regem', title: 'As vendas da Loja Centro estão atrasadas' }));
    expect(atrasado).toContain('>Regem<');
    expect(atrasado).not.toContain('href=');
    expect(cartao(aviso({ kind: 'conta_desconectada', severity: 'critica', provider: 'regem' }))).toContain('href="/contas"');
    expect(cartao(aviso({ kind: 'margem_desconhecida' }))).toContain('href="/resultados"');
  });
});

describe('menu', () => {
  it('título da tela, item atual e telas da própria pessoa', () => {
    expect(tituloDa('/atencao')).toBe('Atenção de mídia');
    expect(tituloDa('/contas')).toBe('Contas conectadas');
    expect(tituloDa('/seguranca')).toBe('Segurança da conta');
    expect(tituloDa('/outra')).toBe('Liame');
    expect(itemAtual('/contas/algo', '/contas')).toBe(true);
    expect(itemAtual('/contasx', '/contas')).toBe(false);
    expect(rotaPessoal('/seguranca')).toBe(true);
    expect(rotaPessoal('/contas')).toBe(false);
  });
});
