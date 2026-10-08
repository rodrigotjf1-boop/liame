import { describe, expect, it } from 'vitest';
import type { AttentionItem } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ItemAviso } from '@/components/atencao/item-aviso';
import {
  acaoDoAviso,
  AVISO_DE_DISPENSADA,
  avisosFalados,
  contadorDoMenu,
  contagemPorGravidade,
  destinoDoAviso,
  destinoPedeVendas,
  erroAoDispensar,
  gravidadeDe,
  juntarAvisos,
  oQueFazer,
  recomendacaoDoAviso,
  rotuloDoFiltro,
} from '@/components/atencao/textos';
import { itemAtual, rotaPessoal, tituloDa } from '@/components/shell/navegacao';
import { quandoComHora } from '@/lib/formato';

// Regras puras de "Atenção de mídia" (gravidade, contagens, texto do "o que fazer"), o cartão da recomendação do
// Gestor de tráfego (protótipo P9) e o menu.

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
    // O gasto acima da verba (A4, X4) se confere na Verba do mês, que é de quem acompanha as campanhas.
    expect(acaoDoAviso('gasto_acima_da_verba')).toBe('abrir-verba');
    expect(destinoDoAviso('abrir-verba')).toEqual({ href: '/verba', rotulo: 'Abrir a Verba do mês' });
    expect(['abrir-links', 'abrir-cupons', 'abrir-resultados'].map((a) => destinoPedeVendas(a as 'abrir-links'))).toEqual([true, true, true]);
    expect(destinoPedeVendas('abrir-verba')).toBe(false);
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
      brand_id: null,
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
    // O gasto acima da verba leva à Verba do mês, também para quem acompanha as campanhas sem ver as vendas.
    const gasto = aviso({ kind: 'gasto_acima_da_verba', provider: 'meta_ads', title: 'A campanha "Combo sexta" gastou mais do que a verba permite' });
    expect(cartao(gasto)).toContain('href="/verba"');
    expect(cartao(gasto)).toContain('Abrir a Verba do mês');
    expect(cartao(gasto, false)).toContain('href="/verba"');
  });
});

