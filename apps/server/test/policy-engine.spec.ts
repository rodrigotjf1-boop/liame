import { ActionProposal, type PolicyDocument } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { changePercent, evaluatePolicy, type LoadedPolicy, localClock, PLATFORM_POLICY, rateLimitsFor, VARIACAO_MAXIMA_DA_VERBA_PCT } from '../src/policy/engine.js';

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
    expect(run([])).toEqual({ allowed: true, mode: 'SHADOW', violations: [], versions: ['plataforma@5'] });
  });

  it('teto por ação', () => {
    const doc: PolicyDocument = { rules: [{ type: 'max_value', action: 'orcamento.*', max_micros: 100_000_000 }] };
    const d = run([tenant(doc)]);
    expect(d.allowed).toBe(false);
    // Na verba diária, a recusa usa o nome que a tela dá ao limite: o teto por campanha (A4, D-A4-19).
    expect(d.violations).toEqual([
      { source: 'tenant', rule_index: 0, type: 'max_value', message: expect.stringMatching(/^A verba de R\$\s110,00 por dia passa do teto por campanha, que é de R\$\s100,00 por dia\.$/) },
    ]);
    // Em outra ação com valor, a frase segue a geral.
    const geral: PolicyDocument = { rules: [{ type: 'max_value', max_micros: 100_000_000 }] };
    expect(run([tenant(geral)], proposal({ action: 'lance.aumentar' })).violations[0]?.message).toMatch(/^O valor R\$\s110,00 passa do teto de R\$\s100,00 por ação\.$/);
    expect(run([tenant(doc)], proposal({ value_micros: 100_000_000 })).allowed).toBe(true);
    expect(run([tenant(doc)], proposal({ action: 'anuncio.pausar', value_micros: null })).allowed).toBe(true);
    // O teto vale para o que faz o gasto subir: baixar uma verba para um valor ainda acima dele é a direção segura.
    const baixar = proposal({ action: 'orcamento.reduzir', budget_impact: 'decrease', value_micros: 160_000_000, current_value_micros: 200_000_000 });
    expect(run([tenant(doc)], baixar).allowed).toBe(true);
    expect(run([tenant(doc)], { ...baixar, action: 'orcamento.aumentar', budget_impact: 'increase', current_value_micros: 150_000_000 }).allowed).toBe(false);
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

  it('limite de frequência da plataforma na Meta: 3 mudanças de verba por hora por objeto (abaixo das 4 da Meta)', () => {
    const naMeta = (over: Partial<ActionProposal> = {}) => proposal({ provider: 'meta_ads', ...over });
    expect(run([], naMeta({ recent_count: 2 })).allowed).toBe(true);
    expect(run([], naMeta({ recent_count: 3 })).violations).toEqual([
      { source: 'platform', rule_index: 1, type: 'rate_limit', message: 'Limite de 3 execuções a cada 60 min atingido neste objeto.' },
    ]);
    // A regra é por provedor, com o nome que as contas conectadas usam (na versão 2 ela dizia `meta`, e nunca casaria);
    // no sandbox e em provedor desconhecido ela não vale. O Google tem a dele desde a versão 4 (teste abaixo).
    expect(run([], proposal({ provider: 'sandbox', recent_count: 10 })).allowed).toBe(true);
    expect(run([], proposal({ provider: 'meta', recent_count: 10 })).allowed).toBe(true);
    // Só a verba entra na conta: pausar, não.
    expect(run([], naMeta({ action: 'anuncio.pausar', value_micros: null, current_value_micros: null, recent_count: 10 })).allowed).toBe(true);
  });

  it('a contagem de cada regra de frequência vem de quem pede; sem ela, vale a da proposta', () => {
    const daEmpresa: PolicyDocument = { rules: [{ type: 'rate_limit', action: 'orcamento.aumentar', max: 1, window_minutes: 1440 }] };
    const politicas = [PLATFORM_POLICY, tenant(daEmpresa)];
    const p = proposal({ provider: 'meta_ads' });
    const regras = rateLimitsFor(politicas, p);
    expect(regras.map((r) => [r.per ?? 'account', r.max])).toEqual([
      ['resource', 3],
      ['account', 1],
    ]);
    const avaliar = (contas: number[]) => evaluatePolicy(politicas, p, { at: AT, timezone: TZ, recent: new Map(regras.map((r, i) => [r, contas[i]!])) });
    expect(avaliar([2, 0]).allowed).toBe(true);
    expect(avaliar([3, 0]).violations.map((v) => [v.source, v.type])).toEqual([['platform', 'rate_limit']]);
    expect(avaliar([0, 1]).violations).toEqual([{ source: 'tenant', rule_index: 0, type: 'rate_limit', message: 'Limite de 1 execução a cada 1440 min atingido.' }]);
    // A regra de outra ação ou de outro provedor não entra na conta.
    expect(rateLimitsFor(politicas, proposal({ provider: 'meta_ads', action: 'anuncio.pausar' }))).toEqual([]);
    expect(rateLimitsFor(politicas, proposal({ provider: 'sandbox' }))).toHaveLength(1);
  });

  it('na Meta, a plataforma limita a variação da verba a 10% por pedido, para cima e para baixo; a volta fica fora', () => {
    expect(VARIACAO_MAXIMA_DA_VERBA_PCT).toBe(10);
    const naMeta = (valor: number, over: Partial<ActionProposal> = {}) => proposal({ provider: 'meta_ads', value_micros: valor, current_value_micros: 100_000_000, ...over });
    expect(run([], naMeta(110_000_000)).allowed).toBe(true);
    expect(run([], naMeta(90_000_000)).allowed).toBe(true);
    expect(run([], naMeta(110_010_000)).violations).toEqual([{ source: 'platform', rule_index: 2, type: 'max_change_percent', message: 'A variação de 10,01% passa do máximo de 10%.' }]);
    expect(run([], naMeta(89_990_000)).allowed).toBe(false);
    // 20% de uma vez (o que o plano permitia até 04/10/2026) não passa mais.
    expect(run([], naMeta(120_000_000)).allowed).toBe(false);
    // Fora da Meta a regra não vale (o sandbox segue só com a política da empresa).
    expect(run([], proposal({ value_micros: 200_000_000 })).allowed).toBe(true);

    // A volta de uma ação devolve o valor de antes: fica fora da variação máxima e do teto por ação.
    const teto: PolicyDocument = { rules: [{ type: 'max_value', action: 'orcamento.*', max_micros: 90_000_000 }] };
    const volta = naMeta(100_000_000, { current_value_micros: 80_000_000, undo: true });
    expect(run([tenant(teto)], { ...volta, undo: false }).violations.map((v) => v.type)).toEqual(['max_change_percent', 'max_value']);
    expect(run([tenant(teto)], volta).allowed).toBe(true);
    // O limite de frequência continua valendo para ela.
    expect(run([tenant(teto)], { ...volta, recent_count: 3 }).violations.map((v) => v.type)).toEqual(['rate_limit']);
  });

  it('no Google Ads valem as mesmas regras da Meta (versão 4, D-A5-3): 10% por pedido, 3 mudanças de verba por hora por objeto e aprovação para o que a pessoa pede', () => {
    expect(PLATFORM_POLICY.version).toBe(5);
    const noGoogle = (valor: number, over: Partial<ActionProposal> = {}) => proposal({ provider: 'google_ads', value_micros: valor, current_value_micros: 100_000_000, ...over });
    // A variação: até 10%, para cima e para baixo; a volta fica fora.
    expect(run([], noGoogle(110_000_000)).allowed).toBe(true);
    expect(run([], noGoogle(90_000_000)).allowed).toBe(true);
    expect(run([], noGoogle(110_010_000)).violations).toEqual([{ source: 'platform', rule_index: 7, type: 'max_change_percent', message: 'A variação de 10,01% passa do máximo de 10%.' }]);
    expect(run([], noGoogle(80_000_000)).allowed).toBe(false);
    expect(run([], noGoogle(100_000_000, { current_value_micros: 80_000_000, undo: true })).allowed).toBe(true);
    // A frequência: a terceira mudança de verba na hora, no mesmo objeto, é a última; pausar não entra na conta.
    expect(run([], noGoogle(110_000_000, { recent_count: 2 })).allowed).toBe(true);
    expect(run([], noGoogle(110_000_000, { recent_count: 3 })).violations).toEqual([
      { source: 'platform', rule_index: 6, type: 'rate_limit', message: 'Limite de 3 execuções a cada 60 min atingido neste objeto.' },
    ]);
    expect(run([], noGoogle(110_000_000, { action: 'campanha.pausar', value_micros: null, current_value_micros: null, recent_count: 10 })).allowed).toBe(true);
    expect(rateLimitsFor([PLATFORM_POLICY], noGoogle(110_000_000)).map((r) => [r.provider, r.per, r.max])).toEqual([['google_ads', 'resource', 3]]);
    // Quem pede: a pessoa espera a aprovação com o código do app; o funcionário de IA começa em sombra, como na Meta.
    expect(run([], noGoogle(110_000_000, { actor: 'human' }))).toMatchObject({ allowed: true, mode: 'APPROVAL', versions: ['plataforma@5'] });
    expect(run([], noGoogle(110_000_000, { actor: 'agent' })).mode).toBe('SHADOW');
    // O teto por campanha que a empresa define na tela não tem provedor: vale para o Google também.
    const teto: PolicyDocument = { rules: [{ type: 'max_value', action: 'orcamento.*', max_micros: 105_000_000 }] };
    expect(run([tenant(teto)], noGoogle(110_000_000)).violations.map((v) => v.type)).toEqual(['max_value']);
    expect(run([tenant(teto)], noGoogle(95_000_000)).allowed).toBe(true);
  });

  it('teto com provedor: a regra só vale para as ações naquele provedor', () => {
    const doc: PolicyDocument = { rules: [{ type: 'max_value', action: 'orcamento.*', provider: 'meta_ads', max_micros: 100_000_000 }] };
    expect(run([tenant(doc)]).allowed).toBe(true);
    expect(run([tenant(doc)], proposal({ provider: 'meta_ads' })).violations.map((v) => v.type)).toEqual(['max_value']);
  });

  it('quem pede: na Meta, o pedido de uma pessoa espera aprovação; o modo do funcionário de IA é outra regra', () => {
    const pessoa = proposal({ provider: 'meta_ads', actor: 'human' });
    const agente = proposal({ provider: 'meta_ads', actor: 'agent' });
    expect(run([], pessoa).mode).toBe('APPROVAL');
    expect(run([], agente).mode).toBe('SHADOW');
    // Sem o ator na proposta, só casam as regras sem esse seletor; fora da Meta, a ferramenta nova segue em sombra.
    expect(run([], proposal({ provider: 'meta_ads' })).mode).toBe('SHADOW');
    expect(run([], proposal({ actor: 'human' })).mode).toBe('SHADOW');

    // A regra do funcionário (a da promoção) não muda o que a pessoa pede; a volta dele para Sombra também não.
    const promovida: PolicyDocument = { rules: [{ type: 'autonomy', action: 'orcamento.aumentar', actor: 'agent', account: 'act_1', mode: 'SUGGEST' }] };
    expect(run([brand(promovida)], agente).mode).toBe('SUGGEST');
    expect(run([brand(promovida)], pessoa).mode).toBe('APPROVAL');
    const emSombra: PolicyDocument = { rules: [{ type: 'autonomy', action: 'orcamento.aumentar', actor: 'agent', account: 'act_1', mode: 'SHADOW' }] };
    expect(run([brand(emSombra)], pessoa).mode).toBe('APPROVAL');

    // A regra sem ator vale para os dois: a da empresa, tão específica quanto a da plataforma, vence para a pessoa também
    // (em Sugerir, o pedido de uma pessoa continua esperando aprovação); a regra sem seletor nenhum perde; ESCALATE vence sempre.
    const larga: PolicyDocument = { rules: [{ type: 'autonomy', action: 'orcamento.*', mode: 'SUGGEST' }] };
    expect(run([tenant(larga)], pessoa).mode).toBe('SUGGEST');
    expect(run([tenant(larga)], agente).mode).toBe('SUGGEST');
    const geral: PolicyDocument = { rules: [{ type: 'autonomy', mode: 'SHADOW' }] };
    expect(run([tenant(geral)], pessoa).mode).toBe('APPROVAL');
    const escala: PolicyDocument = { rules: [{ type: 'autonomy', action: 'orcamento.*', mode: 'ESCALATE' }] };
    expect(run([tenant(escala)], pessoa).mode).toBe('ESCALATE');
    expect(run([tenant(escala)], agente).mode).toBe('ESCALATE');
    // O ator separa a quem a regra se aplica, mas não desempata: a regra com mais um seletor continua vencendo a da promoção.
    const comRisco: PolicyDocument = {
      rules: [
        { type: 'autonomy', action: 'orcamento.aumentar', account: 'act_1', risk: 'R3', mode: 'SHADOW' },
        { type: 'autonomy', action: 'orcamento.aumentar', actor: 'agent', account: 'act_1', mode: 'SUGGEST' },
      ],
    };
    expect(run([brand(comRisco)], agente).mode).toBe('SHADOW');
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
    expect(run([tenant(doc), brand(daMarca)], proposal({ value_micros: 110_000_000 }))).toMatchObject({ mode: 'APPROVAL', versions: ['plataforma@5', 'empresa@1', 'marca@1'] });
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
