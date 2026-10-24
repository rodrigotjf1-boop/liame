import { describe, expect, it } from 'vitest';
import { descricaoDaCobranca, esperaDaCobranca, falhaDoErro } from '../src/cobranca/cobranca-pix.js';
import { MINIMO_DA_COBRANCA_CENTAVOS } from '../src/cobranca/vida.js';
import { ASAAS_PRODUCAO, ASAAS_SANDBOX, asaasDaConfig } from '../src/config.js';
import { decidirReleitura, pagoEmDaCobranca, SITUACOES_PAGAS } from '../src/cobranca/releitura.js';
import { ApiAsaas, type CobrancaAsaas, cobrancaDoAsaas, diaDoAsaas, paraCentavos, paraReais, situacaoParaGravar } from '../src/connectors/asaas/api-asaas.js';
import { type ClienteConector, classificar, ErroConector, erroDoAsaas } from '../src/connectors/cliente-http.js';
import { eventoDoAsaas } from '../src/inbox/inbox.service.js';
import { cobrancaDoAviso } from '../src/worker/aviso-do-asaas.js';

// A7 · W2a, parte 1, sem banco e sem rede: a configuração do Asaas (o endereço oficial em produção e a chave do mesmo
// ambiente, pelo prefixo; base §18.5), o erro do Asaas na classificação do cliente HTTP (`errors[0]` e o 429 com o
// `RateLimit-Reset`), a cobrança do Asaas no formato do Liame, os valores em reais e em centavos, o texto da cobrança, a
// espera entre as tentativas e o porquê da falha em código.

// Chaves de mentira, em nomes neutros (ERR-131): só o prefixo importa aqui.
const DO_SANDBOX = '$aact_hmlg_de-mentira-para-o-teste-0001';
const DA_PRODUCAO = '$aact_prod_de-mentira-para-o-teste-0001';
const MARCA_DO_AVISO = 'marca-de-mentira-do-aviso-com-mais-de-32-letras';

