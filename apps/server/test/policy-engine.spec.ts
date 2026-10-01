import { ActionProposal, type PolicyDocument } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { changePercent, evaluatePolicy, type LoadedPolicy, localClock, PLATFORM_POLICY } from '../src/policy/engine.js';

const TZ = 'America/Sao_Paulo';
// Sábado, 26/09/2026, 15:00 em São Paulo (18:00 UTC).
const AT = new Date('2026-09-26T18:00:00Z');

const proposal = (over: Partial<ActionProposal> = {}): ActionProposal =>
  ActionProposal.parse({
    tool: 'campanha_orcamento_ajustar',
    action: 'orcamento.aumentar',
    provider: 'meta',
    account_id: 'act_1',
    risk_level: 'R3',
    budget_impact: 'increase',
    value_micros: 110_000_000,
    current_value_micros: 100_000_000,
    ...over,
  });
const tenant = (document: PolicyDocument, version = 1): LoadedPolicy => ({ source: 'tenant', version, document });
const brand = (document: PolicyDocument, version = 1): LoadedPolicy => ({ source: 'brand', version, document });
const run = (policies: LoadedPolicy[], p = proposal(), at = AT) => evaluatePolicy([PLATFORM_POLICY, ...policies], p, { at, timezone: TZ });

describe('A1-11: motor de políticas determinístico', () => {
  it('sem política da empresa: permitido, em SHADOW (ferramenta nova começa em sombra), com a versão da plataforma', () => {
    expect(run([])).toEqual({ allowed: true, mode: 'SHADOW', violations: [], versions: ['plataforma@2'] });
  });

  it('teto por ação', () => {
    const doc: PolicyDocument = { rules: [{ type: 'max_value', action: 'orcamento.*', max_micros: 100_000_000 }] };
    const d = run([tenant(doc)]);
    expect(d.allowed).toBe(false);
    expect(d.violations).toEqual([{ source: 'tenant', rule_index: 0, type: 'max_value', message: expect.stringMatching(/R\$\s?110,00 passa do teto de R\$\s?100,00/) }]);
    expect(run([tenant(doc)], proposal({ value_micros: 100_000_000 })).allowed).toBe(true);
    expect(run([tenant(doc)], proposal({ action: 'anuncio.pausar', value_micros: null })).allowed).toBe(true);
  });

  it('variação máxima: aumento por padrão; redução só quando pedida', () => {
    const doc: PolicyDocument = { rules: [{ type: 'max_change_percent', max_percent: 15, direction: 'increase' }] };
    expect(changePercent(proposal({ value_micros: 120_000_000 }))).toBe(20);
    expect(run([tenant(doc)], proposal({ value_micros: 115_000_000 })).allowed).toBe(true);
    expect(run([tenant(doc)], proposal({ value_micros: 120_000_000 })).violations[0]?.message).toBe('A variação de 20,0% passa do máximo de 15%.');
    expect(run([tenant(doc)], proposal({ value_micros: 50_000_000 })).allowed).toBe(true);
    const both: PolicyDocument = { rules: [{ type: 'max_change_percent', max_percent: 15, direction: 'both' }] };
    expect(run([tenant(both)], proposal({ value_micros: 50_000_000 })).allowed).toBe(false);
  });

  it('horário permitido no fuso da empresa, com dias e janela que passa da meia-noite', () => {
    expect(localClock(AT, TZ)).toEqual({ day: 6, minute: 15 * 60 });
    const comercial: PolicyDocument = { rules: [{ type: 'allowed_hours', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }] };
    expect(run([tenant(comercial)]).allowed).toBe(false); // sábado
    expect(run([tenant(comercial)], proposal(), new Date('2026-09-28T18:00:00Z')).allowed).toBe(true); // segunda 15:00
    expect(run([tenant(comercial)], proposal(), new Date('2026-09-28T22:00:00Z')).allowed).toBe(false); // segunda 19:00
    const noite: PolicyDocument = { rules: [{ type: 'allowed_hours', days: [5], start: '22:00', end: '06:00' }] };
    expect(run([tenant(noite)], proposal(), new Date('2026-09-26T04:00:00Z')).allowed).toBe(true); // sábado 01:00, janela de sexta
    expect(run([tenant(noite)], proposal(), new Date('2026-09-27T04:00:00Z')).allowed).toBe(false); // domingo 01:00, janela de sábado
  });

  it('conta permitida por provedor', () => {
    const doc: PolicyDocument = { rules: [{ type: 'allowed_accounts', provider: 'meta', accounts: ['act_1', 'act_2'] }] };
    expect(run([tenant(doc)]).allowed).toBe(true);
    expect(run([tenant(doc)], proposal({ account_id: 'act_9' })).violations[0]?.message).toBe('A conta act_9 (meta) não está entre as permitidas.');
    expect(run([tenant(doc)], proposal({ provider: 'google', account_id: 'act_9' })).allowed).toBe(true);
  });

  it('escopo de ferramentas e ações', () => {
    const doc: PolicyDocument = { rules: [{ type: 'allowed_scope', tools: ['campanha_orcamento_ajustar'], actions: ['orcamento.*', 'anuncio.pausar'] }] };
    expect(run([tenant(doc)]).allowed).toBe(true);
    expect(run([tenant(doc)], proposal({ tool: 'mensagem_enviar' })).allowed).toBe(false);
    expect(run([tenant(doc)], proposal({ action: 'campanha.criar' })).violations[0]?.type).toBe('allowed_scope');
  });

  it('categorias proibidas: política bloqueada pela plataforma; a empresa acrescenta as suas', () => {
    const politica = run([], proposal({ categories: ['politica'] }));
    expect(politica).toMatchObject({ allowed: false, violations: [{ source: 'platform', type: 'forbidden_categories' }] });
    const doc: PolicyDocument = { rules: [{ type: 'forbidden_categories', categories: ['apostas', 'saude'] }] };
    expect(run([tenant(doc)], proposal({ categories: ['saude'] })).violations[0]?.message).toBe('Categoria proibida: saude.');
    expect(run([tenant(doc)], proposal({ categories: ['gastronomia'] })).allowed).toBe(true);
  });

  it('palavras proibidas sem diferença de maiúsculas e acentos', () => {
    const doc: PolicyDocument = { rules: [{ type: 'forbidden_words', words: ['cura garantida', 'o melhor da cidade'] }] };
    expect(run([tenant(doc)], proposal({ text: 'Promoção: CURA GARANTÍDA!' })).allowed).toBe(false);
    expect(run([tenant(doc)], proposal({ text: 'Pizza no forno a lenha' })).allowed).toBe(true);
  });

  it('limite de frequência da plataforma na Meta (abaixo das 4 por hora da Meta)', () => {
    expect(run([], proposal({ recent_count: 2 })).allowed).toBe(true);
    expect(run([], proposal({ recent_count: 3 })).violations[0]).toMatchObject({ source: 'platform', type: 'rate_limit' });
    expect(run([], proposal({ provider: 'google', recent_count: 10 })).allowed).toBe(true);
  });

  it('autonomia: a regra mais específica vence, a da marca vence a da empresa, ESCALATE vence sempre', () => {
    const doc: PolicyDocument = {
      rules: [
        { type: 'autonomy', action: 'anuncio.pausar', mode: 'AUTO' },
        { type: 'autonomy', action: 'orcamento.aumentar', up_to_percent: 10, mode: 'LIMITED_AUTO' },
        { type: 'autonomy', action: 'orcamento.aumentar', above_micros: 300_000_000, mode: 'APPROVAL' },
        { type: 'autonomy', action: 'orcamento.*', mode: 'SUGGEST' },
      ],
    };
    expect(run([tenant(doc)], proposal({ value_micros: 110_000_000 })).mode).toBe('LIMITED_AUTO');
    expect(run([tenant(doc)], proposal({ value_micros: 130_000_000 })).mode).toBe('SUGGEST');
    expect(run([tenant(doc)], proposal({ value_micros: 400_000_000, current_value_micros: 380_000_000 })).mode).toBe('APPROVAL');
    expect(run([tenant(doc)], proposal({ action: 'anuncio.pausar', value_micros: null })).mode).toBe('AUTO');
    const daMarca: PolicyDocument = { rules: [{ type: 'autonomy', action: 'orcamento.aumentar', up_to_percent: 10, mode: 'APPROVAL' }] };
    expect(run([tenant(doc), brand(daMarca)], proposal({ value_micros: 110_000_000 }))).toMatchObject({ mode: 'APPROVAL', versions: ['plataforma@2', 'empresa@1', 'marca@1'] });
    // A plataforma manda escalar o apagar, mesmo que a empresa diga AUTO.
    const auto: PolicyDocument = { rules: [{ type: 'autonomy', action: 'campanha.apagar', mode: 'AUTO' }] };
    expect(run([tenant(auto)], proposal({ action: 'campanha.apagar', value_micros: null })).mode).toBe('ESCALATE');
  });

  it('determinístico: a mesma entrada dá a mesma decisão, em qualquer ordem de chamada', () => {
    const doc: PolicyDocument = { rules: [{ type: 'max_value', max_micros: 1 }, { type: 'autonomy', mode: 'APPROVAL' }] };
    const a = run([tenant(doc)]);
    const b = run([tenant(doc)]);
    expect(b).toEqual(a);
  });
});
