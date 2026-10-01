import type { CouponCampaign, CouponItem, CouponListResponse, CouponRequest, CouponStore } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  bloqueioDaCriacao,
  type CamposCriar,
  corpoDoPedido,
  erroDoPedido,
  errosCriar,
  faixaAguardando,
  faixaDoPedidoEncerrado,
  microsDeReais,
  pedidosEmAndamento,
  plataformaDaLoja,
  recusaDoPedido,
  regraDoPedido,
  situacaoDoPedido,
  validadeDoPedido,
} from '@/components/links/cupons-textos';
import { PainelCupons } from '@/components/links/painel-cupons';
import { TabelaCupons } from '@/components/links/tabela-cupons';

// "Criar cupom no Regem" com aprovação (A2.5 · F6 parte 2; protótipo P3 aprovado): a conferência do pedido
// antes de enviar, o corpo que vai ao servidor, a recusa no campo certo, e como o pedido aparece na aba Cupons
// enquanto espera aprovação, enquanto é criado e quando termina sem cupom.

const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 9, 1, 15, 0);
const FUSO = 'America/Sao_Paulo';

const loja = (o: Partial<CouponStore> = {}): CouponStore => ({
  connected_account_id: uuid(1),
  unit: { id: uuid(2), name: 'Loja Centro' },
  store_name: 'Mister Burgers Centro (Regem)',
  timezone: FUSO,
  order_platform: 'regem',
  order_platform_url: null,
  order_platform_set_at: null,
  coupons_read_at: new Date(2026, 9, 1, 14, 50).toISOString(),
  coupons_freshness: 'fresh',
  coupons_error: null,
  can_create: true,
  ...o,
});
const campanha: CouponCampaign = { id: uuid(101), name: 'Combo sexta', provider: 'meta_ads', status: 'ativa' };
const pedido = (codigo: string, o: Partial<CouponRequest> = {}): CouponRequest => ({
  action_id: uuid(500 + codigo.length),
  code: codigo,
  connected_account_id: uuid(1),
  kind: 'percentual',
  percent: 15,
  value_micros: null,
  min_order_micros: '50000000',
  valid_from: '2026-10-02',
  valid_until: '2026-10-31',
  campaign: campanha,
  exclusive: true,
  status: 'aguardando_aprovacao',
  status_reason: null,
  requested_by: { id: uuid(9), name: 'Rodrigo' },
  requested_at: new Date(2026, 9, 1, 10, 14).toISOString(),
  expires_at: new Date(2026, 9, 4, 10, 14).toISOString(),
  ...o,
});
const item = (codigo: string): CouponItem => ({
  id: uuid(700 + codigo.length),
  code: codigo,
  origin: 'regem',
  platform: null,
  connected_account_id: uuid(1),
  kind: 'percentual',
  percent: 10,
  value_micros: null,
  min_order_micros: null,
  max_discount_micros: null,
  valid_from: null,
  valid_until: null,
  active: true,
  expired: false,
  first_seen_at: new Date(2026, 8, 28, 9).toISOString(),
  uses_7d: 0,
  revenue_7d_micros: '0',
  link: null,
});
const campos = (o: Partial<CamposCriar> = {}): CamposCriar => ({ codigo: 'SEXTA15', tipo: 'percentual', valor: '15', minimo: '50', inicio: '2026-10-02', fim: '2026-10-31', campanha: campanha.id, ...o });
const ctx = { hoje: '2026-10-01', existentes: ['FDS20'], pedidos: ['NOITE20'] };

