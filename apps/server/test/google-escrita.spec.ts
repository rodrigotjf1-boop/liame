import { describe, expect, it } from 'vitest';
import {
  BALDE_DA_ESCRITA_GOOGLE,
  campanhaDoRecurso,
  type EstadoDaCampanhaGoogle,
  estadoDaLinha,
  motivoDoCompartilhado,
  mudancaPedida,
  OPERACOES_DE_ESCRITA_POR_DIA,
  recusaDoGoogle,
  versaoDaCampanha,
} from '../src/actions/google-anuncios.js';
import { classificar, ErroConector, falhaDoGoogleAds } from '../src/connectors/cliente-http.js';

// A5 · Y2 sem banco: como o conector de escrita do Google Ads lê o estado de uma campanha, decide o que muda e traduz
// o que o Google responde. As regras que não dependem de rede: o orçamento compartilhado nunca muda, uma coisa por
// pedido, e o erro específico do Google (o `GoogleAdsFailure`) vira código, texto e espera.

const REAL = 1_000_000;
const LINHA = {
  campaign: { id: '777', name: 'Busca hambúrguer perto', status: 'ENABLED', primaryStatus: 'ELIGIBLE', campaignBudget: 'customers/1/campaignBudgets/55' },
  campaignBudget: { id: '55', amountMicros: '30000000', explicitlyShared: false, referenceCount: '1', period: 'DAILY' },
};
const estado = (extra: Partial<EstadoDaCampanhaGoogle> = {}): EstadoDaCampanhaGoogle => ({ ...estadoDaLinha(LINHA, '777', 'BRL')!, ...extra });

describe('escrita no Google Ads: o estado da campanha (A5, Y2)', () => {
  it('o recurso é só campanha, com o id em dígitos', () => {
    expect(campanhaDoRecurso('campanha:123456')).toBe('123456');
    for (const errado of ['conjunto:123', 'anuncio:123', 'campanha:', 'campanha:12a', 'campanha:1 OR 1=1', 'campanha:123456789012345678901', '123']) expect(campanhaDoRecurso(errado), errado).toBeNull();
  });

  it('a verba diária da campanha é a do orçamento que é só dela; o compartilhado e o de período não contam como verba própria', () => {
    expect(estado()).toEqual({
      tipo: 'campanha',
      id: '777',
      nome: 'Busca hambúrguer perto',
      status: 'ativo',
      status_efetivo: 'ELIGIBLE',
      daily_budget_micros: 30 * REAL,
      lifetime_budget_micros: null,
      moeda: 'BRL',
      orcamento: { id: '55', compartilhado: false, campanhas: 1, diario_micros: 30 * REAL },
    });
    // Criado para ser dividido, ou usado por mais de uma campanha: compartilhado, sem verba própria.
    const explicito = estadoDaLinha({ ...LINHA, campaignBudget: { ...LINHA.campaignBudget, explicitlyShared: true } }, '777', 'BRL')!;
    expect(explicito).toMatchObject({ daily_budget_micros: null, orcamento: { compartilhado: true, campanhas: 1, diario_micros: 30 * REAL } });
    const dividido = estadoDaLinha({ ...LINHA, campaignBudget: { ...LINHA.campaignBudget, referenceCount: '3' } }, '777', 'BRL')!;
    expect(dividido).toMatchObject({ daily_budget_micros: null, orcamento: { compartilhado: true, campanhas: 3 } });
    // De período: o total, sem verba diária.
    const periodo = estadoDaLinha({ ...LINHA, campaignBudget: { id: '55', totalAmountMicros: '900000000', explicitlyShared: false, referenceCount: '1', period: 'CUSTOM_PERIOD' } }, '777', 'BRL')!;
    expect(periodo).toMatchObject({ daily_budget_micros: null, lifetime_budget_micros: 900 * REAL, orcamento: { compartilhado: false, diario_micros: null } });
    // Sem orçamento na linha, pausada, removida e com situação que o Liame não conhece.
    expect(estadoDaLinha({ campaign: { ...LINHA.campaign, status: 'PAUSED' } }, '777', 'BRL')).toMatchObject({ status: 'pausado', daily_budget_micros: null, orcamento: null });
    expect(estadoDaLinha({ campaign: { ...LINHA.campaign, status: 'REMOVED' } }, '777', null)).toMatchObject({ status: 'removido', moeda: null });
    expect(estadoDaLinha({ campaign: { ...LINHA.campaign, status: 'NOVO_NO_GOOGLE' } }, '777', 'BRL')).toMatchObject({ status: 'desconhecido' });
    // A linha de outra campanha não serve.
    expect(estadoDaLinha(LINHA, '778', 'BRL')).toBeNull();
    expect(estadoDaLinha({}, '777', 'BRL')).toBeNull();
  });

  it('a versão muda com a situação, a verba e o orçamento (outro, ou o mesmo passando a ser dividido), e só com isso', () => {
    const base = versaoDaCampanha(estado());
    expect(base).toBeGreaterThan(0);
    expect(versaoDaCampanha(estado({ nome: 'Outro nome', status_efetivo: 'LIMITED' }))).toBe(base);
    // Mais uma campanha num orçamento que já era compartilhado não muda nada para esta.
    const compartilhado = estado({ daily_budget_micros: null, orcamento: { id: '55', compartilhado: true, campanhas: 2, diario_micros: 30 * REAL } });
    expect(versaoDaCampanha({ ...compartilhado, orcamento: { ...compartilhado.orcamento!, campanhas: 5 } })).toBe(versaoDaCampanha(compartilhado));
    const outras = [
      estado({ status: 'pausado' }),
      estado({ daily_budget_micros: 33 * REAL, orcamento: { id: '55', compartilhado: false, campanhas: 1, diario_micros: 33 * REAL } }),
      estado({ orcamento: { id: '56', compartilhado: false, campanhas: 1, diario_micros: 30 * REAL } }),
      compartilhado,
      estado({ lifetime_budget_micros: 900 * REAL }),
    ].map(versaoDaCampanha);
    expect(new Set([base, ...outras]).size).toBe(outras.length + 1);
  });
});

