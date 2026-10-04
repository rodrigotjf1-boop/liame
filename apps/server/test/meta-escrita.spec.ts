import { describe, expect, it } from 'vitest';
import { type EstadoDoObjeto, emMenorUnidade, mudancaPedida, objetoDoRecurso, recusaDaMeta, versaoDoEstado } from '../src/actions/meta-anuncios.js';
import { classificar, ErroConector } from '../src/connectors/cliente-http.js';
import { esperaDoAdiamento, MAX_ADIAMENTOS } from '../src/worker/action-executor.js';

// Escrita na Meta (A4, X1), sem banco nem rede: o que o conector decide por conta própria. O recurso do pedido, a
// versão tirada do estado, a verba na menor unidade da moeda, o que precisa mudar na Meta, a recusa em palavras e
// quanto a execução espera quando a Meta manda esperar.

const campanha = (extra: Partial<EstadoDoObjeto> = {}): EstadoDoObjeto => ({
  tipo: 'campanha',
  id: '120210000000000001',
  nome: 'Delivery noite',
  status: 'ativo',
  status_efetivo: 'ACTIVE',
  daily_budget_micros: 30_000_000,
  lifetime_budget_micros: null,
  moeda: 'BRL',
  ...extra,
});
const anuncio = (extra: Partial<EstadoDoObjeto> = {}): EstadoDoObjeto => campanha({ tipo: 'anuncio', id: '120210000000001001', nome: 'Combo sexta', daily_budget_micros: null, ...extra });

describe('o recurso do pedido', () => {
  it('campanha, conjunto e anúncio pelo id da Meta; o resto não é recurso', () => {
    expect(objetoDoRecurso('campanha:120210000000000001')).toEqual({ tipo: 'campanha', externalId: '120210000000000001' });
    expect(objetoDoRecurso('conjunto:120210000000000101')).toEqual({ tipo: 'conjunto', externalId: '120210000000000101' });
    expect(objetoDoRecurso('anuncio:120210000000001001')).toEqual({ tipo: 'anuncio', externalId: '120210000000001001' });
    // O id entra no caminho da URL: só dígitos.
    for (const ruim of ['campanha:', 'campanha:12a', 'campanha:1/insights', 'campanha:../me', 'cupom:SEXTA15', 'act_123', 'campaign:1', 'campanha:1?fields=x', `campanha:${'9'.repeat(26)}`]) {
      expect({ ruim, objeto: objetoDoRecurso(ruim) }).toEqual({ ruim, objeto: null });
    }
  });
});

describe('a versão sai do próprio estado', () => {
  it('muda com a situação e com a verba, e só com elas', () => {
    const base = versaoDoEstado(campanha());
    expect(versaoDoEstado(campanha())).toBe(base);
    // O nome e a situação de entrega não são mudança de alguém neste objeto.
    expect(versaoDoEstado(campanha({ nome: 'Delivery noite (teste)', status_efetivo: 'IN_PROCESS' }))).toBe(base);
    expect(versaoDoEstado(campanha({ status: 'pausado' }))).not.toBe(base);
    expect(versaoDoEstado(campanha({ daily_budget_micros: 24_000_000 }))).not.toBe(base);
    expect(versaoDoEstado(campanha({ lifetime_budget_micros: 900_000_000 }))).not.toBe(base);
  });

  it('cabe na coluna inteira do pedido e nunca é zero', () => {
    for (let i = 1; i <= 200; i++) {
      const v = versaoDoEstado(campanha({ daily_budget_micros: i * 10_000 }));
      expect(Number.isInteger(v) && v >= 1 && v <= 2_147_483_646).toBe(true);
    }
  });
});

