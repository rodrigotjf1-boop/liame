import { type BillingInvoice, type BillingPlan, BillingResponse, type BrandSubscription } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoFases, CartaoFaturas, CartaoSituacao, PlanosParaAssinar } from '@/components/cobranca/cartoes';
import {
  diasEntre,
  emAberto,
  fases,
  funcionariosDo,
  linhaDaFatura,
  momentoDa,
  nomeDaFatura,
  reaisDeCentavos,
  situacao,
  somarDias,
  textoDoFim,
  ultimaPaga,
} from '@/components/cobranca/textos';

// A7 · W5, parte 2 (P26): os textos de Plano e cobrança tirados da resposta da API, situação por situação, e os cartões.

const ESSENCIAL: BillingPlan = { key: 'essencial', version: 1, name: 'Essencial', price_cents: '24900', currency: 'BRL', agents: ['lia', 'trafego', 'analista', 'relatorios', 'compliance'] };
const COMPLETO: BillingPlan = { ...ESSENCIAL, key: 'completo', name: 'Completo', price_cents: '44900', agents: [...ESSENCIAL.agents, 'estrategista', 'social'] };
const MARCA = '01a40000-0000-7000-8000-0000000000aa';

const fatura = (o: Partial<BillingInvoice> = {}): BillingInvoice => ({
  id: '01a40000-0000-7000-8000-000000000f01',
  kind: 'mensalidade',
  plan_key: 'essencial',
  plan_name: 'Essencial',
  period_start: '2026-11-22',
  period_end: '2026-12-22',
  due_date: '2026-11-22',
  amount_cents: '24900',
  status: 'aberta',
  paid_at: null,
  paid_method: null,
  refund_requested_at: null,
  ...o,
});
const assinatura = (o: Partial<BrandSubscription> = {}): BrandSubscription => ({
  id: '01a40000-0000-7000-8000-000000000a01',
  plan: ESSENCIAL,
  next_plan: null,
  status: 'ativa',
  method: 'pix',
  period_start: '2026-10-22',
  period_end: '2026-11-22',
  first_payment_until: null,
  overdue: null,
  cancel_at_period_end: false,
  withdraw_until: null,
  ended_at: null,
  end_reason: null,
  ...o,
});
const resposta = (o: Partial<BillingResponse> = {}): BillingResponse =>
  BillingResponse.parse({ brand_id: MARCA, enabled: true, can_manage: true, can_pay: true, today: '2026-11-10', subscription: assinatura(), invoices: [], ...o });
