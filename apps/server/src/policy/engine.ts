import type { ActionProposal, AutonomyMode, PolicyDecision, PolicyDocument, PolicyRule, PolicyViolation } from '@liame/contracts';

// Motor de políticas determinístico (ADR-007, A1-11). Função pura: a mesma proposta com as mesmas
// políticas e o mesmo instante dá sempre a mesma decisão. A IA nunca decide aqui.

export type PolicySource = 'platform' | 'tenant' | 'brand';

export interface LoadedPolicy {
  source: PolicySource;
  version: number;
  document: PolicyDocument;
}

/**
 * Política da distribuição: vale para todas as empresas, antes das delas, e não pode ser removida.
 * Mudar é uma versão nova no código, com revisão (política como dado, versionada no repositório).
 */
export const PLATFORM_POLICY: LoadedPolicy = {
  source: 'platform',
  version: 1,
  document: {
    rules: [
      // Conteúdo político bloqueado por padrão (ADR-007; TSE 23.755/2026, base §6.1).
      { type: 'forbidden_categories', categories: ['politica'] },
      // A Meta aceita até 4 mudanças de orçamento por hora por conjunto; o nosso limite fica abaixo (ADR-007).
      { type: 'rate_limit', action: 'orcamento.*', provider: 'meta', max: 3, window_minutes: 60 },
      // Apagar é sempre com um humano olhando.
      { type: 'autonomy', action: 'campanha.apagar', mode: 'ESCALATE' },
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

/** Checa uma regra de restrição; devolve a mensagem da violação ou nulo. */
function violationOf(rule: PolicyRule, p: ActionProposal, ctx: { at: Date; timezone: string }): string | null {
  switch (rule.type) {
    case 'max_value':
      if (!actionMatches(rule.action, p.action) || p.value_micros == null) return null;
      return p.value_micros > rule.max_micros ? `O valor ${brl(p.value_micros)} passa do teto de ${brl(rule.max_micros)} por ação.` : null;
    case 'max_change_percent': {
      if (!actionMatches(rule.action, p.action)) return null;
      const change = changePercent(p);
      if (change === null) return null;
      const counts = rule.direction === 'both' || (rule.direction === 'increase' ? change > 0 : change < 0);
      return counts && Math.abs(change) > rule.max_percent
        ? `A variação de ${Math.abs(change).toFixed(1).replace('.', ',')}% passa do máximo de ${String(rule.max_percent).replace('.', ',')}%.`
        : null;
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
      if (!actionMatches(rule.action, p.action) || (rule.provider && rule.provider !== p.provider)) return null;
      return p.recent_count >= rule.max ? `Limite de ${rule.max} execuções a cada ${rule.window_minutes} min atingido.` : null;
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

/**
 * Avalia a proposta contra a política da distribuição, a da empresa e a da marca. Qualquer violação
 * nega. O modo vem da regra de autonomia mais específica (a da marca vence a da empresa no empate);
 * ESCALATE vence sempre; sem regra, SHADOW.
 */
export function evaluatePolicy(policies: LoadedPolicy[], p: ActionProposal, ctx: { at: Date; timezone: string }): PolicyDecision {
  const violations: PolicyViolation[] = [];
  let best: { mode: AutonomyMode; score: number } | null = null;
  let escalate = false;
  for (const policy of policies) {
    policy.document.rules.forEach((rule, index) => {
      if (rule.type === 'autonomy') {
        const score = autonomyMatch(rule, p);
        if (score === null) return;
        if (rule.mode === 'ESCALATE') escalate = true;
        const weighted = score * 100 + SOURCE_WEIGHT[policy.source];
        if (!best || weighted >= best.score) best = { mode: rule.mode, score: weighted };
        return;
      }
      const message = violationOf(rule, p, ctx);
      if (message) violations.push({ source: policy.source, rule_index: index, type: rule.type, message });
    });
  }
  const chosen = best as { mode: AutonomyMode; score: number } | null;
  return {
    allowed: violations.length === 0,
    mode: escalate ? 'ESCALATE' : (chosen?.mode ?? DEFAULT_MODE),
    violations,
    versions: policies.map((x) => `${x.source === 'platform' ? 'plataforma' : x.source === 'tenant' ? 'empresa' : 'marca'}@${x.version}`),
  };
}