describe('criar cupom no Regem: o pedido', () => {
  it('reais viram micros em texto, com vírgula ou ponto e até 2 casas; o resto não passa', () => {
    expect(microsDeReais('50')).toBe('50000000');
    expect(microsDeReais('12,5')).toBe('12500000');
    expect(microsDeReais(' 12.90 ')).toBe('12900000');
    expect(microsDeReais('0,01')).toBe('10000');
    expect(microsDeReais('0')).toBe('0');
    for (const ruim of ['', 'dez', '12,345', '-5', '1e3', '12,', '1.000,00']) expect(microsDeReais(ruim)).toBeNull();
  });

  it('confere cada campo antes de enviar', () => {
    expect(errosCriar(campos(), ctx)).toEqual({});
    expect(errosCriar(campos({ codigo: 'abc' }), ctx).codigo).toBe('Use de 4 a 20 letras ou números, sem espaço nem acento.');
    expect(errosCriar(campos({ codigo: 'SEXTA-15' }), ctx).codigo).toContain('4 a 20');
    expect(errosCriar(campos({ codigo: 'fds20' }), ctx).codigo).toBe('Esse código já existe nesta loja. Escolha outro.');
    expect(errosCriar(campos({ codigo: 'noite20' }), ctx).codigo).toContain('Já existe um pedido de cupom com este código');
    expect(errosCriar(campos({ valor: '' }), ctx).valor).toBe('Informe o valor do desconto.');
    for (const v of ['0', '101', '12.5', '-3', '1e1', '1000', '15%']) expect(errosCriar(campos({ valor: v }), ctx).valor).toBe('O percentual vai de 1 a 100, sem casas decimais.');
    for (const v of ['1', ' 15 ', '100']) expect(errosCriar(campos({ valor: v }), ctx).valor).toBeUndefined();
    expect(errosCriar(campos({ tipo: 'valor', valor: '' }), ctx).valor).toBe('Informe o valor do desconto, em reais.');
    expect(errosCriar(campos({ tipo: 'valor', valor: '0' }), ctx).valor).toBe('Informe o valor do desconto, em reais.');
    expect(errosCriar(campos({ tipo: 'valor', valor: '7,50' }), ctx)).toEqual({});
    // Entrega grátis não tem valor: o que ficou digitado é ignorado.
    expect(errosCriar(campos({ tipo: 'frete_gratis', valor: '' }), ctx)).toEqual({});
    expect(errosCriar(campos({ minimo: '' }), ctx)).toEqual({});
    expect(errosCriar(campos({ minimo: 'dez' }), ctx).minimo).toBe('Informe o pedido mínimo em reais, ou deixe em branco.');
    expect(errosCriar(campos({ fim: '' }), ctx).data).toBe('Informe o início e o fim da validade.');
    expect(errosCriar(campos({ inicio: '2026-10-10', fim: '2026-10-05' }), ctx).data).toBe('O fim da validade não pode ser antes do início.');
    expect(errosCriar(campos({ inicio: '2026-09-20', fim: '2026-09-30' }), ctx).data).toBe('O fim da validade já passou.');
    expect(errosCriar(campos({ campanha: '' }), ctx).campanha).toBe('Escolha a campanha do cupom.');
  });

  it('o corpo do pedido leva só os campos do tipo, em micros, com o código em maiúsculas', () => {
    expect(corpoDoPedido(campos({ codigo: ' sexta15 ' }), uuid(2), true)).toEqual({
      unit_id: uuid(2),
      code: 'SEXTA15',
      kind: 'percentual',
      percent: 15,
      min_order_micros: '50000000',
      valid_from: '2026-10-02',
      valid_until: '2026-10-31',
      campaign_id: campanha.id,
      exclusive: true,
    });
    expect(corpoDoPedido(campos({ tipo: 'valor', valor: '7,50', minimo: '' }), uuid(2), false)).toEqual({
      unit_id: uuid(2),
      code: 'SEXTA15',
      kind: 'valor',
      value_micros: '7500000',
      valid_from: '2026-10-02',
      valid_until: '2026-10-31',
      campaign_id: campanha.id,
      exclusive: false,
    });
    const frete = corpoDoPedido(campos({ tipo: 'frete_gratis', valor: '15', minimo: '0' }), uuid(2), true);
    expect(frete).toMatchObject({ kind: 'frete_gratis' });
    expect(Object.keys(frete)).not.toEqual(expect.arrayContaining(['percent', 'value_micros', 'min_order_micros']));
  });

  it('a recusa do servidor cai no campo certo; o que não é de campo vai para o topo', () => {
    const problema = (code: string, o: Record<string, unknown> = {}) => ({ status: 422, code, title: 'x', ...o });
    expect(erroDoPedido(problema('validacao', { status: 400, errors: [{ path: 'value_micros', message: 'Informe o valor do desconto.' }] }))).toEqual({ campo: 'valor', mensagem: 'Informe o valor do desconto.' });
    expect(erroDoPedido(problema('validacao', { status: 400, errors: [{ path: 'valid_until', message: 'O fim da validade já passou.' }] })).campo).toBe('data');
    expect(erroDoPedido(problema('acao-duplicada', { status: 409 })).campo).toBe('codigo');
    expect(erroDoPedido(problema('plano-recusado', { detail: 'Já existe um cupom com este código nesta loja. Escolha outro código.' }))).toEqual({ campo: 'codigo', mensagem: 'Esse código já existe nesta loja. Escolha outro.' });
    expect(erroDoPedido(problema('campanha-encerrada', { detail: 'Esta campanha foi removida ou arquivada na plataforma.' }))).toEqual({ campo: 'campanha', mensagem: 'Esta campanha foi removida ou arquivada na plataforma.' });
    const semEscopo = erroDoPedido(problema('plano-recusado', { detail: 'A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.' }));
    expect(semEscopo.campo).toBeUndefined();
    expect(semEscopo.mensagem).toContain('Contas conectadas');
    expect(erroDoPedido(problema('escrita-desligada', { status: 403 })).mensagem).toContain('está desligada para a sua empresa');
    expect(erroDoPedido(problema('criacao-em-sombra', { status: 409, detail: 'A política da empresa deixa a criação de cupom em modo sombra.' })).mensagem).toContain('modo sombra');
  });
});

