import type { MessageDiscount, MessageDiscountResponse, MessagingAccount } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  beneficioDoDesconto,
  caixaDoDesconto,
  centavosDoTexto,
  erroAoSalvarDesconto,
  exemploDoCupom,
  faixaDoDesconto,
  type FormularioDoDesconto,
  formularioInicial,
  inteiroDoTexto,
  lerFormulario,
  lojasQueCriam,
} from '@/components/mensagens/desconto-textos';
import { GavetaDesconto } from '@/components/mensagens/gaveta-desconto';
import { MensagensConteudo } from '@/components/mensagens/mensagens-conteudo';
import { contaDaTela } from '@/components/mensagens/textos';

// O desconto do cupom das mensagens na tela Mensagens (A5 · Y6; mockups/prototipo-mensagens-desconto.html, P15 parte D,
// aprovado pelo dono em 14/10/2026). As regras são as do servidor (`mensageria/desconto.ts`): até 50%; de R$ 1,00 a
// R$ 100,00 com pedido mínimo maior que o desconto; de 1 a 14 dias, contando o dia do envio. Datas no fuso local (V113).

const MARCA = '22222222-2222-4222-8222-222222222222';
const CENTRO = '33333333-3333-4333-8333-333333333331';
const LAPA = '33333333-3333-4333-8333-333333333332';
// O espaço fixo que o `Intl` põe depois de "R$" (V63: nunca o caractere digitado).
const RS = `R$${String.fromCharCode(160)}`;
const LIMITES = { percent_max: 50, value_cents_max: 10_000, min_order_cents_max: 100_000, valid_days_max: 14 };
const SABADO = new Date(2026, 9, 10, 15, 0); // sábado, 10/10/2026

const desconto = (extra: Partial<MessageDiscount> = {}): MessageDiscount => ({
  kind: 'percentual',
  percent: 10,
  value_cents: null,
  min_order_cents: null,
  valid_days: 2,
  store: { connected_account_id: CENTRO, name: 'Loja Centro', can_create: true, connected: true },
  set_by: { id: '44444444-4444-4444-8444-444444444444', name: 'Rodrigo de Oliveira' },
  set_at: new Date(2026, 9, 8, 10).toISOString(),
  ...extra,
});
const resposta = (extra: Partial<MessageDiscountResponse> = {}): MessageDiscountResponse => ({
  brand_id: MARCA,
  enabled: true,
  discount: desconto(),
  stores: [{ connected_account_id: CENTRO, name: 'Loja Centro', can_create: true }],
  limits: LIMITES,
  can_edit: true,
  ...extra,
});
const DUAS_LOJAS = [
  { connected_account_id: CENTRO, name: 'Loja Centro', can_create: true },
  { connected_account_id: LAPA, name: 'Loja Lapa', can_create: true },
];
const form = (extra: Partial<FormularioDoDesconto> = {}): FormularioDoDesconto => ({ tipo: 'percentual', quanto: '10', minimo: '', dias: '2', loja: '', ...extra });

