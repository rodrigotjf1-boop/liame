import { describe, expect, it } from 'vitest';
import type { EstadoDoObjeto } from '../src/actions/meta-anuncios.js';
import { PlanoRecusado, TOOLS, type ToolPlan } from '../src/actions/tools.js';

// A4 · X2: as ferramentas de anúncio (planos puros). O estado de um objeto da plataforma traz o tipo (campanha,
// conjunto ou anúncio) e a situação; o do sandbox não traz tipo, e para ele as ferramentas seguem como eram. Cada
// ferramenta diz o risco, o que reserva no envelope e como se desfaz (A4-5).

const REAL = 1_000_000;
const objeto = (tipo: EstadoDoObjeto['tipo'], over: Partial<EstadoDoObjeto> = {}): EstadoDoObjeto => ({
  tipo,
  id: '120210000000001',
  nome: 'Delivery noite',
  status: 'ativo',
  status_efetivo: 'ACTIVE',
  daily_budget_micros: tipo === 'anuncio' ? null : 30 * REAL,
  lifetime_budget_micros: null,
  moeda: 'BRL',
  ...over,
});
const plano = (ferramenta: string, estado: Record<string, unknown>, params: Record<string, unknown> = {}): ToolPlan => TOOLS[ferramenta]!.plan(estado, params);
const recusa = (ferramenta: string, estado: Record<string, unknown>, params: Record<string, unknown> = {}): string => {
  try {
    plano(ferramenta, estado, params);
  } catch (err) {
    if (err instanceof PlanoRecusado) return err.message;
    throw err;
  }
  throw new Error(`${ferramenta} não recusou`);
};

const TIPOS = ['campanha', 'conjunto', 'anuncio'] as const;