describe('escrita no Google Ads: o que muda (A5, Y2)', () => {
  it('uma coisa por pedido: a situação (ativa ou pausada) ou a verba diária do orçamento que é só da campanha', () => {
    const atual = estado();
    expect(mudancaPedida(atual, { ...atual })).toEqual({ tipo: 'nada' });
    expect(mudancaPedida(atual, { ...atual, status: 'pausado' })).toEqual({ tipo: 'situacao', status: 'PAUSED' });
    expect(mudancaPedida(estado({ status: 'pausado' }), { ...atual, status: 'ativo' })).toEqual({ tipo: 'situacao', status: 'ENABLED' });
    expect(mudancaPedida(atual, { ...atual, daily_budget_micros: 33 * REAL })).toEqual({ tipo: 'verba', orcamentoId: '55', micros: 33 * REAL });
    // O que a ferramenta não mexe (o nome, o orçamento descrito no estado) não conta.
    expect(mudancaPedida(atual, { ...atual, nome: 'Outro', orcamento: null })).toEqual({ tipo: 'nada' });

    const invalida = (desejado: Record<string, unknown>, de = atual) => {
      const m = mudancaPedida(de, desejado);
      return m.tipo === 'invalida' ? m.motivo : `não recusou: ${m.tipo}`;
    };
    expect(invalida({ ...atual, status: 'pausado', daily_budget_micros: 33 * REAL })).toContain('não as duas de uma vez');
    expect(invalida({ ...atual, status: 'removido' })).toBe('Pelo Liame, uma campanha só é ativada ou pausada.');
    expect(invalida({ ...atual, status: 'ativo' }, estado({ status: 'removido' }))).toBe('A campanha foi removida no Google: não dá para mudar a situação dela.');
    expect(invalida({ ...atual, id: '778' })).toBe('O pedido não é desta campanha.');
    expect(invalida({ ...atual, tipo: 'conjunto' })).toBe('O pedido não é desta campanha.');
    expect(invalida({ ...atual, lifetime_budget_micros: 100 * REAL })).toBe('A verba de período não muda pelo Liame.');
    for (const verba of [0, -5 * REAL, 33 * REAL + 1, 1.5, '33000000', null]) expect(invalida({ ...atual, daily_budget_micros: verba }), String(verba)).toBe('A verba diária precisa ser um valor positivo, sem fração de centavo.');
  });

  it('orçamento compartilhado nunca muda, peça quem pedir, e o motivo diz quantas campanhas dividem', () => {
    const o = { id: '55', compartilhado: true, campanhas: 2, diario_micros: 80 * REAL };
    const atual = estado({ daily_budget_micros: null, orcamento: o });
    const m = mudancaPedida(atual, { ...atual, daily_budget_micros: 88 * REAL });
    expect(m).toEqual({ tipo: 'invalida', motivo: motivoDoCompartilhado(o) });
    expect(motivoDoCompartilhado(o)).toBe('A verba desta campanha vem de um orçamento compartilhado com outra campanha no Google: mudar aqui mudaria a verba dela também. O Liame não muda orçamento compartilhado.');
    expect(motivoDoCompartilhado({ ...o, campanhas: 4 })).toContain('com outras 3 campanhas no Google: mudar aqui mudaria a verba delas também');
    expect(motivoDoCompartilhado({ ...o, campanhas: 1 })).toContain('compartilhado entre campanhas no Google');
    // Pausar e retomar a campanha de um orçamento compartilhado pode: só ela muda.
    expect(mudancaPedida(atual, { ...atual, status: 'pausado' })).toEqual({ tipo: 'situacao', status: 'PAUSED' });
    // Sem orçamento diário próprio (de período): não há o que mudar.
    const periodo = estado({ daily_budget_micros: null, lifetime_budget_micros: 900 * REAL, orcamento: { id: '55', compartilhado: false, campanhas: 1, diario_micros: null } });
    expect(mudancaPedida(periodo, { ...periodo, daily_budget_micros: 30 * REAL })).toEqual({ tipo: 'invalida', motivo: 'Esta campanha não tem verba diária própria: a verba dela é de período.' });
  });

  it('a cota diária da escrita é por empresa e bem abaixo do limite do projeto no Google', () => {
    expect(OPERACOES_DE_ESCRITA_POR_DIA).toBeLessThanOrEqual(2_880 / 4);
    expect(BALDE_DA_ESCRITA_GOOGLE.capacidade).toBe(OPERACOES_DE_ESCRITA_POR_DIA);
    // O balde enche a cota inteira em um dia.
    expect(BALDE_DA_ESCRITA_GOOGLE.porSegundo * 86_400).toBeCloseTo(OPERACOES_DE_ESCRITA_POR_DIA, 6);
  });
});