describe('o desconto na tela Mensagens: a caixa e a faixa', () => {
  it('o que o cupom dá, em palavras', () => {
    expect(beneficioDoDesconto({ kind: 'percentual', percent: 10, value_cents: null })).toBe('10% de desconto');
    expect(beneficioDoDesconto({ kind: 'valor', percent: null, value_cents: 1000 })).toBe(`${RS}10,00 de desconto`);
    expect(beneficioDoDesconto({ kind: 'frete_gratis', percent: null, value_cents: null })).toBe('entrega grátis');
  });

  it('a caixa: não definido (com o botão para quem define, e quem define para os outros)', () => {
    expect(caixaDoDesconto(resposta({ discount: null }))).toEqual({ titulo: 'Não definido', linhas: ['sem ele, nenhuma mensagem é proposta'], aviso: null, botao: 'Definir o desconto', quem: null });
    expect(caixaDoDesconto(resposta({ discount: null, can_edit: false }))).toMatchObject({ botao: null, quem: 'Quem define é o Dono ou o Administrador.' });
  });

  it('a caixa: o desconto definido, a validade contando o dia do envio, a loja (com mais de uma) e quem definiu', () => {
    expect(caixaDoDesconto(resposta())).toEqual({
      titulo: '10% de desconto',
      linhas: ['sem pedido mínimo · vale por 2 dias, contando o dia do envio', 'definido por Rodrigo em 08/10'],
      aviso: null,
      botao: 'Mudar',
      quem: null,
    });
    const valor = caixaDoDesconto(resposta({ discount: desconto({ kind: 'valor', percent: null, value_cents: 1000, min_order_cents: 5000, valid_days: 7 }), stores: DUAS_LOJAS }));
    expect(valor.titulo).toBe(`${RS}10,00 de desconto`);
    expect(valor.linhas[0]).toBe(`em pedidos a partir de ${RS}50,00 · vale por 7 dias, contando o dia do envio · na loja “Loja Centro”`);
    expect(caixaDoDesconto(resposta({ discount: desconto({ kind: 'frete_gratis', percent: null, valid_days: 1 }) })).linhas[0]).toBe('sem pedido mínimo · vale por 1 dia, contando o dia do envio');
    expect(caixaDoDesconto(resposta({ discount: desconto({ set_by: null }) })).linhas[1]).toBe('definido em 08/10');
    expect(caixaDoDesconto(resposta({ discount: desconto({ store: { connected_account_id: CENTRO, name: 'Loja Centro', can_create: true, connected: false } }) })).aviso).toBe(
      'A loja “Loja Centro” foi desconectada do Liame: o cupom precisa de outra loja do Regem.',
    );
    expect(caixaDoDesconto(resposta({ can_edit: false }))).toMatchObject({ botao: null, quem: 'Quem define é o Dono ou o Administrador.' });
  });

  it('a faixa do topo só enquanto ninguém definiu, com a função ligada', () => {
    expect(faixaDoDesconto(resposta({ discount: null }))).toEqual({
      titulo: 'Falta definir o desconto do cupom das mensagens',
      texto: 'Cada mensagem leva um cupom só dela, e o desconto dele é você quem define, uma vez. Sem isso, o CRM e mensageria não propõe mensagem.',
      botao: 'Definir o desconto',
    });
    expect(faixaDoDesconto(resposta({ discount: null, can_edit: false }))).toEqual({
      titulo: 'Falta definir o desconto do cupom das mensagens',
      texto: 'Cada mensagem leva um cupom só dela, e o desconto dele é definido uma vez pelo Dono ou pelo Administrador. Sem isso, o CRM e mensageria não propõe mensagem.',
      botao: null,
    });
    expect(faixaDoDesconto(resposta())).toBeNull();
    expect(faixaDoDesconto(resposta({ discount: null, enabled: false }))).toBeNull();
  });
});

