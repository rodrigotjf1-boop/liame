import { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { saiPorDecisaoJaTomada, TOOLS } from '../src/actions/tools.js';
import { decidirPasso } from '../src/campanhas/ritmo-passos.js';
import { type EstadoDoRitmo, FORA_DO_RITMO, planoDoRitmo } from '../src/campanhas/ritmo-plano.js';
import { chooseMode, PLATFORM_POLICY } from '../src/policy/engine.js';
import { caminhoMaisPerto, passoDoDia, pesosDaSemana, problemasDaVerba, semanaQueVem, verbaDoRitmo } from '../src/regiao/ritmo-da-semana.js';

// R7, parte 1b-2 (D-RG-62 e D-RG-63), sem rede e sem banco: a verba que o passo de um dia deixa (em direção à do dia,
// 10% por mudança), o passo de hoje de uma campanha (a verba do dia, a volta à de antes), a semana que continua de outra
// (a partida), a ferramenta `orcamento_do_ritmo` (o plano, a campanha que não está como o Liame deixou) e a política:
// o automático só para o passo do ritmo, na Meta, pedido pelo funcionário de IA.

const REAL = 1_000_000;
const DIAS = semanaQueVem('2026-10-04').dias; // 05/10 (segunda) a 11/10/2026 (domingo)

describe('o passo do ritmo da semana (R7, parte 1b-2)', () => {
  it('a verba que o passo deixa: em direção à do dia, no máximo 10% por mudança, em centavos inteiros', () => {
    // Subindo: até a do dia, nunca além dela; longe demais, só os 10%.
    expect(passoDoDia(60 * REAL, 66 * REAL, null)).toBe(66 * REAL);
    expect(passoDoDia(60 * REAL, 63 * REAL, null)).toBe(63 * REAL);
    expect(passoDoDia(60 * REAL, 72 * REAL, null)).toBe(66 * REAL);
    // Descendo: o mais perto que os 10% deixam (o passo que não saiu ontem leva mais de um dia para descer).
    expect(passoDoDia(72 * REAL, 60 * REAL, null)).toBe(64.8 * REAL);
    expect(passoDoDia(64.8 * REAL, 60 * REAL, null)).toBe(60 * REAL);
    expect(passoDoDia(40 * REAL, 36 * REAL, null)).toBe(36 * REAL);
    // Igual: nada a mudar.
    expect(passoDoDia(60 * REAL, 60 * REAL, null)).toBe(60 * REAL);
    // O teto por campanha segura o que sobe (e não o que desce).
    expect(passoDoDia(60 * REAL, 66 * REAL, 64 * REAL)).toBe(64 * REAL);
    expect(passoDoDia(60 * REAL, 66 * REAL, 60 * REAL)).toBe(60 * REAL);
    expect(passoDoDia(60 * REAL, 66 * REAL, 50 * REAL)).toBe(60 * REAL);
    expect(passoDoDia(72 * REAL, 60 * REAL, 50 * REAL)).toBe(64.8 * REAL);
    // Centavos inteiros: R$ 10,01 + 10% = R$ 11,011 → R$ 11,01; R$ 10,01 − 10% = R$ 9,009 → R$ 9,01.
    expect(passoDoDia(10_010_000, 20 * REAL, null)).toBe(11_010_000);
    expect(passoDoDia(10_010_000, 5 * REAL, null)).toBe(9_010_000);
    // O resultado sempre cabe na conferência dos limites (10% por mudança).
    for (const [de, para] of [
      [13_370_000, 99 * REAL],
      [13_370_000, REAL],
      [137_530_000, 150 * REAL],
    ] as const) {
      expect(problemasDaVerba(de, [passoDoDia(de, para, null)], null).filter((p) => p.includes('muda mais'))).toEqual([]);
    }
  });

  it('o passo de hoje de uma campanha: a verba do dia na semana do ritmo; a volta à de antes com ele parado ou depois do fim', () => {
    const campanha = { base_micros: 60 * REAL, dias_micros: [54, 50.4, 55.2, 60, 65.4, 70.8, 64.2].map((v) => v * REAL) };
    const comum = { dias: DIAS, campanha, tetoMicros: null };
    // Antes da semana: nada.
    expect(decidirPasso({ ...comum, situacao: 'aprovado', hoje: '2026-10-04', deixadaMicros: 60 * REAL })).toBeNull();
    // Segunda: de R$ 60,00 para os R$ 54,00 do dia. Quarta, vindo de terça: sobe para os R$ 55,20.
    expect(decidirPasso({ ...comum, situacao: 'aprovado', hoje: '2026-10-05', deixadaMicros: 60 * REAL })).toEqual({ tipo: 'ritmo', alvoMicros: 54 * REAL, valorMicros: 54 * REAL });
    expect(decidirPasso({ ...comum, situacao: 'aprovado', hoje: '2026-10-07', deixadaMicros: 50.4 * REAL })).toEqual({ tipo: 'ritmo', alvoMicros: 55.2 * REAL, valorMicros: 55.2 * REAL });
    // O passo de sexta não saiu (a verba ficou nos R$ 60,00 de quinta): sábado sobe só os 10%, sem passar do aprovado.
    expect(decidirPasso({ ...comum, situacao: 'aprovado', hoje: '2026-10-10', deixadaMicros: 60 * REAL })).toEqual({ tipo: 'ritmo', alvoMicros: 70.8 * REAL, valorMicros: 66 * REAL });
    // Aprovado na quarta: o passo de hoje parte da verba de antes.
    expect(decidirPasso({ ...comum, situacao: 'aprovado', hoje: '2026-10-07', deixadaMicros: 60 * REAL })).toEqual({ tipo: 'ritmo', alvoMicros: 55.2 * REAL, valorMicros: 55.2 * REAL });
    // O teto por campanha de agora segura o sábado.
    expect(decidirPasso({ ...comum, situacao: 'aprovado', hoje: '2026-10-10', deixadaMicros: 65.4 * REAL, tetoMicros: 68 * REAL })).toMatchObject({ tipo: 'ritmo', valorMicros: 68 * REAL });
    // Depois do domingo, a volta: R$ 64,20 → R$ 60,00 num passo. Parado no sábado, com R$ 70,80: dois passos.
    expect(decidirPasso({ ...comum, situacao: 'aprovado', hoje: '2026-10-12', deixadaMicros: 64.2 * REAL })).toEqual({ tipo: 'volta', alvoMicros: 60 * REAL, valorMicros: 60 * REAL });
    expect(decidirPasso({ ...comum, situacao: 'parado', hoje: '2026-10-10', deixadaMicros: 70.8 * REAL })).toEqual({ tipo: 'volta', alvoMicros: 60 * REAL, valorMicros: 63.72 * REAL });
    expect(decidirPasso({ ...comum, situacao: 'parado', hoje: '2026-10-11', deixadaMicros: 63.72 * REAL })).toEqual({ tipo: 'volta', alvoMicros: 60 * REAL, valorMicros: 60 * REAL });
    // De volta à de antes: o passo é "igual" (quem chama só registra). De baixo, a volta sobe.
    expect(decidirPasso({ ...comum, situacao: 'parado', hoje: '2026-10-12', deixadaMicros: 60 * REAL })).toEqual({ tipo: 'volta', alvoMicros: 60 * REAL, valorMicros: 60 * REAL });
    expect(decidirPasso({ ...comum, situacao: 'parado', hoje: '2026-10-07', deixadaMicros: 50.4 * REAL })).toEqual({ tipo: 'volta', alvoMicros: 60 * REAL, valorMicros: 55.44 * REAL });
    // Parado antes de a semana começar: nada a devolver.
    expect(decidirPasso({ ...comum, situacao: 'parado', hoje: '2026-10-04', deixadaMicros: 60 * REAL })).toBeNull();
  });

  it('a semana que continua de outra: a segunda parte do peso de domingo, e a verba da campanha parte de onde o ritmo a deixou', () => {
    const entrada = { dias: DIAS, pedidosPorDiaDaSemana: [160, 90, 100, 120, 140, 190, 200], previsao: [], datas: [] };
    // Domingo terminou em 1,2: a segunda não desce além do passo, e a semana ainda soma no máximo 7.
    const pesos = pesosDaSemana({ ...entrada, partida: 1.2 }).map((d) => d.weight);
    expect(pesos[0]).toBeGreaterThanOrEqual(1.2 * 0.905 - 1e-9);
    expect(pesos.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(7 + 1e-9);
    expect(pesos.reduce((s, v) => s + v, 0)).toBeGreaterThan(6.99);
    // Sem a partida, a segunda desceria mais (parte da verba de hoje).
    expect(pesosDaSemana(entrada)[0]!.weight).toBeLessThan(pesos[0]!);
    // De domingo em 0,8: a segunda não sobe além do passo.
    expect(pesosDaSemana({ ...entrada, partida: 0.8 })[0]!.weight).toBeLessThanOrEqual(0.8 * 1.095 + 1e-9);
    expect(caminhoMaisPerto([1.2, 1.2], 0.8)).toEqual([0.876, 0.959]);
    // A campanha: a verba de hoje é a de antes (R$ 60,00) e a de domingo foi R$ 72,00: a segunda sai dos R$ 72,00.
    const v = verbaDoRitmo(60 * REAL, pesos, null, 72 * REAL);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.dias[0]).toBeGreaterThanOrEqual(64.8 * REAL);
      expect(problemasDaVerba(60 * REAL, v.dias, null, 72 * REAL)).toEqual([]);
      // A mesma tabela, conferida como se partisse dos R$ 60,00, pode não caber: a partida faz parte do plano.
      expect(v.dias.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(7 * 60 * REAL);
    }
    // O estado do pedido guarda a partida, e o plano a confere.
    const estado = (partida?: number): EstadoDoRitmo => ({
      ritmo: '0190d2b0-0000-7000-8000-0000000000a1',
      marca: '0190d2b0-0000-7000-8000-0000000000b1',
      loja: { id: '0190d2b0-0000-7000-8000-0000000000c1', nome: 'Loja Centro' },
      semana: { de: DIAS[0]!, ate: DIAS[6]! },
      fonte: 'loja',
      dias: DIAS.map((dia, i) => ({ dia, dia_da_semana: (i + 1) % 7, peso: 1, porques: [] })),
      campanhas: [{ recurso: 'campanha:120210000000001', nome: 'Combo sexta', base_micros: 60 * REAL, dias_micros: [66, 60, 56, 56, 58, 60, 60].map((x) => x * REAL), ...(partida ? { partida_micros: partida } : {}) }],
      fora: [],
      teto_micros: null,
      moeda: 'BRL',
      situacao: 'pedido',
    });
    // R$ 72,00 → R$ 66,00 cabe nos 10%; a partir dos R$ 60,00 (sem a partida), R$ 66,00 também cabe: os dois são planos.
    expect(planoDoRitmo(estado(72 * REAL)).ok).toBe(true);
    expect(planoDoRitmo(estado()).ok).toBe(true);
    // Mas partindo de R$ 80,00, cair para R$ 66,00 passa dos 10%.
    expect(planoDoRitmo(estado(80 * REAL))).toMatchObject({ ok: false });
  });

  it('a ferramenta do passo: só pelo ritmo, com a ação própria; a campanha que não está como o Liame deixou não tem plano', () => {
    const t = TOOLS.orcamento_do_ritmo!;
    expect([t.risk, t.providers, t.decisaoJaTomada, t.flag, t.alwaysApproval ?? false, t.compensation]).toEqual(['R2', ['meta_ads'], 'ritmo_da_semana', 'ritmo_da_semana', false, 'restaurar_orcamento_anterior_se_inalterado']);
    // As que saem sem outra aprovação porque uma pessoa já decidiu: as duas do atendimento automático e o passo do ritmo.
    expect(Object.values(TOOLS).filter(saiPorDecisaoJaTomada).map((x) => x.name)).toEqual(['orcamento_do_ritmo', 'comentario_responder_auto', 'direct_responder_auto']);
    expect(saiPorDecisaoJaTomada(TOOLS.orcamento_ajustar)).toBe(false);
    expect(saiPorDecisaoJaTomada(TOOLS.ritmo_da_semana)).toBe(false);
    expect(saiPorDecisaoJaTomada(undefined)).toBe(false);
    const campanha = { tipo: 'campanha', id: '120210000000001', status: 'ativo', daily_budget_micros: 60 * REAL, lifetime_budget_micros: null, moeda: 'BRL' };
    expect(t.plan(campanha as never, { daily_budget_micros: 66 * REAL, expected_micros: 60 * REAL })).toMatchObject({
      action: 'orcamento.ritmo_aumentar',
      budgetImpact: 'increase',
      valueMicros: 66 * REAL,
      currentValueMicros: 60 * REAL,
      reserveMicros: 6 * REAL,
      desiredState: { daily_budget_micros: 66 * REAL },
    });
    expect(t.plan(campanha as never, { daily_budget_micros: 54 * REAL, expected_micros: 60 * REAL })).toMatchObject({ action: 'orcamento.ritmo_reduzir', budgetImpact: 'decrease', reserveMicros: 0 });
    // A verba de agora não é a que o Liame deixou, ou alguém pausou: a campanha sai do ritmo.
    expect(() => t.plan(campanha as never, { daily_budget_micros: 66 * REAL, expected_micros: 55 * REAL })).toThrow(FORA_DO_RITMO);
    expect(() => t.plan({ ...campanha, status: 'pausado' } as never, { daily_budget_micros: 66 * REAL, expected_micros: 60 * REAL })).toThrow(FORA_DO_RITMO);
    // Anúncio não tem verba; e o plano de sempre vale (a fração de centavo).
    expect(() => t.plan({ ...campanha, tipo: 'anuncio' } as never, { daily_budget_micros: 66 * REAL, expected_micros: 60 * REAL })).toThrow();
    expect(() => t.plan(campanha as never, { daily_budget_micros: 66_005_000, expected_micros: 60 * REAL })).toThrow('fração de centavo');
    expect(t.params.safeParse({ daily_budget_micros: 66 * REAL }).success).toBe(false);
    // A volta de um passo, pedida por uma pessoa, é a mudança de verba comum (com a aprovação de sempre).
    expect(t.undo!(campanha as never)).toEqual({ tool: 'orcamento_ajustar', params: { daily_budget_micros: 60 * REAL } });
    // O pedido de verba comum segue com as ações de sempre.
    expect(TOOLS.orcamento_ajustar!.plan(campanha as never, { daily_budget_micros: 66 * REAL })).toMatchObject({ action: 'orcamento.aumentar', reserveMicros: 6 * REAL });
    expect(TOOLS.orcamento_ajustar!.plan(campanha as never, { daily_budget_micros: 54 * REAL })).toMatchObject({ action: 'orcamento.reduzir' });
  });

  it('a política da distribuição: o automático só para o passo do ritmo, na Meta, pedido pelo funcionário de IA', () => {
    const proposta = (action: string, actor: 'human' | 'agent', provider = 'meta_ads') =>
      ActionProposal.parse({
        tool: action.includes('ritmo') ? 'orcamento_do_ritmo' : 'orcamento_ajustar',
        action,
        provider,
        account_id: 'a',
        risk_level: 'R2',
        budget_impact: action.endsWith('aumentar') ? 'increase' : 'decrease',
        value_micros: 66 * REAL,
        current_value_micros: 60 * REAL,
        actor,
      });
    const modo = (action: string, actor: 'human' | 'agent', provider?: string) => chooseMode([PLATFORM_POLICY], proposta(action, actor, provider)).mode;
    expect([modo('orcamento.ritmo_aumentar', 'agent'), modo('orcamento.ritmo_reduzir', 'agent')]).toEqual(['AUTO', 'AUTO']);
    // Uma pessoa, na Meta, sempre com aprovação; em outra plataforma, a regra não vale.
    expect([modo('orcamento.ritmo_aumentar', 'human'), modo('orcamento.ritmo_reduzir', 'human')]).toEqual(['APPROVAL', 'APPROVAL']);
    expect(modo('orcamento.ritmo_aumentar', 'agent', 'google_ads')).not.toBe('AUTO');
    // O que a regra NÃO liga (D-A7-11): o pedido de verba comum do funcionário de IA segue fora do automático.
    for (const acao of ['orcamento.aumentar', 'orcamento.reduzir']) expect(['AUTO', 'LIMITED_AUTO']).not.toContain(modo(acao, 'agent'));
  });
});