describe('ferramentas de anúncio (A4 · X2)', () => {
  it('o registro: risco, provedores e compensação de cada uma', () => {
    const resumo = Object.fromEntries(
      Object.values(TOOLS)
        .filter((t) => t.providers.includes('meta_ads'))
        .map((t) => [t.name, [t.risk, t.providers.join('+'), t.compensation]]),
    );
    expect(resumo).toEqual({
      orcamento_ajustar: ['R3', 'sandbox+meta_ads+google_ads', 'restaurar_orcamento_anterior_se_inalterado'],
      anuncio_pausar: ['R1', 'sandbox+meta_ads', 'reativar_se_inalterado'],
      conjunto_pausar: ['R1', 'meta_ads', 'reativar_se_inalterado'],
      campanha_pausar: ['R1', 'meta_ads+google_ads', 'reativar_se_inalterado'],
      // Retomar volta a gastar: risco maior que o de pausar.
      anuncio_retomar: ['R2', 'meta_ads', 'pausar_se_inalterado'],
      conjunto_retomar: ['R2', 'meta_ads', 'pausar_se_inalterado'],
      campanha_retomar: ['R2', 'meta_ads+google_ads', 'pausar_se_inalterado'],
    });
    for (const t of Object.values(TOOLS)) expect(t.params.safeParse({ qualquer: 1 }).success, t.name).toBe(false);
  });

  it('no Google (A5 · Y3): só a campanha, com a verba do orçamento que é só dela; a verba dividida nunca vira pedido', () => {
    // As ferramentas que aceitam o Google: a verba e pausar e retomar a campanha. Grupo de anúncios e anúncio, não.
    expect(Object.values(TOOLS).filter((t) => t.providers.includes('google_ads')).map((t) => t.name).sort()).toEqual(['campanha_pausar', 'campanha_retomar', 'orcamento_ajustar']);
    // O estado de uma campanha do Google, como o conector entrega: os mesmos campos da Meta, mais o orçamento.
    const doGoogle = (over: Record<string, unknown> = {}) => ({
      ...objeto('campanha', { status_efetivo: 'ELIGIBLE' }),
      orcamento: { id: '55', compartilhado: false, campanhas: 1, diario_micros: 30 * REAL },
      ...over,
    });
    const propria = doGoogle();
    expect(plano('orcamento_ajustar', propria, { daily_budget_micros: 27 * REAL })).toMatchObject({ action: 'orcamento.reduzir', budgetImpact: 'decrease', reserveMicros: 0, desiredState: { daily_budget_micros: 27 * REAL, orcamento: propria.orcamento } });
    expect(plano('orcamento_ajustar', propria, { daily_budget_micros: 33 * REAL })).toMatchObject({ action: 'orcamento.aumentar', reserveMicros: 3 * REAL });
    expect(plano('campanha_pausar', propria)).toMatchObject({ action: 'campanha.pausar', desiredState: { status: 'pausado' } });

    // Dividida de fato (duas campanhas) ou criada para ser dividida: a verba não muda, e a recusa diz com quem ela é dividida.
    const dividida = doGoogle({ daily_budget_micros: null, orcamento: { id: '55', compartilhado: true, campanhas: 2, diario_micros: 80 * REAL } });
    expect(recusa('orcamento_ajustar', dividida, { daily_budget_micros: 88 * REAL })).toBe(
      'A verba desta campanha vem de um orçamento compartilhado com outra campanha no Google: mudar aqui mudaria a verba dela também. O Liame não muda orçamento compartilhado.',
    );
    const criadaParaDividir = doGoogle({ daily_budget_micros: null, orcamento: { id: '55', compartilhado: true, campanhas: 1, diario_micros: 30 * REAL } });
    expect(recusa('orcamento_ajustar', criadaParaDividir, { daily_budget_micros: 27 * REAL })).toContain('compartilhado entre campanhas no Google');
    // Pausar e retomar a campanha de verba dividida pode: só ela muda. Retomar não reserva (a verba não é dela).
    expect(plano('campanha_pausar', dividida)).toMatchObject({ action: 'campanha.pausar' });
    expect(plano('campanha_retomar', { ...dividida, status: 'pausado' })).toMatchObject({ action: 'campanha.retomar', budgetImpact: 'new_spend', valueMicros: null, reserveMicros: 0 });
    // De período: sem verba diária própria, como na Meta.
    const periodo = doGoogle({ daily_budget_micros: null, lifetime_budget_micros: 900 * REAL, orcamento: { id: '55', compartilhado: false, campanhas: 1, diario_micros: null } });
    expect(recusa('orcamento_ajustar', periodo, { daily_budget_micros: 30 * REAL })).toBe('A campanha não tem verba diária própria: a verba fica em outro nível, ou é de período.');
    // Removida no Google: não muda mais.
    expect(recusa('campanha_pausar', doGoogle({ status: 'removido' }))).toContain('não dá para mudar');
  });

  it('pausar: o objeto ativo passa a pausado, sem reserva; cada ferramenta só vale para o seu tipo', () => {
    for (const tipo of TIPOS) {
      const antes = objeto(tipo);
      expect(plano(`${tipo}_pausar`, antes)).toEqual({
        action: `${tipo}.pausar`,
        budgetImpact: 'decrease',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: { ...antes, status: 'pausado' },
      });
    }
    expect(recusa('anuncio_pausar', objeto('campanha'))).toBe('Esta ferramenta é para anúncio; o pedido aponta para campanha.');
    expect(recusa('campanha_pausar', objeto('conjunto'))).toBe('Esta ferramenta é para campanha; o pedido aponta para conjunto de anúncios.');
    expect(recusa('conjunto_pausar', objeto('anuncio'))).toBe('Esta ferramenta é para conjunto de anúncios; o pedido aponta para anúncio.');
    // Já em pausa, arquivado ou removido: não há o que pausar.
    expect(recusa('campanha_pausar', objeto('campanha', { status: 'pausado' }))).toBe('A campanha já está em pausa.');
    expect(recusa('conjunto_pausar', objeto('conjunto', { status: 'arquivado' }))).toBe('O conjunto foi arquivado ou removido na plataforma: não dá para mudar.');
    expect(recusa('anuncio_pausar', objeto('anuncio', { status: 'removido' }))).toBe('O anúncio foi arquivado ou removido na plataforma: não dá para mudar.');
    expect(recusa('anuncio_pausar', objeto('anuncio', { status: 'desconhecido' }))).toBe('O anúncio foi arquivado ou removido na plataforma: não dá para mudar.');
  });

  it('o sandbox segue como era: o estado sem tipo é pausado pela ferramenta de anúncio', () => {
    const antes = { status: 'ativo', daily_budget_micros: 100 * REAL };
    expect(plano('anuncio_pausar', antes)).toMatchObject({ action: 'anuncio.pausar', budgetImpact: 'decrease', reserveMicros: 0, desiredState: { status: 'pausado', daily_budget_micros: 100 * REAL } });
    expect(plano('orcamento_ajustar', antes, { daily_budget_micros: 130 * REAL })).toMatchObject({ action: 'orcamento.aumentar', reserveMicros: 30 * REAL });
    // Retomar é só de objeto de plataforma conectada.
    expect(recusa('anuncio_retomar', { status: 'pausado' })).toBe('Retomar vale para campanha, conjunto e anúncio de uma plataforma conectada.');
  });

  it('retomar: o objeto em pausa volta a ativo e a gastar; reserva um dia da verba que mora nele', () => {
    const campanha = objeto('campanha', { status: 'pausado', status_efetivo: 'PAUSED' });
    expect(plano('campanha_retomar', campanha)).toEqual({
      action: 'campanha.retomar',
      budgetImpact: 'new_spend',
      valueMicros: 30 * REAL,
      currentValueMicros: null,
      reserveMicros: 30 * REAL,
      desiredState: { ...campanha, status: 'ativo' },
    });
    // O anúncio não tem verba, e o conjunto de uma campanha com orçamento de campanha também não: nada a reservar.
    expect(plano('anuncio_retomar', objeto('anuncio', { status: 'pausado' }))).toMatchObject({ action: 'anuncio.retomar', budgetImpact: 'new_spend', valueMicros: null, reserveMicros: 0 });
    expect(plano('conjunto_retomar', objeto('conjunto', { status: 'pausado', daily_budget_micros: null }))).toMatchObject({ valueMicros: null, reserveMicros: 0 });
    expect(recusa('campanha_retomar', objeto('campanha'))).toBe('Só dá para retomar o que está em pausa, e a campanha está ativa.');
    expect(recusa('anuncio_retomar', objeto('anuncio'))).toBe('Só dá para retomar o que está em pausa, e o anúncio está ativo.');
    expect(recusa('conjunto_retomar', objeto('conjunto', { status: 'arquivado' }))).toBe('O conjunto foi arquivado ou removido na plataforma: não dá para mudar.');
    expect(recusa('conjunto_retomar', objeto('campanha', { status: 'pausado' }))).toBe('Esta ferramenta é para conjunto de anúncios; o pedido aponta para campanha.');
  });

  it('verba diária: campanha com orçamento de campanha ou conjunto; reserva só a diferença do aumento', () => {
    const campanha = objeto('campanha');
    expect(plano('orcamento_ajustar', campanha, { daily_budget_micros: 36 * REAL })).toEqual({
      action: 'orcamento.aumentar',
      budgetImpact: 'increase',
      valueMicros: 36 * REAL,
      currentValueMicros: 30 * REAL,
      reserveMicros: 6 * REAL,
      desiredState: { ...campanha, daily_budget_micros: 36 * REAL },
    });
    expect(plano('orcamento_ajustar', objeto('conjunto'), { daily_budget_micros: 24 * REAL })).toMatchObject({ action: 'orcamento.reduzir', budgetImpact: 'decrease', reserveMicros: 0 });
    // O que a ferramenta não muda, com o motivo.
    expect(recusa('orcamento_ajustar', objeto('anuncio'), { daily_budget_micros: 24 * REAL })).toBe('Esta ferramenta é para campanha ou conjunto de anúncios; o pedido aponta para anúncio.');
    expect(recusa('orcamento_ajustar', objeto('conjunto', { daily_budget_micros: null }), { daily_budget_micros: 24 * REAL })).toBe(
      'O conjunto não tem verba diária própria: a verba fica em outro nível, ou é de período.',
    );
    expect(recusa('orcamento_ajustar', campanha, { daily_budget_micros: 30 * REAL })).toBe('A verba pedida é igual à de agora.');
    expect(recusa('orcamento_ajustar', campanha, { daily_budget_micros: 24_995_000 })).toBe('A verba diária não pode ter fração de centavo.');
    expect(recusa('orcamento_ajustar', objeto('campanha', { status: 'arquivado' }), { daily_budget_micros: 24 * REAL })).toBe('A campanha foi arquivada ou removida na plataforma: não dá para mudar.');
    // Moeda sem casas decimais: a menor unidade é a própria unidade.
    expect(recusa('orcamento_ajustar', objeto('campanha', { moeda: 'CLP', daily_budget_micros: 30_000 * REAL }), { daily_budget_micros: 24_000_500_000 })).toBe('A verba diária não pode ter fração de centavo.');
    expect(plano('orcamento_ajustar', objeto('campanha', { moeda: 'CLP', daily_budget_micros: 30_000 * REAL }), { daily_budget_micros: 24_000 * REAL }).action).toBe('orcamento.reduzir');
  });

  it('A4-5: toda ferramenta de anúncio tem a volta, e a volta devolve o objeto a como estava', () => {
    const casos: Array<[string, EstadoDoObjeto, Record<string, unknown>]> = [
      ['orcamento_ajustar', objeto('campanha'), { daily_budget_micros: 36 * REAL }],
      ['orcamento_ajustar', objeto('conjunto'), { daily_budget_micros: 24 * REAL }],
      ...TIPOS.map((t): [string, EstadoDoObjeto, Record<string, unknown>] => [`${t}_pausar`, objeto(t), {}]),
      ...TIPOS.map((t): [string, EstadoDoObjeto, Record<string, unknown>] => [`${t}_retomar`, objeto(t, { status: 'pausado' }), {}]),
    ];
    for (const [ferramenta, antes, params] of casos) {
      const ida = plano(ferramenta, antes, params);
      const volta = TOOLS[ferramenta]!.undo!(antes);
      const inversa = TOOLS[volta.tool]!;
      expect(inversa.providers, `${ferramenta} → ${volta.tool}`).toContain('meta_ads');
      expect(inversa.params.safeParse(volta.params).success, `${ferramenta} → ${volta.tool}`).toBe(true);
      // A volta é planejada sobre o que a ação deixou, e devolve a situação e a verba de antes.
      expect(inversa.plan(ida.desiredState, volta.params).desiredState, ferramenta).toEqual(antes);
    }
    expect(TOOLS.campanha_pausar!.undo!(objeto('campanha'))).toEqual({ tool: 'campanha_retomar', params: {} });
    expect(TOOLS.anuncio_retomar!.undo!(objeto('anuncio', { status: 'pausado' }))).toEqual({ tool: 'anuncio_pausar', params: {} });
    expect(TOOLS.orcamento_ajustar!.undo!(objeto('conjunto', { daily_budget_micros: 45 * REAL }))).toEqual({ tool: 'orcamento_ajustar', params: { daily_budget_micros: 45 * REAL } });
    // Nenhuma ferramenta de anúncio na Meta fica sem volta; o cupom do Regem não se desfaz pelo Liame (desativa-se no Regem).
    // A mensagem enviada não volta: a volta do envio é pausar o que ainda não saiu, e a pausa não tem volta pelo Liame.
    for (const t of Object.values(TOOLS)) expect(Boolean(t.undo), t.name).toBe(t.providers.includes('meta_ads') || t.name === 'mensagem_disparar');
  });
});