describe('a gaveta de definir: o formulário', () => {
  it('os números escritos: reais com vírgula e milhar, inteiros só com dígitos', () => {
    expect([centavosDoTexto('30'), centavosDoTexto('30,00'), centavosDoTexto('1.250,50'), centavosDoTexto(' 10,5 ')]).toEqual([3000, 3000, 125050, 1050]);
    for (const errado of ['', 'abc', '1,234', '10,0,0', '12345678', '-5', '1e3']) expect(centavosDoTexto(errado), errado).toBeNull();
    expect([inteiroDoTexto('3'), inteiroDoTexto(' 10 ')]).toEqual([3, 10]);
    for (const errado of ['', '1,5', 'x', '-1', '12345']) expect(inteiroDoTexto(errado), errado).toBeNull();
  });

  it('o formulário ao abrir: na primeira vez o valor em branco e 3 dias; depois, o desconto de agora', () => {
    expect(formularioInicial(resposta({ discount: null }))).toEqual({ tipo: 'percentual', quanto: '', minimo: '', dias: '3', loja: '' });
    expect(formularioInicial(resposta())).toEqual({ tipo: 'percentual', quanto: '10', minimo: '', dias: '2', loja: '' });
    expect(formularioInicial(resposta({ discount: desconto({ kind: 'valor', percent: null, value_cents: 1000, min_order_cents: 5000, valid_days: 7 }), stores: DUAS_LOJAS }))).toEqual({
      tipo: 'valor',
      quanto: '10,00',
      minimo: '50,00',
      dias: '7',
      loja: CENTRO,
    });
  });

  it('o que a tela recusa antes de enviar, com o campo e as frases do servidor', () => {
    const r = resposta();
    const recusa = (g: Partial<FormularioDoDesconto>, ra = r) => {
      const x = lerFormulario(form(g), ra);
      return x.ok ? null : [x.campo, x.erro];
    };
    expect(recusa({ quanto: '' })).toEqual(['quanto', 'Informe o desconto, de 1% a 50%.']);
    expect(recusa({ quanto: '10,5' })).toEqual(['quanto', 'O percentual vai de 1 a 50, sem casas decimais.']);
    expect(recusa({ quanto: '80' })).toEqual(['quanto', 'O desconto passa de 50%: o Liame não aceita mais que isso no cupom das mensagens.']);
    expect(recusa({ tipo: 'valor', quanto: '0,50', minimo: '50' })).toEqual(['quanto', `Informe o desconto, de ${RS}1,00 a ${RS}100,00.`]);
    expect(recusa({ tipo: 'valor', quanto: '150', minimo: '500' })).toEqual(['quanto', `O desconto passa de ${RS}100,00: o Liame não aceita mais que isso no cupom das mensagens.`]);
    expect(recusa({ tipo: 'valor', quanto: '10', minimo: '' })).toEqual(['minimo', 'Com desconto de valor fixo, informe o pedido mínimo, maior que o desconto.']);
    expect(recusa({ tipo: 'valor', quanto: '10', minimo: '10' })).toEqual(['minimo', 'Com desconto de valor fixo, informe o pedido mínimo, maior que o desconto.']);
    expect(recusa({ minimo: 'abc' })).toEqual(['minimo', 'Informe o pedido mínimo em reais, ou deixe em branco.']);
    expect(recusa({ dias: '15' })).toEqual(['dias', 'O cupom vale de 1 a 14 dias.']);
    expect(recusa({ dias: '0' })).toEqual(['dias', 'O cupom vale de 1 a 14 dias.']);
    // Com mais de uma loja que cria cupom, a loja é obrigatória.
    expect(recusa({}, resposta({ stores: DUAS_LOJAS }))).toEqual(['loja', 'Escolha em qual loja o cupom vale.']);
  });

  it('o que vai para o servidor: só o campo do tipo escolhido, e a loja só com mais de uma', () => {
    expect(lerFormulario(form(), resposta())).toEqual({ ok: true, corpo: { brand_id: MARCA, kind: 'percentual', percent: 10, valid_days: 2 } });
    expect(lerFormulario(form({ tipo: 'valor', quanto: '10', minimo: '50' }), resposta())).toEqual({ ok: true, corpo: { brand_id: MARCA, kind: 'valor', value_cents: 1000, min_order_cents: 5000, valid_days: 2 } });
    expect(lerFormulario(form({ tipo: 'frete_gratis', quanto: '', minimo: '40', dias: '3' }), resposta())).toEqual({ ok: true, corpo: { brand_id: MARCA, kind: 'frete_gratis', min_order_cents: 4000, valid_days: 3 } });
    expect(lerFormulario(form({ loja: LAPA }), resposta({ stores: DUAS_LOJAS }))).toEqual({ ok: true, corpo: { brand_id: MARCA, kind: 'percentual', percent: 10, valid_days: 2, connected_account_id: LAPA } });
    // A loja que não liberou "criar cupom" não conta.
    expect(lojasQueCriam(resposta({ stores: [DUAS_LOJAS[0]!, { ...DUAS_LOJAS[1]!, can_create: false }] })).map((l) => l.name)).toEqual(['Loja Centro']);
  });

  it('o exemplo: como o cupom de uma mensagem enviada hoje aparece no pedido (o dia do envio conta)', () => {
    expect(exemploDoCupom(form(), resposta(), SABADO)).toEqual({ intro: 'O cupom de uma mensagem enviada hoje (sábado, 10/10) vai aparecer assim no pedido:', cupom: '10% de desconto, válido de 10/10 a 11/10' });
    expect(exemploDoCupom(form({ tipo: 'valor', quanto: '10', minimo: '50', dias: '7' }), resposta(), SABADO).cupom).toBe(`${RS}10,00 de desconto, em pedidos a partir de ${RS}50,00, válido de 10/10 a 16/10`);
    expect(exemploDoCupom(form({ tipo: 'frete_gratis', quanto: '', minimo: '', dias: '1' }), resposta(), SABADO).cupom).toBe('entrega grátis, válido de 10/10 a 10/10');
    // A virada do mês.
    expect(exemploDoCupom(form({ dias: '3' }), resposta(), new Date(2026, 9, 30, 9)).cupom).toBe('10% de desconto, válido de 30/10 a 01/11');
    // Com a loja ainda por escolher, o exemplo aparece do mesmo jeito; incompleto, ele espera.
    expect(exemploDoCupom(form(), resposta({ stores: DUAS_LOJAS }), SABADO).cupom).toBe('10% de desconto, válido de 10/10 a 11/10');
    expect(exemploDoCupom(form({ quanto: '' }), resposta(), SABADO)).toEqual({ intro: 'O exemplo do cupom aparece aqui quando o desconto estiver preenchido e dentro dos limites.', cupom: null });
  });

  it('a recusa do servidor vai para o campo dela; sem loja que crie cupom, a gaveta troca para o aviso', () => {
    expect(erroAoSalvarDesconto({ status: 409, code: 'loja-sem-cupom', title: 'Sem loja', detail: 'Nenhuma loja do Regem desta marca liberou criar cupom de campanha.' })).toMatchObject({ semLoja: true, campo: null });
    expect(erroAoSalvarDesconto({ status: 400, code: 'validacao', title: 'Pedido inválido', errors: [{ path: 'valid_days', message: 'O cupom vale de 1 a 14 dias.' }] })).toEqual({ erro: 'O cupom vale de 1 a 14 dias.', campo: 'dias', semLoja: false });
    expect(erroAoSalvarDesconto({ status: 400, code: 'validacao', title: 'Pedido inválido', errors: [{ path: 'value_cents', message: 'x' }] }).campo).toBe('quanto');
    expect(erroAoSalvarDesconto({ status: 400, code: 'validacao', title: 'Pedido inválido', errors: [{ path: 'connected_account_id', message: 'y' }] }).campo).toBe('loja');
    expect(erroAoSalvarDesconto({ status: 409, code: 'mensageria-desligada', title: 'Desligada', detail: 'As mensagens estão desligadas.' })).toEqual({ erro: 'As mensagens estão desligadas.', campo: null, semLoja: false });
  });
});