const PAGA_OUT = fatura({ id: '01a40000-0000-7000-8000-000000000f00', period_start: '2026-10-22', period_end: '2026-11-22', due_date: '2026-10-21', status: 'paga', paid_at: '2026-10-22T15:00:00.000Z', paid_method: 'pix' });
const atraso = (dias: number) => ({ due_date: '2026-11-22', days: dias, actions_stop_on: '2026-12-02', suspends_on: '2026-12-22' });
const texto = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('Plano e cobrança: o momento da assinatura (P26)', () => {
  it('cada situação da API vira o momento da tela, e a função desligada vem antes de tudo', () => {
    expect(momentoDa(resposta({ enabled: false }))).toBe('desligada');
    expect(momentoDa(resposta({ subscription: null }))).toBe('sem');
    expect(momentoDa(resposta({ subscription: assinatura({ status: 'encerrada', ended_at: '2026-11-01T12:00:00.000Z', end_reason: 'cancelada' }) }))).toBe('terminou');
    expect(momentoDa(resposta({ subscription: assinatura({ status: 'aguardando_pagamento', period_start: null, period_end: null }) }))).toBe('aguardando');
    expect(momentoDa(resposta())).toBe('em-dia');
    expect(momentoDa(resposta({ subscription: assinatura({ withdraw_until: '2026-11-12' }) }))).toBe('primeira');
    // O prazo de desistir que passou não conta (hoje é 10/11).
    expect(momentoDa(resposta({ subscription: assinatura({ withdraw_until: '2026-11-09' }) }))).toBe('em-dia');
    expect(momentoDa(resposta({ subscription: assinatura({ cancel_at_period_end: true, withdraw_until: '2026-11-12' }) }))).toBe('cancelada');
    expect(momentoDa(resposta({ subscription: assinatura({ status: 'em_atraso', overdue: atraso(3) }) }))).toBe('atraso-1');
    expect(momentoDa(resposta({ subscription: assinatura({ status: 'acoes_paradas', overdue: atraso(12) }) }))).toBe('atraso-10');
    expect(momentoDa(resposta({ subscription: assinatura({ status: 'suspensa', overdue: atraso(30) }) }))).toBe('atraso-30');
  });

  it('as contas de datas e de dinheiro são de calendário e de centavos, sem fuso e sem ponto flutuante', () => {
    expect(reaisDeCentavos('24900')).toMatch(/^R\$\s249,00$/);
    expect(reaisDeCentavos('123456789')).toMatch(/^R\$\s1\.234\.567,89$/);
    expect(somarDias('2026-11-22', 9)).toBe('2026-12-01');
    expect(somarDias('2026-12-02', -1)).toBe('2026-12-01');
    expect(somarDias('2027-02-28', 1)).toBe('2027-03-01');
    expect(diasEntre('2026-11-22', '2026-12-22')).toBe(30);
    expect(funcionariosDo(ESSENCIAL)).toEqual(['LIA', 'Gestor de tráfego', 'Analista de dados', 'Relatórios', 'Compliance']);
    // A chave que a tela ainda não conhece aparece como veio, em vez de sumir.
    expect(funcionariosDo({ ...ESSENCIAL, agents: ['lia', 'novo_func'] })).toEqual(['LIA', 'novo_func']);
  });

  it('a fatura em aberto é a mais antiga, e a paga é a mais nova', () => {
    const nov = fatura();
    const dez = fatura({ id: '01a40000-0000-7000-8000-000000000f02', period_start: '2026-12-22', due_date: '2026-12-22' });
    expect(emAberto([dez, PAGA_OUT, nov])?.id).toBe(nov.id);
    expect(emAberto([PAGA_OUT])).toBeNull();
    expect(ultimaPaga([nov, PAGA_OUT])?.id).toBe(PAGA_OUT.id);
  });
});