describe('criar cupom no Regem: o pedido na lista', () => {
  it('situação pelo estado da ação; só o que ainda vai virar cupom entra na tabela', () => {
    expect(situacaoDoPedido(pedido('A'))).toBe('aguardando');
    expect(situacaoDoPedido(pedido('A', { status: 'aprovada' }))).toBe('criando');
    expect(situacaoDoPedido(pedido('A', { status: 'executando' }))).toBe('criando');
    expect(situacaoDoPedido(pedido('A', { status: 'falhou' }))).toBe('falhou');
    expect(situacaoDoPedido(pedido('A', { status: 'expirada' }))).toBe('expirou');
    expect(situacaoDoPedido(pedido('A', { status: 'recusada' }))).toBe('recusado');
    const todos = [pedido('AAAA'), pedido('BBBBB', { status: 'aprovada' }), pedido('CCCCCC', { status: 'falhou' }), pedido('DDDDDDD', { status: 'expirada' }), pedido('EEEEEEEE', { status: 'recusada' })];
    expect(pedidosEmAndamento(todos).map((p) => p.code)).toEqual(['AAAA', 'BBBBB']);
  });

  it('regra e validade do pedido, como as de um cupom que já existe', () => {
    expect(regraDoPedido(pedido('A'))).toBe('15% · mín. R$ 50');
    expect(regraDoPedido(pedido('A', { kind: 'valor', percent: null, value_micros: '7500000', min_order_micros: null }))).toBe('R$ 7,50 de desconto · sem mínimo');
    expect(regraDoPedido(pedido('A', { kind: 'frete_gratis', percent: null, min_order_micros: '30000000' }))).toBe('Entrega grátis · mín. R$ 30');
    expect(validadeDoPedido(pedido('A'))).toBe('02/10 a 31/10');
  });

  it('faixa dos que esperam aprovação: um pelo código, vários pela contagem; nenhuma sem pedido esperando', () => {
    expect(faixaAguardando([pedido('SEXTA15')])?.titulo).toBe('O cupom SEXTA15 está aguardando aprovação');
    expect(faixaAguardando([pedido('SEXTA15'), pedido('NOITE20X')])?.titulo).toBe('2 cupons estão aguardando aprovação');
    expect(faixaAguardando([pedido('SEXTA15')])?.texto).toContain('Depois de aprovado, o Liame cria o cupom no Regem');
    expect(faixaAguardando([pedido('A', { status: 'aprovada' }), pedido('B', { status: 'falhou' })])).toBeNull();
  });

  it('pedido que terminou sem cupom: o motivo do Regem como veio, o interno em palavras de gente, e o que expirou', () => {
    const falhou = (motivo: string | null) => faixaDoPedidoEncerrado(pedido('JAEXISTE', { status: 'falhou', status_reason: motivo }));
    expect(falhou('Já existe um cupom com este código no Regem. Escolha outro código.')).toEqual({
      titulo: 'O cupom JAEXISTE não foi criado',
      texto: 'Já existe um cupom com este código no Regem. Escolha outro código. Nada mudou no Regem.',
    });
    expect(falhou('escrita em regem desligada').texto).toBe('A criação de cupons foi desligada antes de o cupom ser criado. Nada mudou no Regem.');
    expect(falhou('trava ativa (tenant): pausa de segurança').texto).toContain('parada de segurança');
    expect(falhou('sem aprovação válida para o plano atual').texto).toContain('A aprovação não valia mais');
    expect(falhou('o recurso mudou desde o pedido; nada foi sobrescrito').texto).toContain('A situação do cupom mudou');
    expect(falhou(null).texto).toBe('O Regem não criou o cupom. Nada mudou no Regem.');
    expect(faixaDoPedidoEncerrado(pedido('VELHO10', { status: 'expirada', status_reason: 'ninguém aprovou no prazo' }))).toEqual({
      titulo: 'O pedido do cupom VELHO10 expirou sem aprovação',
      texto: 'Ninguém aprovou no prazo de 3 dias, e nada foi criado no Regem. Se ainda quiser o cupom, peça de novo.',
    });
  });

  it('pedido recusado por quem aprova: a faixa diz quem recusou e por quê', () => {
    const recusado = (motivo: string | null) => faixaDoPedidoEncerrado(pedido('SEXTA15', { status: 'recusada', status_reason: motivo }));
    expect(recusado('recusada por Ana Aprovadora: Desconto alto demais')).toEqual({
      titulo: 'O pedido do cupom SEXTA15 foi recusado',
      texto: 'Ana Aprovadora recusou: “Desconto alto demais”. Nada foi criado no Regem.',
    });
    // O motivo pode ter dois-pontos: só o primeiro separa o nome.
    expect(recusaDoPedido('recusada por Ana: outro valor: 10%')).toEqual({ quem: 'Ana', motivo: 'outro valor: 10%' });
    expect(recusado('recusada por Ana').texto).toBe('Ana recusou o pedido. Nada foi criado no Regem.');
    expect(recusado(null).texto).toBe('Quem aprova recusou o pedido. Nada foi criado no Regem.');
  });

  it('a loja que não liberou a criação no Regem, ou sem loja do Liame, não pede cupom', () => {
    expect(bloqueioDaCriacao(loja())).toBeNull();
    expect(bloqueioDaCriacao(loja({ can_create: false }))?.titulo).toBe('A loja não liberou a criação de cupons no Regem');
    expect(bloqueioDaCriacao(loja({ can_create: false }))?.texto).toContain('"Criar cupom de campanha"');
    expect(bloqueioDaCriacao(loja({ unit: null }))?.titulo).toBe('Ligue a loja para criar cupons por aqui');
  });
});