describe('o Asaas na configuração (D-A7-33)', () => {
  it('sem a chave, o pagamento fica indisponível (nulo), em qualquer ambiente', () => {
    expect(asaasDaConfig('production', undefined, ASAAS_SANDBOX, undefined)).toBeNull();
    expect(asaasDaConfig('test', undefined, 'http://127.0.0.1:9/v3', undefined)).toBeNull();
  });

  it('com a chave: o endereço, o ambiente pelo endereço e o token do aviso', () => {
    expect(asaasDaConfig('production', DO_SANDBOX, `${ASAAS_SANDBOX}/`, MARCA_DO_AVISO)).toEqual({ apiKey: DO_SANDBOX, apiUrl: ASAAS_SANDBOX, ambiente: 'sandbox', webhookToken: MARCA_DO_AVISO });
    expect(asaasDaConfig('production', DA_PRODUCAO, ASAAS_PRODUCAO, MARCA_DO_AVISO)).toEqual({ apiKey: DA_PRODUCAO, apiUrl: ASAAS_PRODUCAO, ambiente: 'producao', webhookToken: MARCA_DO_AVISO });
    // Fora de produção, o token pode faltar (a rota do aviso responde como inexistente).
    expect(asaasDaConfig('test', DO_SANDBOX, ASAAS_SANDBOX, undefined)?.webhookToken).toBeNull();
  });

  it('em produção, a chave sem o token do aviso é recusada (W2a, parte 2): sem ele, o pagamento só apareceria no dia seguinte', () => {
    expect(() => asaasDaConfig('production', DA_PRODUCAO, ASAAS_PRODUCAO, undefined)).toThrow('ASAAS_WEBHOOK_TOKEN');
    expect(() => asaasDaConfig('production', DO_SANDBOX, ASAAS_SANDBOX, '')).toThrow('ASAAS_WEBHOOK_TOKEN');
    // Sem a chave, nada é exigido: o pagamento fica indisponível.
    expect(asaasDaConfig('production', undefined, ASAAS_SANDBOX, undefined)).toBeNull();
  });

  it('em produção, só os dois endereços oficiais; fora dela, o do teste vale como Sandbox', () => {
    expect(() => asaasDaConfig('production', DO_SANDBOX, 'https://asaas.exemplo.test/v3', undefined)).toThrow('endereços oficiais do Asaas');
    expect(asaasDaConfig('test', DO_SANDBOX, 'http://127.0.0.1:9/v3', undefined)?.ambiente).toBe('sandbox');
  });

  it('a chave de um ambiente no endereço do outro é recusada, sem a chave na mensagem', () => {
    const contra = (f: () => unknown) => {
      try {
        f();
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    const m1 = contra(() => asaasDaConfig('production', DA_PRODUCAO, ASAAS_SANDBOX, undefined));
    expect(m1).toContain('$aact_hmlg_');
    expect(m1).not.toContain(DA_PRODUCAO);
    const m2 = contra(() => asaasDaConfig('production', DO_SANDBOX, ASAAS_PRODUCAO, undefined));
    expect(m2).toContain('$aact_prod_');
    expect(m2).not.toContain(DO_SANDBOX);
  });

  it('o token do aviso não pode ter espaço', () => {
    expect(() => asaasDaConfig('test', DO_SANDBOX, ASAAS_SANDBOX, 'um token com espaço no meio e mais letras')).toThrow('ASAAS_WEBHOOK_TOKEN não pode ter espaço');
  });
});

describe('o erro do Asaas no cliente HTTP', () => {
  it('o código e o texto vêm de `errors[0]`', () => {
    const h = new Headers();
    expect(erroDoAsaas({ errors: [{ code: 'invalid_value', description: 'O valor não pode ser menor que R$ 5,00' }] }, h)).toEqual({
      codigo: 'invalid_value',
      mensagem: 'O valor não pode ser menor que R$ 5,00',
      esperarMs: null,
    });
    const e = classificar('asaas', 400, { errors: [{ code: 'invalid_cpfCnpj', description: 'O CPF/CNPJ informado é inválido' }] }, h, null);
    expect(e).toMatchObject({ tipo: 'definitivo', codigoProvider: 'invalid_cpfCnpj', message: 'O CPF/CNPJ informado é inválido', mensagemUsuario: 'O CPF/CNPJ informado é inválido' });
  });

  it('o 429 espera o `RateLimit-Reset` (sem `Retry-After`), até uma hora; sem ele, um minuto', () => {
    const com = classificar('asaas', 429, { errors: [{ code: 'rate_limit', description: 'Cota excedida' }] }, new Headers({ 'RateLimit-Reset': '120' }), null);
    expect(com).toMatchObject({ tipo: 'limite', esperarMs: 120_000 });
    const longo = classificar('asaas', 429, {}, new Headers({ 'RateLimit-Reset': '99999' }), null);
    expect(longo.esperarMs).toBe(3_600_000);
    expect(classificar('asaas', 429, {}, new Headers(), null).esperarMs).toBe(60_000);
  });

  it('401 é a chave; 503, passageiro; o erro de outra plataforma não lê o formato do Asaas', () => {
    expect(classificar('asaas', 401, { errors: [{ code: 'invalid_access_token', description: 'A chave é inválida' }] }, new Headers(), null).tipo).toBe('autenticacao');
    expect(classificar('asaas', 503, {}, new Headers(), null).tipo).toBe('transitorio');
    expect(classificar('meta_ads', 400, { errors: [{ code: 'x', description: 'não é da Meta' }] }, new Headers(), null).message).toBe('HTTP 400');
  });
});

describe('a cobrança do Asaas no formato do Liame', () => {
  it('reais e centavos sem perder o centavo', () => {
    expect(paraReais(24_900)).toBe(249);
    expect(paraReais(19_355)).toBe(193.55);
    expect(paraCentavos(193.55)).toBe(19_355);
    expect(paraCentavos(249)).toBe(24_900);
    // Toda a faixa de uma mensalidade ida e volta.
    const falhas: number[] = [];
    for (let c = 500; c <= 100_000; c += 7) if (paraCentavos(paraReais(c)) !== c) falhas.push(c);
    expect(falhas).toEqual([]);
  });

  it('a cobrança lida: o id, a situação, o valor, o vencimento, a fatura hospedada e o id da fatura do Liame; sem id, não é cobrança', () => {
    expect(
      cobrancaDoAsaas({ id: 'pay_1', status: 'PENDING', value: 193.55, dueDate: '2026-11-22', invoiceUrl: 'https://sandbox.asaas.com/i/pay_1', externalReference: 'fat-1' }),
    ).toEqual({ id: 'pay_1', status: 'PENDING', valorCentavos: 19_355, vencimento: '2026-11-22', urlDaFatura: 'https://sandbox.asaas.com/i/pay_1', referencia: 'fat-1', removida: false, pagaNoDia: null });
    expect(cobrancaDoAsaas({ id: 'pay_2', status: 'RECEIVED', value: 249, dueDate: '2026-11-22', deleted: true })?.removida).toBe(true);
    expect(cobrancaDoAsaas({ status: 'PENDING', value: 1, dueDate: '2026-11-22' })).toBeNull();
    expect(cobrancaDoAsaas(null)).toBeNull();
  });

  it('o que vai para o banco cabe nas regras da tabela (V43): o endereço só com https e até 500 letras, o id até 100, a situação em maiúsculas', () => {
    const base = { id: 'pay_1', status: 'PENDING', value: 249, dueDate: '2026-11-22' };
    expect(cobrancaDoAsaas({ ...base, invoiceUrl: 'http://sandbox.asaas.com/i/pay_1' })?.urlDaFatura).toBeNull();
    expect(cobrancaDoAsaas({ ...base, invoiceUrl: `https://sandbox.asaas.com/i/${'x'.repeat(480)}` })?.urlDaFatura).toBeNull();
    expect(cobrancaDoAsaas({ ...base, invoiceUrl: 'https://www.asaas.com/i/pay_1' })?.urlDaFatura).toBe('https://www.asaas.com/i/pay_1');
    expect(cobrancaDoAsaas({ ...base, id: '' })).toBeNull();
    expect(cobrancaDoAsaas({ ...base, id: `pay_${'1'.repeat(97)}` })).toBeNull();
    expect(['PENDING', 'RECEIVED_IN_CASH', 'AWAITING_CHARGEBACK_REVERSAL'].map(situacaoParaGravar)).toEqual(['PENDING', 'RECEIVED_IN_CASH', 'AWAITING_CHARGEBACK_REVERSAL']);
    expect(['pending', 'P', 'PEND1NG', 'A B', 'A'.repeat(61), ''].map(situacaoParaGravar)).toEqual([null, null, null, null, null, null]);
  });

  it('a busca pela fatura: a cobrança removida não conta; uma viva fora do formato é erro, nunca "não existe" (senão nasceria outra)', async () => {
    const comLista = (data: Array<Record<string, unknown>>) =>
      new ApiAsaas({ requisitar: async () => ({ status: 200, corpo: { data }, cabecalhos: new Headers(), uso: null }) } as unknown as ClienteConector, { url: 'http://127.0.0.1:9/v3', chave: DO_SANDBOX });
    const viva = { id: 'pay_2', status: 'PENDING', value: 249, dueDate: '2026-11-22', externalReference: 'fat-1' };
    expect(await comLista([{ ...viva, id: 'pay_1', deleted: true }, viva]).cobrancaPelaReferencia('fat-1')).toMatchObject({ id: 'pay_2' });
    expect(await comLista([{ id: 'pay_1', deleted: true }]).cobrancaPelaReferencia('fat-1')).toBeNull();
    await expect(comLista([{ id: 'pay_3', status: 'PENDING' }]).cobrancaPelaReferencia('fat-1')).rejects.toMatchObject({ tipo: 'definitivo' });
  });

  it('o texto da cobrança: o plano e o período, ou a primeira mensalidade', () => {
    expect(descricaoDaCobranca('Essencial', '2026-10-22', '2026-11-22')).toBe('Liame · plano Essencial · 22/10/2026 a 22/11/2026');
    expect(descricaoDaCobranca('Completo', null, null)).toBe('Liame · plano Completo · primeira mensalidade');
  });

  it('o mínimo do Asaas é R$ 5 (D-A7-32)', () => {
    expect(MINIMO_DA_COBRANCA_CENTAVOS).toBe(500);
  });
});

describe('a fila da cobrança: a espera e o porquê', () => {
  it('a espera sobe de 1 minuto para 5, 30 e 2 horas, e o que o Asaas pediu vence quando é maior', () => {
    expect([1, 2, 3, 4, 9].map((n) => esperaDaCobranca(n, null))).toEqual([60_000, 300_000, 1_800_000, 7_200_000, 7_200_000]);
    expect(esperaDaCobranca(1, 120_000)).toBe(120_000);
    expect(esperaDaCobranca(1, 30_000)).toBe(60_000);
    expect(esperaDaCobranca(0, null)).toBe(60_000);
  });

  it('o porquê em código, pelo tipo do erro', () => {
    expect(falhaDoErro(new ErroConector('limite', 'asaas', 'x', 429, 1000))).toBe('limite_do_meio');
    expect(falhaDoErro(new ErroConector('autenticacao', 'asaas', 'x', 401))).toBe('chave_recusada');
    expect(falhaDoErro(new ErroConector('permissao', 'asaas', 'x', 403))).toBe('chave_recusada');
    expect(falhaDoErro(new ErroConector('definitivo', 'asaas', 'x', 400))).toBe('recusada_pelo_meio');
    expect(falhaDoErro(new ErroConector('transitorio', 'asaas', 'x', 503))).toBe('meio_fora_do_ar');
    expect(falhaDoErro(new ErroConector('circuito_aberto', 'asaas', 'x'))).toBe('meio_fora_do_ar');
    expect(falhaDoErro(new Error('qualquer'))).toBe('meio_fora_do_ar');
  });
});

// W2a, parte 2: a releitura, sem banco nem rede.
const FATURA = '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a';
const cobranca = (mudar: Partial<CobrancaAsaas> = {}): CobrancaAsaas => ({
  id: 'pay_1',
  status: 'PENDING',
  valorCentavos: 24_900,
  vencimento: '2026-11-22',
  urlDaFatura: null,
  referencia: FATURA,
  removida: false,
  pagaNoDia: null,
  ...mudar,
});
const aberta = { id: FATURA, status: 'aberta', amount_cents: '24900' };
const cancelada = { ...aberta, status: 'cancelada' };

describe('a releitura: o que fazer com a fatura depois de ler a cobrança no Asaas (D-A7-28 a D-A7-30)', () => {
  it('a fatura em aberto: paga no Asaas, paga no Liame, com o dia que o Asaas informou; o que conta como pago (D-A7-29)', () => {
    expect([...SITUACOES_PAGAS].sort()).toEqual(['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']);
    for (const status of SITUACOES_PAGAS) {
      expect(decidirReleitura(aberta, cobranca({ status, pagaNoDia: '2026-10-23' }))).toEqual({ acao: 'pagar', pagoNoDia: '2026-10-23' });
    }
    // Pagou a mais (o Asaas aceita?): paga do mesmo jeito; a menos, para, e uma pessoa da distribuição olha.
    expect(decidirReleitura(aberta, cobranca({ status: 'RECEIVED', valorCentavos: 25_000 }))).toMatchObject({ acao: 'pagar' });
    expect(decidirReleitura(aberta, cobranca({ status: 'RECEIVED', valorCentavos: 24_899 }))).toEqual({ acao: 'parar', problema: 'valor_divergente' });
  });

  it('a fatura em aberto: pendente ou vencida espera; a situação que o Liame não conhece também (V149), nunca paga', () => {
    for (const status of ['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS', 'UMA_SITUACAO_NOVA']) {
      expect(decidirReleitura(aberta, cobranca({ status }))).toEqual({ acao: 'esperar' });
    }
  });

  it('a fatura em aberto: a cobrança removida no Asaas (ou que ele não acha) é refeita; a do valor de antes sai e é refeita', () => {
    expect(decidirReleitura(aberta, null)).toEqual({ acao: 'refazer', removerAntes: false });
    expect(decidirReleitura(aberta, cobranca({ removida: true }))).toEqual({ acao: 'refazer', removerAntes: false });
    // A troca de plano reprecificou a mensalidade em aberto: a cobrança de R$ 249 não vale para a de R$ 449.
    expect(decidirReleitura({ ...aberta, amount_cents: '44900' }, cobranca())).toEqual({ acao: 'refazer', removerAntes: true });
  });

  it('a fatura em aberto: a cobrança de outra fatura ou estornada no Asaas para', () => {
    expect(decidirReleitura(aberta, cobranca({ referencia: 'outra-fatura' }))).toEqual({ acao: 'parar', problema: 'referencia_divergente' });
    for (const status of ['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL']) {
      expect(decidirReleitura(aberta, cobranca({ status }))).toEqual({ acao: 'parar', problema: 'estornada_no_meio' });
    }
  });

  it('a fatura cancelada no Liame: a cobrança viva sai do Asaas; a que já saiu encerra a fila; a paga depois de cancelar para', () => {
    expect(decidirReleitura(cancelada, cobranca())).toEqual({ acao: 'remover' });
    expect(decidirReleitura(cancelada, cobranca({ status: 'OVERDUE' }))).toEqual({ acao: 'remover' });
    expect(decidirReleitura(cancelada, null)).toEqual({ acao: 'encerrar' });
    expect(decidirReleitura(cancelada, cobranca({ removida: true }))).toEqual({ acao: 'encerrar' });
    expect(decidirReleitura(cancelada, cobranca({ status: 'RECEIVED' }))).toEqual({ acao: 'parar', problema: 'paga_apos_cancelar' });
    // A paga no Liame (por outro caminho) só sai da fila.
    expect(decidirReleitura({ ...aberta, status: 'paga' }, cobranca({ status: 'RECEIVED' }))).toEqual({ acao: 'encerrar' });
  });
});

describe('o dia do pagamento', () => {
  it('o dia do Asaas: AAAA-MM-DD (com ou sem a hora), conferido no calendário (V122)', () => {
    expect(diaDoAsaas('2026-10-23')).toBe('2026-10-23');
    expect(diaDoAsaas('2026-10-23 16:45:03')).toBe('2026-10-23');
    expect(['2026-13-01', '2026-02-30', '2026-10-32', '20261023', '2026/10/23', 'amanhã', '', null, 20261023].map(diaDoAsaas)).toEqual(Array(9).fill(null));
  });

  it('a cobrança lida traz o dia em que o cliente pagou, senão o do pagamento, senão o da confirmação', () => {
    const base = { id: 'pay_1', status: 'RECEIVED', value: 249, dueDate: '2026-11-22' };
    expect(cobrancaDoAsaas({ ...base, clientPaymentDate: '2026-10-21', paymentDate: '2026-10-22', confirmedDate: '2026-10-23' })?.pagaNoDia).toBe('2026-10-21');
    expect(cobrancaDoAsaas({ ...base, clientPaymentDate: null, paymentDate: '2026-10-22', confirmedDate: '2026-10-23' })?.pagaNoDia).toBe('2026-10-22');
    expect(cobrancaDoAsaas({ ...base, confirmedDate: '2026-10-23' })?.pagaNoDia).toBe('2026-10-23');
    expect(cobrancaDoAsaas({ ...base, paymentDate: '2026-02-30' })?.pagaNoDia).toBeNull();
  });

  it('o instante para o `pagarFatura`: meio-dia de São Paulo do dia informado, nunca depois de agora; sem o dia, agora', () => {
    const depois = new Date('2026-10-24T09:00:00Z');
    expect(pagoEmDaCobranca('2026-10-23', depois).toISOString()).toBe('2026-10-23T15:00:00.000Z');
    // A releitura no mesmo dia, de manhã: agora (o dia, em São Paulo, é o mesmo).
    const manha = new Date('2026-10-23T11:00:00Z');
    expect(pagoEmDaCobranca('2026-10-23', manha)).toBe(manha);
    expect(pagoEmDaCobranca(null, manha)).toBe(manha);
  });
});

describe('o aviso do Asaas', () => {
  const corpo = (mudar: Record<string, unknown> = {}) =>
    JSON.stringify({ id: 'evt_05b708f961d739ea7eba7e4db318f621&368604920', event: 'PAYMENT_RECEIVED', payment: { id: 'pay_080225913252', externalReference: FATURA }, ...mudar });

  it('o evento: o id (até 200 letras) e o tipo nas regras da situação; fora disso, não é aviso', () => {
    expect(eventoDoAsaas(corpo())).toEqual({ id: 'evt_05b708f961d739ea7eba7e4db318f621&368604920', tipo: 'PAYMENT_RECEIVED' });
    expect(eventoDoAsaas(corpo({ id: '' }))).toBeNull();
    expect(eventoDoAsaas(corpo({ id: 'e'.repeat(201) }))).toBeNull();
    expect(eventoDoAsaas(corpo({ event: 'payment_received' }))).toBeNull();
    expect(eventoDoAsaas(corpo({ event: 7 }))).toBeNull();
    expect(eventoDoAsaas('não é JSON')).toBeNull();
    expect(eventoDoAsaas('null')).toBeNull();
  });

  it('a cobrança do aviso: o id no Asaas e o id da fatura do Liame, só no formato (o id da fatura vira `uuid` no SQL)', () => {
    expect(cobrancaDoAviso(corpo())).toEqual({ cobranca: 'pay_080225913252', fatura: FATURA });
    expect(cobrancaDoAviso(corpo({ payment: { id: 'pay_1', externalReference: '056984' } }))).toEqual({ cobranca: 'pay_1', fatura: null });
    expect(cobrancaDoAviso(corpo({ payment: { id: 'pay_1', externalReference: `${FATURA.slice(0, 35)}g` } }))).toEqual({ cobranca: 'pay_1', fatura: null });
    expect(cobrancaDoAviso(corpo({ payment: null }))).toEqual({ cobranca: null, fatura: null });
    expect(cobrancaDoAviso('{')).toEqual({ cobranca: null, fatura: null });
  });
});