describe('escrita no Google Ads: o que o Google responde (A5, Y2)', () => {
  const falha = (codigo: Record<string, string>, texto: string, esperar?: string) => ({
    code: 400,
    message: 'Request contains an invalid argument.',
    status: 'INVALID_ARGUMENT',
    details: [
      {
        '@type': 'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
        errors: [{ errorCode: codigo, message: texto, ...(esperar ? { details: { quotaErrorDetails: { rateScope: 'DEVELOPER', retryDelay: esperar } } } : {}) }],
        requestId: 'x',
      },
    ],
  });

  it('o erro específico vem de dentro de `details`: o código, o texto e a espera da cota', () => {
    expect(falhaDoGoogleAds(falha({ campaignBudgetError: 'MONEY_AMOUNT_TOO_LARGE' }, 'A money amount was greater than the maximum allowed.'))).toEqual({
      codigo: 'campaignBudgetError.MONEY_AMOUNT_TOO_LARGE',
      mensagem: 'A money amount was greater than the maximum allowed.',
      esperarMs: null,
    });
    expect(falhaDoGoogleAds(falha({ quotaError: 'RESOURCE_EXHAUSTED' }, 'Too many requests.', '900s'))).toMatchObject({ codigo: 'quotaError.RESOURCE_EXHAUSTED', esperarMs: 900_000 });
    expect(falhaDoGoogleAds(falha({ quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' }, 'Too many.', '1.5s')).esperarMs).toBe(1_500);
    // O que não tem esse formato (outra API do Google, corpo vazio, código estranho) não vira nada.
    const vazio = { codigo: null, mensagem: null, esperarMs: null };
    expect(falhaDoGoogleAds({ code: 400, message: 'x', status: 'INVALID_ARGUMENT' })).toEqual(vazio);
    expect(falhaDoGoogleAds({ details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'INVALID_GCLID' }] })).toEqual(vazio);
    expect(falhaDoGoogleAds({ details: 'texto' })).toEqual(vazio);
    expect(falhaDoGoogleAds(falha({ 'código com espaço': 'X' }, 'm', 'logo')).codigo).toBeNull();
    expect(falhaDoGoogleAds(falha({ quotaError: 'RESOURCE_EXHAUSTED' }, 'm', 'logo')).esperarMs).toBeNull();
  });

  it('a classificação do erro do Google Ads leva o código específico, o texto e a espera pedida; a das outras plataformas não muda', () => {
    const h = new Headers();
    const recusa = classificar('google_ads', 400, { error: falha({ campaignBudgetError: 'MONEY_AMOUNT_TOO_LARGE' }, 'A money amount was greater than the maximum allowed.') }, h, null);
    expect(recusa).toMatchObject({ tipo: 'definitivo', codigoProvider: '400', subcodigo: 'campaignBudgetError.MONEY_AMOUNT_TOO_LARGE', mensagemUsuario: 'A money amount was greater than the maximum allowed.' });
    const cota = classificar('google_ads', 429, { error: { ...falha({ quotaError: 'RESOURCE_EXHAUSTED' }, 'Too many requests.', '900s'), code: 429, status: 'RESOURCE_EXHAUSTED' } }, h, null);
    expect(cota).toMatchObject({ tipo: 'limite', subcodigo: 'quotaError.RESOURCE_EXHAUSTED', esperarMs: 900_000 });
    // Sem a espera no corpo, vale um minuto, como antes.
    expect(classificar('google_ads', 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, h, null)).toMatchObject({ tipo: 'limite', esperarMs: 60_000, subcodigo: null, mensagemUsuario: null });
    // O mesmo corpo vindo de outro provedor não é lido como erro do Google Ads.
    expect(classificar('meta_ads', 400, { error: falha({ campaignBudgetError: 'X' }, 'm') }, h, null)).toMatchObject({ subcodigo: null, mensagemUsuario: null });
  });

  it('a recusa em palavras: o que é definitivo vira motivo; o que é passageiro sobe para quem executa adiar', () => {
    const erro = (tipo: ConstructorParameters<typeof ErroConector>[0], mensagem: string, detalhe: { subcodigo?: string; mensagemUsuario?: string } = {}) => new ErroConector(tipo, 'google_ads', mensagem, 400, null, '400', detalhe);
    expect(recusaDoGoogle(erro('definitivo', 'Request contains an invalid argument.', { subcodigo: 'campaignBudgetError.MONEY_AMOUNT_TOO_LARGE', mensagemUsuario: 'A money amount was greater than the maximum allowed.' }))).toBe(
      'O Google recusou a mudança: A money amount was greater than the maximum allowed (campaignBudgetError.MONEY_AMOUNT_TOO_LARGE).',
    );
    expect(recusaDoGoogle(erro('definitivo', 'Request contains an invalid argument.'))).toBe('O Google recusou a mudança: Request contains an invalid argument.');
    expect(recusaDoGoogle(erro('definitivo', 'Unrecognized field.'), 'leitura')).toBe('O Google não deixou ler a campanha antes de mudar: Unrecognized field. Nada foi mudado.');
    expect(recusaDoGoogle(erro('autenticacao', 'x'))).toContain('Conecte o Google de novo em Contas conectadas');
    expect(recusaDoGoogle(erro('permissao', 'x'))).toContain('não tem permissão para gerenciar as campanhas desta conta');
    for (const passageiro of ['limite', 'transitorio', 'circuito_aberto'] as const) expect(recusaDoGoogle(erro(passageiro, 'x'))).toBeNull();
    expect(recusaDoGoogle(new Error('defeito nosso'))).toBeNull();
  });
});