describe('desenhado', () => {
  const conta = (): MessagingAccount => ({
    connected_account_id: '11111111-1111-4111-8111-111111111111',
    name: 'Smash da Vila',
    status: 'ok',
    whatsapp: { status: 'ok', connected: true, signal: 'pode_enviar', title: 'Tudo certo para enviar', summary: 'A conta do WhatsApp está saudável na Meta.', checked_at: '2026-10-09T12:00:00.000Z', problems: [] },
    budget: { status: 'ok', currency: 'BRL', periods: [{ period: 'mes', label: 'Outubro', limit_cents: 30_000, spent_cents: 12_736, percent: 42.45, signal: 'ok' }], notices: [] },
    ready: { templates_status: 'ok', approved_templates: 3, templates: 4, audiences_status: 'ok', audiences: 4, largest_audience: 450 },
    campaigns: { status: 'ok', total: 0, items: [] },
  });
  const desenhar = (r: MessageDiscountResponse | null, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(MensagensConteudo, {
        conta: contaDaTela(conta(), SABADO),
        modo: 'lite',
        podeVerContas: true,
        desconto: r ? { tipo: 'ok', caixa: caixaDoDesconto(r), faixa: faixaDoDesconto(r) } : null,
        aoDefinirDesconto: () => {},
        aoLerDesconto: () => {},
        aoVer: () => {},
        aoTentarDeNovo: () => {},
        ...extra,
      }),
    );

  it('sem desconto: a faixa com "Definir o desconto" e a quarta caixa; quem só vê não ganha o botão', () => {
    const html = desenhar(resposta({ discount: null }));
    expect(html).toContain('<div class="mens-topo mens-topo--4">');
    expect(html).toContain('Falta definir o desconto do cupom das mensagens');
    expect(html.match(/aria-haspopup="dialog"[^>]*>Definir o desconto<\/button>/g)).toHaveLength(2);
    expect(html).toContain('<span>Desconto do cupom das mensagens</span><b>Não definido</b><span>sem ele, nenhuma mensagem é proposta</span>');
    const soVe = desenhar(resposta({ discount: null, can_edit: false }));
    expect(soVe).not.toContain('Definir o desconto</button>');
    expect(soVe).toContain('<span>Quem define é o Dono ou o Administrador.</span>');
    expect(soVe).toContain('definido uma vez pelo Dono ou pelo Administrador');
  });

  it('com o desconto: a caixa com "Mudar", sem faixa; sem a leitura do desconto, as três caixas de antes', () => {
    const html = desenhar(resposta());
    expect(html).toContain('<b>10% de desconto</b><span>sem pedido mínimo · vale por 2 dias, contando o dia do envio</span><span>definido por Rodrigo em 08/10</span>');
    expect(html).toContain('id="mens-desconto-bt" aria-haspopup="dialog">Mudar</button>');
    expect(html).not.toContain('Falta definir');
    const sem = desenhar(null);
    expect(sem).toContain('<div class="mens-topo">');
    expect(sem).not.toContain('Desconto do cupom');
    const falhou = desenhar(null, { desconto: { tipo: 'erro' } });
    expect(falhou).toContain('<b>Não deu para ler agora</b>');
    expect(falhou).toContain('>Tentar de novo</button>');
  });

  it('a gaveta: os três tipos, os campos com as dicas, a loja com mais de uma, o exemplo e a nota; sem loja, o aviso', () => {
    const base = { agora: SABADO, reserva: { current: null }, aoSalvar: () => {}, aoFechar: () => {} };
    const html = renderToStaticMarkup(createElement(GavetaDesconto, { ...base, resposta: resposta({ stores: DUAS_LOJAS }) }));
    for (const p of [
      '<h2 id="dlg-desconto-t">O desconto do cupom das mensagens</h2>',
      '<legend>Que desconto o cupom dá?</legend>',
      'Percentual',
      'Valor fixo',
      'Entrega grátis',
      'Quanto de desconto',
      'De 1% a 50%, sem casas decimais.',
      'Pedido mínimo',
      'Em branco, o cupom vale para qualquer pedido.',
      'Por quantos dias o cupom vale',
      'De 1 a 14 dias, contando o dia do envio.',
      'Em qual loja o cupom vale',
      'O cupom nasce no Regem, na loja escolhida. As outras lojas não o aceitam.',
      'O cupom de uma mensagem enviada hoje (sábado, 10/10) vai aparecer assim no pedido: <b>10% de desconto, válido de 10/10 a 11/10</b>.',
      'Vale para as próximas propostas.',
      'Salvar desconto',
    ])
      expect(html, p).toContain(p);
    // Uma loja só: sem a escolha da loja.
    expect(renderToStaticMarkup(createElement(GavetaDesconto, { ...base, resposta: resposta() }))).not.toContain('Em qual loja o cupom vale');
    // Nenhuma loja que crie cupom: o aviso, e só "Fechar".
    const semLoja = renderToStaticMarkup(createElement(GavetaDesconto, { ...base, resposta: resposta({ discount: null, stores: [{ connected_account_id: CENTRO, name: 'Loja Centro', can_create: false }] }) }));
    expect(semLoja).toContain('Nenhuma loja do Regem deixa o Liame criar cupom');
    expect(semLoja).toContain('href="/contas"');
    expect(semLoja).not.toContain('Salvar desconto');
    expect(`${html}${semLoja}`).not.toMatch(/NaN|undefined|\[object Object\]/);
  });
});