describe('Plano e cobrança: o que a situação diz (P26, só o que o servidor faz)', () => {
  it('em atraso no 1º dia: a data de pagar sem as ações pararem, os degraus e o botão para quem paga', () => {
    const r = resposta({ today: '2026-11-25', subscription: assinatura({ status: 'em_atraso', overdue: atraso(3) }), invoices: [fatura(), PAGA_OUT] });
    const s = situacao('atraso-1', r, { aberta: fatura(), paga: PAGA_OUT, souDono: true });
    expect(s.titulo).toBe('A mensalidade de novembro não foi paga');
    expect(s.selos[0]!.texto).toBe('Em atraso há 3 dias');
    expect(s.frase).toMatch(/^Ela venceu em 22\/11 \(R\$\s249,00\)\. Pague até 01\/12 para os funcionários de IA continuarem trabalhando\.$/);
    expect(s.degraus).toEqual([
      { dia: '2026-12-02', oQue: 'os funcionários de IA param', tom: 'agora' },
      { dia: '2026-12-22', oQue: 'a conta é suspensa: só o Dono entra' },
    ]);
    expect(s.pagar).toBe(true);
    // Quem não paga não vê o botão.
    expect(situacao('atraso-1', resposta({ ...r, can_pay: false }), { aberta: fatura(), paga: null, souDono: false }).pagar).toBe(false);
  });

  it('no 10º dia: o que continua e o que para, e nenhum anúncio é pausado', () => {
    const r = resposta({ today: '2026-12-03', subscription: assinatura({ status: 'acoes_paradas', overdue: atraso(11) }), invoices: [fatura()] });
    const s = situacao('atraso-10', r, { aberta: fatura(), paga: null, souDono: true });
    expect(s.titulo).toBe('Os funcionários de IA estão parados');
    expect(s.frase).toMatch(/^Desde 02\/12, por causa da mensalidade de novembro \(R\$\s249,00\), que venceu em 22\/11\.$/);
    expect(s.continua.map((c) => c.sim)).toEqual([true, true, false]);
    expect(s.continua[1]!.texto).toContain('o Liame não pausa nenhum');
  });

  it('no 30º dia, para o Dono: só ele entra, pagar e exportar os dados', () => {
    const r = resposta({ today: '2026-12-22', subscription: assinatura({ status: 'suspensa', overdue: atraso(30) }), invoices: [fatura()] });
    const s = situacao('atraso-30', r, { aberta: fatura(), paga: null, souDono: true });
    expect(s.titulo).toBe('A conta está suspensa');
    expect(s.frase).toContain('Desde 22/12, só você entra, para pagar ou exportar os dados.');
    expect(s.pagar && s.exportar).toBe(true);
    // O que acontece com os dados depois (W3, parte 4) ainda não está na tela (V39).
    expect(JSON.stringify(s)).not.toMatch(/apagad/);
  });

  it('esperando o primeiro pagamento, em dia, na primeira contratação e cancelada', () => {
    const aguardando = resposta({ subscription: assinatura({ status: 'aguardando_pagamento', period_start: null, period_end: null, first_payment_until: '2026-11-17' }), invoices: [fatura({ period_start: null, due_date: '2026-11-10' })] });
    const a = situacao('aguardando', aguardando, { aberta: aguardando.invoices[0]!, paga: null, souDono: true });
    expect(a.titulo).toBe('Falta pagar a primeira mensalidade');
    expect(a.frase).toMatch(/^O plano Essencial começa quando a primeira mensalidade, de R\$\s249,00, for paga\. Sem o pagamento até 17\/11, o pedido termina sozinho\.$/);
    expect(a.pagar).toBe(true);

    const emDia = situacao('em-dia', resposta({ invoices: [PAGA_OUT] }), { aberta: null, paga: PAGA_OUT, souDono: true });
    expect(emDia.frase).toMatch(/^A próxima cobrança é de R\$\s249,00 em 22\/11, por PIX\.$/);
    expect(emDia.nota).toMatch(/^Plano Essencial · a mensalidade de outubro foi paga em 22\/10, por PIX\.$/);
    expect(emDia.pagar).toBe(false);
    // A fatura do período seguinte já nasceu (5 dias antes): dá para pagar agora.
    const comAberta = situacao('em-dia', resposta({ today: '2026-11-18', invoices: [fatura(), PAGA_OUT] }), { aberta: fatura(), paga: PAGA_OUT, souDono: true });
    expect(comAberta.frase).toContain('A fatura de novembro já está aberta: dá para pagar agora.');
    expect(comAberta.pagar).toBe(true);

    const primeira = resposta({ subscription: assinatura({ withdraw_until: '2026-10-29' }), today: '2026-10-25', invoices: [PAGA_OUT] });
    expect(situacao('primeira', primeira, { aberta: null, paga: PAGA_OUT, souDono: true }).nota).toMatch(/^Até 29\/10, você pode desistir e receber de volta os R\$\s249,00, sem multa\.$/);
    expect(situacao('primeira', primeira, { aberta: null, paga: PAGA_OUT, souDono: false }).nota).toMatch(/^Até 29\/10, o Dono pode desistir/);

    const cancelada = situacao('cancelada', resposta({ subscription: assinatura({ cancel_at_period_end: true }) }), { aberta: null, paga: PAGA_OUT, souDono: false });
    expect(cancelada.titulo).toBe('A assinatura termina em 22/11');
    expect(cancelada.frase).toBe('A assinatura foi cancelada. Até 22/11, tudo funciona como hoje, e a mensalidade seguinte não é cobrada.');
    expect(cancelada.nota).toBe('Só o Dono pode manter a assinatura.');
  });

  it('a assinatura que terminou diz o motivo: a desistência com a devolução, o pedido sem pagamento e o cancelamento', () => {
    const fim = { status: 'encerrada', ended_at: '2026-10-25T15:00:00.000Z' } as const;
    const devolvendo = fatura({ status: 'paga', paid_at: '2026-10-22T15:00:00.000Z', paid_method: 'pix', refund_requested_at: '2026-10-25T15:00:00.000Z' });
    expect(textoDoFim(assinatura({ ...fim, end_reason: 'desistencia' }), [devolvendo])).toMatch(/^A assinatura terminou em 25\/10, na desistência\. Os R\$\s249,00 estão voltando para a conta que pagou o PIX\.$/);
    expect(textoDoFim(assinatura({ ...fim, end_reason: 'desistencia' }), [{ ...devolvendo, status: 'devolvida' }])).toContain('voltaram para a conta que pagou o PIX');
    expect(textoDoFim(assinatura({ ...fim, end_reason: 'nao_paga' }), [])).toBe('O pedido de assinatura terminou em 25/10: a primeira mensalidade não foi paga em 7 dias.');
    expect(textoDoFim(assinatura({ ...fim, end_reason: 'cancelada' }), [])).toBe('A assinatura terminou em 25/10, depois do cancelamento.');
  });
});