describe('a verba na menor unidade da moeda', () => {
  it('real em centavos; moeda sem casas na própria unidade; fração de centavo não vale', () => {
    expect(emMenorUnidade(24_000_000, 'BRL')).toBe(2400);
    expect(emMenorUnidade(24_990_000, 'BRL')).toBe(2499);
    expect(emMenorUnidade(24_995_000, 'BRL')).toBeNull();
    expect(emMenorUnidade(5_000_000_000, 'CLP')).toBe(5000);
    expect(emMenorUnidade(5_000_500_000, 'CLP')).toBeNull();
    // Sem a moeda da conta, vale a regra das duas casas.
    expect(emMenorUnidade(1_000_000, null)).toBe(100);
    for (const ruim of [0, -10_000, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(emMenorUnidade(ruim, 'BRL')).toBeNull();
  });
});

describe('o que precisa mudar na Meta', () => {
  it('a verba diária vai em centavos; a situação, como a Meta chama; o que já está igual não vai', () => {
    expect(mudancaPedida(campanha(), { ...campanha(), daily_budget_micros: 24_000_000 })).toEqual({ tipo: 'mudar', params: { daily_budget: '2400' } });
    expect(mudancaPedida(campanha(), { ...campanha(), status: 'pausado' })).toEqual({ tipo: 'mudar', params: { status: 'PAUSED' } });
    expect(mudancaPedida(campanha({ status: 'pausado' }), { ...campanha(), status: 'ativo' })).toEqual({ tipo: 'mudar', params: { status: 'ACTIVE' } });
    expect(mudancaPedida(anuncio(), { ...anuncio(), status: 'pausado' })).toEqual({ tipo: 'mudar', params: { status: 'PAUSED' } });
    expect(mudancaPedida(campanha(), { ...campanha(), status: 'pausado', daily_budget_micros: 20_000_000 })).toEqual({ tipo: 'mudar', params: { status: 'PAUSED', daily_budget: '2000' } });
  });

  it('já está como o pedido queria: nada a escrever (o nome e a entrega podem ter mudado)', () => {
    expect(mudancaPedida(campanha(), campanha())).toEqual({ tipo: 'nada' });
    expect(mudancaPedida(campanha({ nome: 'Outro nome', status_efetivo: 'WITH_ISSUES' }), campanha())).toEqual({ tipo: 'nada' });
    // O que o executor guarda a mais no resultado não é mudança.
    expect(mudancaPedida(campanha(), { ...campanha(), conferido: true, sem_escrita: true })).toEqual({ tipo: 'nada' });
  });

  it('o que o Liame não muda vira recusa com o motivo, sem chamar a Meta', () => {
    const motivo = (atual: EstadoDoObjeto, desejado: Record<string, unknown>) => {
      const m = mudancaPedida(atual, desejado);
      return m.tipo === 'invalida' ? m.motivo : m.tipo;
    };
    expect(motivo(campanha(), { ...campanha(), id: '999' })).toBe('O pedido não é deste objeto.');
    expect(motivo(campanha(), { ...campanha(), tipo: 'conjunto' })).toBe('O pedido não é deste objeto.');
    expect(motivo(campanha(), { ...campanha(), status: 'arquivado' })).toBe('Pelo Liame, um objeto de anúncio só é ativado ou pausado.');
    expect(motivo(campanha(), { ...campanha(), status: 'removido' })).toBe('Pelo Liame, um objeto de anúncio só é ativado ou pausado.');
    expect(motivo(campanha({ status: 'arquivado' }), { ...campanha(), status: 'ativo' })).toBe('O objeto foi arquivado ou removido na Meta: não dá para mudar a situação dele.');
    expect(motivo(anuncio(), { ...anuncio(), daily_budget_micros: 10_000_000 })).toBe('Anúncio não tem verba própria: a verba fica na campanha ou no conjunto.');
    // A verba de outro nível (campanha com verba de campanha, ou conjunto com verba de período) não se cria por aqui.
    expect(motivo(campanha({ daily_budget_micros: null }), { ...campanha(), daily_budget_micros: 10_000_000 })).toBe('Este objeto não tem verba diária: a verba fica em outro nível, ou é de período.');
    expect(motivo(campanha(), { ...campanha(), daily_budget_micros: 24_995_000 })).toBe('A verba diária precisa ser um valor positivo, sem fração de centavo.');
    expect(motivo(campanha(), { ...campanha(), daily_budget_micros: 0 })).toBe('A verba diária precisa ser um valor positivo, sem fração de centavo.');
    expect(motivo(campanha(), { ...campanha(), daily_budget_micros: null })).toBe('A verba diária precisa ser um valor positivo, sem fração de centavo.');
    expect(motivo(campanha(), { ...campanha(), daily_budget_micros: '2400' })).toBe('A verba diária precisa ser um valor positivo, sem fração de centavo.');
    expect(motivo(campanha(), { ...campanha(), lifetime_budget_micros: 900_000_000 })).toBe('A verba de período não muda pelo Liame.');
  });
});

describe('a resposta da Meta: recusa de vez ou espera', () => {
  const h = new Headers();
  const erro = (status: number, error: Record<string, unknown>, cabecalhos = h) => classificar('meta_ads', status, { error }, cabecalhos, null);

  it('o erro guarda o subcódigo e o texto que a Meta escreve para a pessoa', () => {
    const e = erro(400, { code: 100, error_subcode: 1885272, message: 'Invalid parameter', error_user_title: 'Orçamento baixo demais', error_user_msg: 'O orçamento diário mínimo é R$ 6,00.' });
    expect([e.tipo, e.codigoProvider, e.subcodigo, e.mensagemUsuario]).toEqual(['definitivo', '100', '1885272', 'O orçamento diário mínimo é R$ 6,00.']);
    // Sem o texto, o título; sem nenhum dos dois, nada.
    expect(erro(400, { code: 100, message: 'x', error_user_title: 'Só o título' }).mensagemUsuario).toBe('Só o título');
    expect(erro(400, { code: 100, message: 'x' }).mensagemUsuario).toBeNull();
    expect(erro(400, { code: 100, message: 'x' }).subcodigo).toBeNull();
  });

  it('recusa de vez: validação, permissão e autorização, cada uma com o que a pessoa faz', () => {
    expect(recusaDaMeta(erro(400, { code: 100, message: 'Invalid parameter', error_user_msg: 'O orçamento diário mínimo é R$ 6,00.' }))).toBe('A Meta recusou a mudança: O orçamento diário mínimo é R$ 6,00.');
    expect(recusaDaMeta(erro(400, { code: 100, message: 'Invalid parameter' }))).toBe('A Meta recusou a mudança: Invalid parameter');
    expect(recusaDaMeta(erro(400, { code: 200, message: 'Permissions error' }))).toContain('não tem permissão para gerenciar os anúncios desta conta');
    expect(recusaDaMeta(erro(400, { code: 190, message: 'Error validating access token' }))).toContain('Conecte a Meta de novo em Contas conectadas');
    // Na leitura do estado, o erro definitivo que não é "o objeto não existe" aparece com o motivo (um campo que a versão não tem mais).
    expect(recusaDaMeta(erro(400, { code: 100, message: '(#100) Tried accessing nonexisting field (account_id)' }), 'leitura')).toBe(
      'A Meta não deixou ler o objeto antes de mudar: (#100) Tried accessing nonexisting field (account_id). Nada foi mudado.',
    );
    // 368: a Meta barrou a ação por política. Não se insiste.
    expect(recusaDaMeta(erro(400, { code: 368, message: 'The action attempted has been deemed abusive or is otherwise disallowed' }))).toContain('A Meta recusou a mudança');
  });

  it('limite de uso e fora do ar não são recusa: sobem para a execução esperar', () => {
    for (const codigo of [4, 17, 613, 80000, 80003, 80004, 80014]) {
      const e = erro(400, { code: codigo, message: 'limite' });
      expect({ codigo, tipo: e.tipo, recusa: recusaDaMeta(e) }).toEqual({ codigo, tipo: 'limite', recusa: null });
    }
    expect(recusaDaMeta(erro(500, { code: 2, message: 'Service temporarily unavailable' }))).toBeNull();
    expect(recusaDaMeta(new ErroConector('circuito_aberto', 'meta_ads', 'muitas falhas'))).toBeNull();
    expect(recusaDaMeta(new Error('defeito'))).toBeNull();
  });

  it('a verba do conjunto mudou 4 vezes na hora: a Meta bloqueia por uma hora, e a espera é de uma hora', () => {
    expect(erro(400, { code: 613, error_subcode: 1487632, message: 'You can only change your ad set budget 4 times per hour' }).esperarMs).toBe(3_600_000);
    // Outro limite com o mesmo código: o que a Meta pedir, ou 1 minuto.
    expect(erro(400, { code: 613, error_subcode: 1487742, message: 'too many calls' }).esperarMs).toBe(60_000);
    const pediu = new Headers({ 'x-business-use-case-usage': JSON.stringify({ '123': [{ call_count: 100, total_cputime: 20, total_time: 20, estimated_time_to_regain_access: 12 }] }) });
    const uso = { maiorPct: 100, esperarMs: 12 * 60_000 };
    expect(classificar('meta_ads', 400, { error: { code: 17, error_subcode: 2446079, message: 'User request limit reached' } }, pediu, uso).esperarMs).toBe(12 * 60_000);
  });
});

describe('quanto a execução espera', () => {
  it('o que a plataforma pediu, ou 1 minuto dobrando; nunca menos que o recuo da vez, nunca mais que 2 horas', () => {
    expect(esperaDoAdiamento(null, 1)).toBe(60_000);
    expect(esperaDoAdiamento(null, 2)).toBe(120_000);
    expect(esperaDoAdiamento(null, 5)).toBe(16 * 60_000);
    expect(esperaDoAdiamento(12 * 60_000, 1)).toBe(12 * 60_000);
    expect(esperaDoAdiamento(3_600_000, 1)).toBe(3_600_000);
    // Pediu pouco, mas já é a quarta espera: vale o recuo.
    expect(esperaDoAdiamento(1_000, 4)).toBe(8 * 60_000);
    expect(esperaDoAdiamento(0, 1)).toBe(60_000);
    expect(esperaDoAdiamento(24 * 3_600_000, 1)).toBe(2 * 3_600_000);
    expect(MAX_ADIAMENTOS).toBe(6);
  });
});