describe('criar cupom no Regem: telas', () => {
  const tabela = (pedidos: CouponRequest[], podeCriarCupom = true) =>
    renderToStaticMarkup(
      createElement(TabelaCupons, { itens: [item('FDS20')], pedidos, loja: loja(), agora, podeGerenciar: true, podeCriarCupom, aoLigar: () => {}, aoDesligar: async () => true, aoCancelarPedido: async () => true }),
    );

  it('tabela: o pedido vem antes dos cupons, com a situação, "ainda não existe no Regem", a campanha e "Cancelar pedido" só enquanto espera', () => {
    const html = tabela([pedido('SEXTA15'), pedido('NOITE20X', { status: 'aprovada', exclusive: false })]);
    expect(html.indexOf('SEXTA15')).toBeLessThan(html.indexOf('FDS20'));
    expect(html).toContain('class="cupom-pendente"');
    expect(html).toContain('Aguardando aprovação');
    expect(html).toContain('Criando no Regem');
    expect(html).toContain('ainda não existe no Regem');
    expect(html).toContain('15% · mín. R$ 50');
    expect(html).toContain('02/10 a 31/10');
    expect(html).toContain('exclusivo · prova a origem');
    expect(html).toContain('não exclusivo · só acompanha');
    expect(html).toContain('aria-label="Cancelar o pedido do cupom SEXTA15"');
    // O que já foi aprovado está sendo criado: não se cancela por aqui.
    expect(html).not.toContain('aria-label="Cancelar o pedido do cupom NOITE20X"');
    // O pedido já tem campanha: conta em "Todos" e em "Ligados a campanha".
    expect(html).toMatch(/Todos <span class="num">3<\/span>.*Ligados a campanha <span class="num">2<\/span>.*Sem campanha <span class="num">1<\/span>/s);
  });

  it('tabela: quem não pede cupom não cancela o pedido; campanha que saiu da lista aparece como "Sem campanha"', () => {
    expect(tabela([pedido('SEXTA15')], false)).not.toContain('Cancelar pedido');
    expect(tabela([pedido('SEXTA15', { campaign: null })])).toContain('Sem campanha');
  });

  const painel = (o: { dados?: Partial<CouponListResponse>; lojaAtual?: CouponStore; pedidos?: CouponRequest[]; itens?: CouponItem[]; podeCriarCupom?: boolean; podeVerContas?: boolean }) => {
    const lojaAtual = o.lojaAtual ?? loja();
    const dados: CouponListResponse = { stores: [lojaAtual], items: o.itens ?? [], requests: o.pedidos ?? [], campaigns: [campanha], detected_platform: null, create_in_regem: true, generated_at: agora.toISOString(), ...o.dados };
    return renderToStaticMarkup(
      createElement(PainelCupons, {
        carga: { tipo: 'ok', dados },
        loja: lojaAtual,
        itens: dados.items,
        pedidos: dados.requests,
        plataforma: plataformaDaLoja(lojaAtual, null),
        agora,
        podeGerenciar: true,
        podeCriarCupom: o.podeCriarCupom ?? true,
        podeVerContas: o.podeVerContas ?? true,
        botaoInformar: createRef<HTMLButtonElement>(),
        botaoCriar: createRef<HTMLButtonElement>(),
        aoInformar: () => {},
        aoCriarNoRegem: () => {},
        aoCancelarPedido: async () => true,
        aoLigar: () => {},
        aoDesligar: async () => true,
        aoTentar: () => {},
      }),
    );
  };

  it('painel: com a criação ligada e liberada pela loja, o botão abre o diálogo e a lista vazia convida a criar por aqui', () => {
    const html = painel({});
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-disabled="false"[^>]*>.*?Criar cupom no Regem/s);
    expect(html).not.toContain('está desligada para a sua empresa');
    expect(html).toContain('Crie um cupom no Regem ou por aqui, com aprovação.');
  });

  it('painel: criação desligada para a empresa — botão marcado como desativado e a faixa que explica', () => {
    const html = painel({ dados: { create_in_regem: false } });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>.*?Criar cupom no Regem/s);
    expect(html).toContain('A criação de cupons está desligada para a sua empresa');
    expect(html).toContain('Crie um cupom no Regem: ele aparece aqui na próxima leitura.');
    // Quem não pede cupom não vê o botão nem a faixa.
    const leitor = painel({ dados: { create_in_regem: false }, podeCriarCupom: false });
    expect(leitor).not.toContain('Criar cupom no Regem');
    expect(leitor).not.toContain('está desligada para a sua empresa');
  });

  it('painel: loja que não liberou a criação no Regem — o botão não abre e a faixa leva a Contas conectadas', () => {
    const html = painel({ lojaAtual: loja({ can_create: false }) });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>.*?Criar cupom no Regem/s);
    expect(html).toContain('A loja não liberou a criação de cupons no Regem');
    expect(html).toContain('href="/contas"');
    expect(painel({ lojaAtual: loja({ can_create: false }), podeVerContas: false })).not.toContain('href="/contas"');
  });

  it('painel: pedido esperando vira faixa e linha (mesmo sem nenhum cupom); o que falhou vira só a faixa com o motivo', () => {
    const html = painel({
      pedidos: [pedido('SEXTA15'), pedido('JAEXISTE', { status: 'falhou', status_reason: 'Já existe um cupom com este código no Regem. Escolha outro código.' })],
    });
    expect(html).toContain('O cupom SEXTA15 está aguardando aprovação');
    expect(html).toContain('O cupom JAEXISTE não foi criado');
    expect(html).toContain('Já existe um cupom com este código no Regem. Escolha outro código. Nada mudou no Regem.');
    expect(html).toContain('class="cupom-pendente"');
    expect(html).not.toContain('Nenhum cupom na Loja Centro');
    // O que falhou não é linha da tabela.
    expect(html.match(/class="cupom-pendente"/g)).toHaveLength(1);
  });
});