describe('Plano e cobrança: as faturas e as fases', () => {
  it('cada fatura diz a situação dela, com o tom do selo pelo atraso', () => {
    expect(nomeDaFatura(fatura())).toBe('Novembro de 2026');
    expect(nomeDaFatura(fatura({ kind: 'diferenca', plan_name: 'Completo' }))).toBe('Diferença para o Completo');
    expect(linhaDaFatura(PAGA_OUT, '2026-11-10')).toEqual({ detalhe: 'Paga em 22/10, por PIX', selo: 'Paga', tom: 'concluido' });
    expect(linhaDaFatura(fatura(), '2026-11-18')).toEqual({ detalhe: 'Vence em 22/11', selo: 'Em aberto', tom: 'info' });
    expect(linhaDaFatura(fatura(), '2026-11-22').detalhe).toBe('Vence hoje');
    expect(linhaDaFatura(fatura(), '2026-11-25')).toEqual({ detalhe: 'Venceu em 22/11', selo: 'Vencida', tom: 'aguardando' });
    expect(linhaDaFatura(fatura(), '2026-12-02').tom).toBe('perigo');
    expect(linhaDaFatura(fatura({ status: 'cancelada' }), '2026-11-25').selo).toBe('Cancelada');
  });

  it('as fases do atraso: com as datas só quando há atraso, o momento marcado como agora, e sem o 60º dia (V39)', () => {
    const semAtraso = fases('em-dia', assinatura());
    expect(semAtraso.map((f) => f.quando)).toEqual(['No vencimento', '1º dia de atraso', '10º dia', '30º dia']);
    expect(semAtraso.every((f) => f.dia === null && !f.agora)).toBe(true);
    const dez = fases('atraso-10', assinatura({ status: 'acoes_paradas', overdue: atraso(11) }));
    expect(dez.map((f) => f.dia)).toEqual(['2026-11-22', '2026-11-23', '2026-12-02', '2026-12-22']);
    expect(dez.map((f) => f.agora)).toEqual([false, false, true, false]);
    // O 1º dia diz só o e-mail: a faixa no alto das telas chega com a W5, parte 4.
    expect(dez[1]!.oQue).toBe('Quem paga recebe um aviso por e-mail.');
  });

  it('os cartões mostram o que os textos dizem', () => {
    const r = resposta({ today: '2026-11-25', subscription: assinatura({ status: 'em_atraso', overdue: atraso(3) }), invoices: [fatura(), PAGA_OUT] });
    const s = situacao('atraso-1', r, { aberta: fatura(), paga: PAGA_OUT, souDono: true });
    const cartao = texto(createElement(CartaoSituacao, { s, idTitulo: 't', acoes: { pagarRotulo: 'Pagar R$ 249,00 com PIX', aoPagar: () => {}, aoExportar: () => {}, exportando: false } }));
    expect(cartao).toContain('A mensalidade de novembro não foi paga');
    expect(cartao).toContain('02/12 os funcionários de IA param');
    expect(cartao).toContain('Pagar R$ 249,00 com PIX');
    expect(cartao).not.toContain('Exportar os dados');
    expect(texto(createElement(CartaoFaturas, { invoices: [], hoje: '2026-11-25' }))).toContain('As faturas aparecem aqui depois da primeira mensalidade.');
    expect(texto(createElement(CartaoFases, { linhas: fases('atraso-1', r.subscription) }))).toContain('1º dia de atraso 23/11 Quem paga recebe um aviso por e-mail. (agora)');
    const planos = texto(createElement(PlanosParaAssinar, { planos: [ESSENCIAL, COMPLETO], podeAssinar: false, aoAssinar: () => {} }));
    expect(planos).toContain('Essencial');
    expect(planos).toContain('Assinar é com o Dono.');
    expect(planos).not.toContain('Assinar o Essencial');
  });
});
