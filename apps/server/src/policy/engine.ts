import type { ActionProposal, AutonomyMode, PolicyDecision, PolicyDocument, PolicyRule, PolicyViolation } from '@liame/contracts';

// Motor de políticas determinístico (ADR-007, A1-11). Função pura: a mesma proposta com as mesmas
// políticas, o mesmo instante e as mesmas contagens dá sempre a mesma decisão. A IA nunca decide aqui.

export type PolicySource = 'platform' | 'tenant' | 'brand';

export interface LoadedPolicy {
  source: PolicySource;
  version: number;
  document: PolicyDocument;
}

/**
 * Quanto um pedido pode mexer na verba diária de uma vez, em % (A4, D-A4-6). O plano dizia 20; o dono baixou para 10 em
 * 04/10/2026. O passo da recomendação da sombra (`sombra/regras.ts`) usa o mesmo número, para a recomendação caber no pedido.
 */
export const VARIACAO_MAXIMA_DA_VERBA_PCT = 10;

/**
 * Política da distribuição: vale para todas as empresas, antes das delas, e não pode ser removida.
 * Mudar é uma versão nova no código, com revisão (política como dado, versionada no repositório).
 */
export const PLATFORM_POLICY: LoadedPolicy = {
  source: 'platform',
  version: 3,
  document: {
    rules: [
      // Conteúdo político bloqueado por padrão (ADR-007; TSE 23.755/2026, base §6.1).
      { type: 'forbidden_categories', categories: ['politica'] },
      // A Meta aceita até 4 mudanças de orçamento por hora por conjunto; o nosso limite fica abaixo (ADR-007).
      // v3 (A4, X2): o provedor é `meta_ads`, como nas contas conectadas (na v2 estava `meta`, e a regra nunca casaria),
      // e a conta é por objeto (o mesmo conjunto, a mesma campanha), que é como a Meta conta.
      { type: 'rate_limit', action: 'orcamento.*', provider: 'meta_ads', per: 'resource', max: 3, window_minutes: 60 },
      // v3 (A4, D-A4-6): na Meta, cada pedido mexe no máximo 10% da verba, para cima ou para baixo.
      { type: 'max_change_percent', action: 'orcamento.*', provider: 'meta_ads', max_percent: VARIACAO_MAXIMA_DA_VERBA_PCT, direction: 'both' },
      // Apagar é sempre com um humano olhando.
      { type: 'autonomy', action: 'campanha.apagar', mode: 'ESCALATE' },
      // Cupom de campanha no Regem (v2, 01/10/2026): sempre com a aprovação de alguém da empresa (plano da A2.5, F6).
      { type: 'autonomy', action: 'cupom.criar', mode: 'APPROVAL' },
      // v3 (A4, D-A4-4 e D-A4-7): o que uma PESSOA pede na Meta espera a aprovação com o código do app. O modo do
      // funcionário de IA em cada conta (Sombra, Sugerir, Aprovação) é outra regra, com `actor: 'agent'`: esta não o
      // muda. Os modos automáticos seguem presos pela flag `autopilot`.
      { type: 'autonomy', provider: 'meta_ads', actor: 'human', mode: 'APPROVAL' },
    ],
  },
};

/** Modo de uma ação sem regra de autonomia: ferramenta nova começa em sombra (ai-architecture §4.1). */
export const DEFAULT_MODE: AutonomyMode = 'SHADOW';

const SOURCE_WEIGHT: Record<PolicySource, number> = { platform: 0, tenant: 10, brand: 20 };

export function actionMatches(pattern: string | undefined, action: string): boolean {
  if (!pattern) return true;
  if (pattern.endsWith('.*')) return action.startsWith(pattern.slice(0, -1));
  return pattern === action;
}

/** A regra com provedor só vale para a proposta daquele provedor; sem provedor, vale para todos. */
function providerMatches(provider: string | undefined, p: Pick<ActionProposal, 'provider'>): boolean {
  return !provider || provider === p.provider;
}

