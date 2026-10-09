import { describe, expect, it } from 'vitest';
import { recusaDoGoogle } from '../src/actions/google-anuncios.js';
import { recusaDaMeta } from '../src/actions/meta-anuncios.js';
import { motivoDaRecusa, respostaDaPlataforma } from '../src/actions/resposta-da-plataforma.js';
import { ErroConector } from '../src/connectors/cliente-http.js';

// A5 · Y3: o motivo da recusa que fica no pedido e a volta dele, para a tela pôr entre aspas só o que é da plataforma.

const doGoogle = (texto: string, codigo: string | null) => new ErroConector('definitivo', 'google_ads', 'Request contains an invalid argument.', 400, null, 'INVALID_ARGUMENT', { subcodigo: codigo, mensagemUsuario: texto });
const daMeta = (texto: string) => new ErroConector('definitivo', 'meta_ads', 'Invalid parameter', 400, null, '100', { subcodigo: '1885272', mensagemUsuario: texto });

describe('o que a plataforma respondeu ao recusar (A5 · Y3)', () => {
  it('Google: o motivo guarda o texto dele e o código entre parênteses; a volta separa os dois', () => {
    const motivo = recusaDoGoogle(doGoogle("Budget amount must be above this campaign's per-day minimum.", 'campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM'));
    expect(motivo).toBe("O Google recusou a mudança: Budget amount must be above this campaign's per-day minimum (campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM).");
    expect(respostaDaPlataforma('google_ads', motivo)).toEqual({ text: "Budget amount must be above this campaign's per-day minimum.", code: 'campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM' });
  });

  it('Google sem o erro específico: só o texto geral, sem código; parênteses que não são código ficam no texto', () => {
    const semCodigo = recusaDoGoogle(doGoogle('Request contains an invalid argument.', null));
    expect(semCodigo).toBe('O Google recusou a mudança: Request contains an invalid argument.');
    expect(respostaDaPlataforma('google_ads', semCodigo)).toEqual({ text: 'Request contains an invalid argument.', code: null });
    expect(respostaDaPlataforma('google_ads', motivoDaRecusa('google_ads', 'The budget is shared (see the shared library)'))).toEqual({ text: 'The budget is shared (see the shared library).', code: null });
  });

  it('Meta: o texto que ela escreve para a pessoa, com a pontuação dela, e sem código', () => {
    const motivo = recusaDaMeta(daMeta('O orçamento diário precisa ser de pelo menos R$ 6,00.'));
    expect(motivo).toBe('A Meta recusou a mudança: O orçamento diário precisa ser de pelo menos R$ 6,00.');
    expect(respostaDaPlataforma('meta_ads', motivo)).toEqual({ text: 'O orçamento diário precisa ser de pelo menos R$ 6,00.', code: null });
  });

  it('o que é frase do Liame não vira resposta da plataforma', () => {
    // A autorização venceu, o objeto sumiu, a leitura falhou, a plataforma mandou esperar: nada disso é citação.
    for (const motivo of [
      'O Google recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte o Google de novo em Contas conectadas.',
      'O Google não tem mais esta campanha nesta conta (foi removida, ou a conta foi desconectada). Nada foi mudado.',
      recusaDoGoogle(doGoogle('The campaign was not found.', 'mutateError.RESOURCE_NOT_FOUND'), 'leitura'),
      'o Google pediu para esperar; depois de 6 tentativas, a ação foi encerrada.',
      'A verba desta campanha vem de um orçamento compartilhado com outra campanha no Google: mudar aqui mudaria a verba dela também. O Liame não muda orçamento compartilhado.',
      'O Google recusou a mudança: ',
      null,
    ]) {
      expect(respostaDaPlataforma('google_ads', motivo), String(motivo)).toBeNull();
    }
    expect(respostaDaPlataforma('meta_ads', 'A Meta não deixou ler o objeto antes de mudar: Invalid parameter. Nada foi mudado.')).toBeNull();
    // O motivo de uma plataforma não é lido como o de outra, e a plataforma sem recusa conhecida não tem resposta.
    expect(respostaDaPlataforma('meta_ads', 'O Google recusou a mudança: Request contains an invalid argument.')).toBeNull();
    expect(respostaDaPlataforma('regem', 'A Meta recusou a mudança: algo')).toBeNull();
  });
});