describe('a recomendação do Gestor de tráfego na Atenção (A4 · X8, protótipo P9)', () => {
  const AGORA = new Date('2026-09-29T17:40:00Z');
  const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [EU, OUTRA, REC, PEDIDO, CAMPANHA, CONTA] = [uuid(1), uuid(2), uuid(10), uuid(20), uuid(30), uuid(40)];
  type Rec = NonNullable<AttentionItem['recommendation']>;
  type Pedido = NonNullable<Rec['action']>;
  const pedir: Rec['request'] = { tool: 'orcamento_ajustar', provider: 'meta_ads', account_id: CONTA, resource_id: 'campanha:1202', params: { daily_budget_micros: 36_000_000 } };
  const sugestao = (rec: Partial<Rec> = {}, o: Partial<AttentionItem> = {}): AttentionItem => ({
    kind: 'sugestao_reduzir_verba',
    severity: 'atencao',
    title: 'Sugestão do Gestor de tráfego: reduzir a verba da campanha "Smash em dobro" em 10%',
    detail: 'Nos 7 dias até 28/09, ela gastou R$ 280,00 e deixou R$ 190,00 de margem conhecida no caixa: prejuízo. A verba diária iria de R$ 40,00 para R$ 36,00.',
    action: 'Se concordar, reduza a verba na Meta. Nada muda sem você.',
    connected_account_id: CONTA,
    campaign_id: CAMPANHA,
    provider: 'meta_ads',
    brand_id: null,
    recommendation: { id: REC, campaign_name: 'Smash em dobro', request: pedir, action: null, ...rec },
    ...o,
  });
  const pedido = (o: Partial<Pedido> = {}): Pedido => ({ id: PEDIDO, status: 'aguardando_aprovacao', created_at: '2026-09-29T09:31:00.000Z', agent_key: null, requested_by: EU, ...o });
  const modelo = (item: AttentionItem) => recomendacaoDoAviso(item, EU, AGORA)!;
  /** "hoje, às 06:31", no fuso de quem roda o teste. */
  const quando = (iso: string) => quandoComHora(iso, AGORA).replace(', ', ', às ');
  const cartao = (item: AttentionItem, o: { pedindo?: boolean; dispensando?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(ItemAviso, { item, podeVerContas: true, podeConectar: true, podeVerVendas: true, aoReconectar: () => {}, recomendacao: recomendacaoDoAviso(item, EU, AGORA), aoPedir: () => {}, aoDispensar: () => {}, ...o }),
    );

  it('só a sugestão do Gestor de tráfego tem recomendação; os outros avisos seguem como eram', () => {
    const { recommendation: _fora, ...comum } = sugestao({}, { kind: 'campanha_sem_cupom' });
    expect(recomendacaoDoAviso(comum, EU, AGORA)).toBeNull();
    expect(cartao(comum)).not.toContain('Gestor de tráfego ·');
  });

  it('aberta e com o pedido pronto: o título sem o prefixo, o que fazer e de onde a gaveta parte', () => {
    expect(modelo(sugestao())).toEqual({
      id: REC,
      titulo: 'Reduzir a verba da campanha "Smash em dobro" em 10%',
      modo: 'Sugerir',
      estado: { tipo: 'aberta', fazer: 'se concordar, peça a mudança. Ela ainda passa pela aprovação com o código do app, e a Meta confere antes.', nota: null },
      pedir: { campanha: { id: CAMPANHA, nome: 'Smash em dobro', provider: 'meta_ads' }, acao: 'verba', valorMicros: 36_000_000 },
    });
    // Pausar não tem valor: a gaveta abre na ação de pausar.
    const pausar = modelo(sugestao({ request: { ...pedir!, tool: 'campanha_pausar', params: {} } }, { kind: 'sugestao_pausar_campanha', title: 'Sugestão do Gestor de tráfego: pausar a campanha "Madrugada"' }));
    expect([pausar.titulo, pausar.pedir]).toEqual(['Pausar a campanha "Madrugada"', { campanha: { id: CAMPANHA, nome: 'Smash em dobro', provider: 'meta_ads' }, acao: 'pausar', valorMicros: null }]);
  });

  it('com um pedido dela andando: quem pediu, a situação e o modo do cartão', () => {
    expect(modelo(sugestao({ action: pedido() })).estado).toEqual({ tipo: 'pedida', frase: 'Você pediu esta mudança. O pedido espera a aprovação com o código do app; nada mudou na Meta.', pedido: PEDIDO });
    expect(modelo(sugestao({ action: pedido({ requested_by: OUTRA }) })).estado).toMatchObject({ frase: 'Esta mudança já foi pedida. O pedido espera a aprovação com o código do app; nada mudou na Meta.' });
    // No modo Aprovação, o pedido é dele (em nome de quem o deixou pedir): o cartão diz quando.
    const dele = modelo(sugestao({ action: pedido({ agent_key: 'trafego' }) }));
    expect([dele.modo, dele.estado]).toEqual(['Aprovação', { tipo: 'pedida', frase: `O Gestor de tráfego pediu esta mudança ${quando('2026-09-29T09:31:00.000Z')}. O pedido espera a aprovação com o código do app; nada mudou na Meta.`, pedido: PEDIDO }]);
    expect(modelo(sugestao({ action: pedido({ status: 'aprovada' }) })).estado).toMatchObject({ tipo: 'pedida', frase: 'Você pediu esta mudança. O pedido foi aprovado, e o Liame executa em instantes.' });
    expect(modelo(sugestao({ action: pedido({ status: 'executando' }) })).estado.tipo).toBe('pedida');
    expect(modelo(sugestao({ action: pedido({ status: 'executada' }) })).estado).toEqual({ tipo: 'feita', frase: 'O pedido desta mudança foi aprovado e executado pelo Liame.', pedido: PEDIDO });
  });

  it('o pedido que não foi adiante, ou a tentativa dele que não deu certo, deixam a recomendação aberta com a nota', () => {
    const nota = (rec: Partial<Rec>) => {
      const e = modelo(sugestao(rec)).estado;
      return e.tipo === 'aberta' ? e.nota : `(${e.tipo})`;
    };
    expect(nota({ action: pedido({ status: 'cancelada' }) })).toBe('O último pedido desta mudança foi recusado ou cancelado.');
    expect(nota({ action: pedido({ status: 'expirada' }) })).toBe('O último pedido desta mudança expirou sem aprovação.');
    expect(nota({ action: pedido({ status: 'falhou' }) })).toBe('O último pedido desta mudança foi aprovado, mas não foi executado.');
    const tentou = '2026-09-29T09:31:00.000Z';
    expect(nota({ not_requested: { code: 'teto-nao-definido', detail: 'A empresa ainda não definiu o teto do mês.', at: tentou } })).toBe(
      `O Gestor de tráfego tentou pedir esta mudança ${quando(tentou)} e não conseguiu: A empresa ainda não definiu o teto do mês.`,
    );
  });

  it('sem como pedir por aqui (quem só lê, escrita desligada): fica o texto do aviso, sem botão', () => {
    const manual = sugestao({ request: null });
    expect(modelo(manual)).toMatchObject({ estado: { tipo: 'manual' }, pedir: null });
    const html = cartao(manual);
    expect(html).toContain('<b>O que fazer:</b> se concordar, reduza a verba na Meta. Nada muda sem você.');
    expect(html).not.toContain('Pedir esta mudança');
    expect(html).not.toContain('Agora não');
    // Mesmo sem como pedir, o pedido que já existe aparece (quem vê os pedidos acompanha).
    expect(cartao(sugestao({ request: null, action: pedido({ requested_by: OUTRA }) }))).toContain('Ver o pedido');
  });

  it('o cartão desenhado: o selo, o título, os dois botões e, com o pedido andando, "Ver o pedido"', () => {
    const aberta = cartao(sugestao());
    expect(aberta).toContain(`<li class="card aviso-midia aviso--rec" data-sev="info" data-recomendacao="${REC}">`);
    expect(aberta).toContain('<span class="sev sev--info">Recomendação</span>');
    expect(aberta).toContain('plat plat--meta');
    expect(aberta).toContain('Gestor de tráfego · Sugerir');
    expect(aberta).toContain('<h2 class="aviso-titulo">Reduzir a verba da campanha &quot;Smash em dobro&quot; em 10%</h2>');
    expect(aberta).toContain('A verba diária iria de R$ 40,00 para R$ 36,00.');
    expect(aberta).toContain('<b>O que fazer:</b> se concordar, peça a mudança.');
    expect(aberta).toContain('data-pedir-recomendacao="true" aria-haspopup="dialog" aria-expanded="false">Pedir esta mudança</button>');
    expect(aberta).toContain('>Agora não</button>');
    expect(aberta).not.toContain('Ver o pedido');
    // Com a gaveta aberta por este cartão, o botão diz que o diálogo está aberto; dispensando, os dois esperam.
    expect(cartao(sugestao(), { pedindo: true })).toContain('aria-expanded="true"');
    expect(cartao(sugestao(), { dispensando: true }).match(/disabled=""/g)).toHaveLength(2);

    const pedida = cartao(sugestao({ action: pedido({ agent_key: 'trafego' }) }));
    expect(pedida).toContain('Gestor de tráfego · Aprovação');
    expect(pedida).toContain('class="aviso-estado"');
    expect(pedida).toContain(`href="/aprovacoes?pedido=${PEDIDO}"`);
    expect(pedida).not.toContain('O que fazer:');
    expect(pedida).not.toContain('Pedir esta mudança');
    expect(pedida).not.toContain('Agora não');

    const comNota = cartao(sugestao({ action: pedido({ status: 'expirada' }) }));
    expect(comNota).toContain('aviso-estado aviso-estado--nota');
    expect(comNota).toContain('O último pedido desta mudança expirou sem aprovação.');
    expect(comNota).toContain('Pedir esta mudança');
  });

  it('o aviso depois do "Agora não" e a recusa do servidor em palavras', () => {
    expect(AVISO_DE_DISPENSADA).toBe('Certo. O Gestor de tráfego registra que você não quis esta mudança.');
    expect(erroAoDispensar({ code: 'recomendacao-ja-pedida', title: 'Esta mudança já foi pedida' })).toEqual({ texto: 'Esta mudança já foi pedida: para não seguir com ela, recuse ou cancele o pedido em Aprovações.', recarregar: true });
    expect(erroAoDispensar({ code: 'recomendacao-encerrada', title: 'x' })).toEqual({ texto: 'Esta recomendação não está mais em aberto.', recarregar: true });
    expect(erroAoDispensar({ code: 'nao-encontrado', title: 'x' }).recarregar).toBe(true);
    expect(erroAoDispensar({ code: 'interno', title: 'Algo deu errado', detail: 'Tente de novo em instantes.' })).toEqual({ texto: 'Tente de novo em instantes.', recarregar: false });
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