/** Variação em % do valor atual para o pedido (nula se faltar um dos dois ou o atual for zero). */
export function changePercent(p: Pick<ActionProposal, 'value_micros' | 'current_value_micros'>): number | null {
  if (p.value_micros == null || p.current_value_micros == null || p.current_value_micros === 0) return null;
  return ((p.value_micros - p.current_value_micros) / p.current_value_micros) * 100;
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Dia da semana (0 = domingo) e minuto do dia no fuso da empresa. */
export function localClock(at: Date, timezone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinute = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const brl = (micros: number) => (micros / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
/** "10,0" e, quando a primeira casa não mostra a diferença, "10,01" (para não dizer que 10,0% passa de 10%). */
const pct = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2, useGrouping: false });

type RateLimitRule = Extract<PolicyRule, { type: 'rate_limit' }>;

/**
 * As regras de frequência que valem para a proposta. Quem pede conta as execuções recentes de cada uma (no alcance e
 * na janela dela) e entrega em `recent`; sem essa conta, vale o `recent_count` da proposta.
 */
export function rateLimitsFor(policies: LoadedPolicy[], p: Pick<ActionProposal, 'action' | 'provider'>): RateLimitRule[] {
  return policies.flatMap((policy) => policy.document.rules.filter((r): r is RateLimitRule => r.type === 'rate_limit' && actionMatches(r.action, p.action) && providerMatches(r.provider, p)));
}

/** O que a avaliação precisa além da proposta e das políticas: o instante, o fuso e as contagens das regras de frequência. */
export interface PolicyContext {
  at: Date;
  timezone: string;
  recent?: ReadonlyMap<PolicyRule, number>;
}

/** Checa uma regra de restrição; devolve a mensagem da violação ou nulo. */
function violationOf(rule: PolicyRule, p: ActionProposal, ctx: PolicyContext): string | null {
  switch (rule.type) {
    case 'max_value':
      // O teto vale para o que faz o gasto subir. Reduzir para um valor ainda acima dele é a direção segura (a verba
      // que alguém definiu acima do teto precisa poder baixar), e a volta devolve o valor que já estava lá antes da ação.
      if (p.undo || p.budget_impact === 'decrease' || !actionMatches(rule.action, p.action) || !providerMatches(rule.provider, p) || p.value_micros == null) return null;
      if (p.value_micros <= rule.max_micros) return null;
      // Na verba diária, o teto tem nome na tela (Verba do mês): é o teto por campanha (D-A4-19).
      return p.action.startsWith('orcamento.')
        ? `A verba de ${brl(p.value_micros)} por dia passa do teto por campanha, que é de ${brl(rule.max_micros)} por dia.`
        : `O valor ${brl(p.value_micros)} passa do teto de ${brl(rule.max_micros)} por ação.`;
    case 'max_change_percent': {
      if (p.undo || !actionMatches(rule.action, p.action) || !providerMatches(rule.provider, p)) return null;
      const change = changePercent(p);
      if (change === null) return null;
      const counts = rule.direction === 'both' || (rule.direction === 'increase' ? change > 0 : change < 0);
      return counts && Math.abs(change) > rule.max_percent ? `A variação de ${pct(Math.abs(change))}% passa do máximo de ${String(rule.max_percent).replace('.', ',')}%.` : null;
    }
    case 'allowed_hours': {
      if (!actionMatches(rule.action, p.action)) return null;
      const { day, minute } = localClock(ctx.at, ctx.timezone);
      const [start, end] = [toMinute(rule.start), toMinute(rule.end)];
      // Janela que passa da meia-noite (22:00–06:00) conta o dia em que começou.
      const inWindow = start <= end ? minute >= start && minute < end : minute >= start || minute < end;
      const windowDay = start > end && minute < end ? (day + 6) % 7 : day;
      const dayOk = !rule.days || rule.days.includes(windowDay);
      return inWindow && dayOk ? null : `Fora do horário permitido (${rule.start}–${rule.end}, fuso ${ctx.timezone}).`;
    }
    case 'allowed_accounts':
      if (p.provider !== rule.provider || !p.account_id) return null;
      return rule.accounts.includes(p.account_id) ? null : `A conta ${p.account_id} (${rule.provider}) não está entre as permitidas.`;
    case 'allowed_scope': {
      if (rule.tools && !rule.tools.includes(p.tool)) return `A ferramenta ${p.tool} está fora do escopo permitido.`;
      if (rule.actions && !rule.actions.some((a) => actionMatches(a, p.action))) return `A ação ${p.action} está fora do escopo permitido.`;
      return null;
    }
    case 'forbidden_categories': {
      const hit = p.categories.filter((c) => rule.categories.includes(c));
      return hit.length ? `Categoria proibida: ${hit.join(', ')}.` : null;
    }
    case 'forbidden_words': {
      if (!p.text) return null;
      const text = normalize(p.text);
      const hit = rule.words.filter((w) => text.includes(normalize(w)));
      return hit.length ? `Texto com termo proibido: ${hit.join(', ')}.` : null;
    }
    case 'rate_limit':
      if (!actionMatches(rule.action, p.action) || !providerMatches(rule.provider, p)) return null;
      return (ctx.recent?.get(rule) ?? p.recent_count) >= rule.max
        ? `Limite de ${rule.max} ${rule.max === 1 ? 'execução' : 'execuções'} a cada ${rule.window_minutes} min atingido${rule.per === 'resource' ? ' neste objeto' : ''}.`
        : null;
    case 'autonomy':
      return null;
  }
}

/** Especificidade da regra de autonomia: quanto mais seletores, mais específica. */
function autonomyMatch(rule: Extract<PolicyRule, { type: 'autonomy' }>, p: ActionProposal): number | null {
  let score = 0;
  if (rule.action) {
    if (!actionMatches(rule.action, p.action)) return null;
    score += rule.action.endsWith('.*') ? 1 : 2;
  }
  if (rule.tool) {
    if (rule.tool !== p.tool) return null;
    score += 2;
  }
  if (rule.provider) {
    if (rule.provider !== p.provider) return null;
    score += 1;
  }
  // Quem pede separa a quem a regra se aplica (pessoa ou funcionário de IA); não entra na conta de especificidade, para
  // a regra com ator pesar o mesmo que pesava antes de o seletor existir.
  if (rule.actor && rule.actor !== p.actor) return null;
  if (rule.account) {
    if (rule.account !== p.account_id) return null;
    score += 3;
  }
  if (rule.risk) {
    if (rule.risk !== p.risk_level) return null;
    score += 1;
  }
  if (rule.up_to_percent !== undefined) {
    const change = changePercent(p);
    if (change === null || change > rule.up_to_percent) return null;
    score += 1;
  }
  if (rule.above_micros !== undefined) {
    if (p.value_micros == null || p.value_micros <= rule.above_micros) return null;
    score += 1;
  }
  return score;
}

/** O modo escolhido e a política de onde ele veio (nula: nenhuma regra casou, vale o padrão). */
export interface ModoEscolhido {
  mode: AutonomyMode;
  source: PolicySource | null;
  version: number | null;
}

/**
 * O modo da proposta: a regra de autonomia mais específica (a da marca vence a da empresa no empate);
 * ESCALATE vence sempre; sem regra, SHADOW.
 */
export function chooseMode(policies: LoadedPolicy[], p: ActionProposal): ModoEscolhido {
  let best: (ModoEscolhido & { score: number }) | null = null;
  let escalate: ModoEscolhido | null = null;
  for (const policy of policies) {
    for (const rule of policy.document.rules) {
      if (rule.type !== 'autonomy') continue;
      const score = autonomyMatch(rule, p);
      if (score === null) continue;
      if (rule.mode === 'ESCALATE' && !escalate) escalate = { mode: 'ESCALATE', source: policy.source, version: policy.version };
      const weighted = score * 100 + SOURCE_WEIGHT[policy.source];
      if (!best || weighted >= best.score) best = { mode: rule.mode, source: policy.source, version: policy.version, score: weighted };
    }
  }
  if (escalate) return escalate;
  return best ? { mode: best.mode, source: best.source, version: best.version } : { mode: DEFAULT_MODE, source: null, version: null };
}

/**
 * Avalia a proposta contra a política da distribuição, a da empresa e a da marca. Qualquer violação
 * nega. O modo vem de `chooseMode`.
 */
export function evaluatePolicy(policies: LoadedPolicy[], p: ActionProposal, ctx: PolicyContext): PolicyDecision {
  const violations: PolicyViolation[] = [];
  for (const policy of policies) {
    policy.document.rules.forEach((rule, index) => {
      if (rule.type === 'autonomy') return;
      const message = violationOf(rule, p, ctx);
      if (message) violations.push({ source: policy.source, rule_index: index, type: rule.type, message });
    });
  }
  return {
    allowed: violations.length === 0,
    mode: chooseMode(policies, p).mode,
    violations,
    versions: policies.map((x) => `${x.source === 'platform' ? 'plataforma' : x.source === 'tenant' ? 'empresa' : 'marca'}@${x.version}`),
  };
}
