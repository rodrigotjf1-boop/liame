// Leitura dos cabeçalhos que as plataformas devolvem em toda resposta: uso de cota (Meta), espera pedida
// (Retry-After) e avisos de depreciação (RFC 9745 `Deprecation`, RFC 8594 `Sunset`, `Link` com
// rel="deprecation"/"sunset"). Base de conhecimento §2.1 e §17.3.

export type UsoDeCota = {
  /** Maior porcentagem usada entre as cotas informadas (0–100+). */
  maiorPct: number;
  /** A Meta diz quanto falta para voltar a ter acesso (minutos → ms), quando bloqueia. */
  esperarMs: number;
};

function numero(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Meta: `X-Business-Use-Case-Usage` ({ "<business>": [{ call_count, total_cputime, total_time,
 * estimated_time_to_regain_access }] }), `X-Ad-Account-Usage` ({ acc_id_util_pct, reset_time_duration })
 * e `X-FB-Ads-Insights-Throttle` ({ app_id_util_pct, acc_id_util_pct }).
 */
export function lerUsoMeta(h: Headers): UsoDeCota | null {
  let maiorPct = 0;
  let esperarMs = 0;
  let viu = false;
  const json = (nome: string): unknown => {
    const v = h.get(nome);
    if (!v) return null;
    try {
      viu = true;
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  const buc = json('x-business-use-case-usage');
  if (buc && typeof buc === 'object') {
    for (const lista of Object.values(buc as Record<string, unknown>)) {
      for (const item of Array.isArray(lista) ? lista : []) {
        const i = item as Record<string, unknown>;
        maiorPct = Math.max(maiorPct, numero(i.call_count), numero(i.total_cputime), numero(i.total_time));
        esperarMs = Math.max(esperarMs, numero(i.estimated_time_to_regain_access) * 60_000);
      }
    }
  }
  const conta = json('x-ad-account-usage') as Record<string, unknown> | null;
  if (conta) {
    maiorPct = Math.max(maiorPct, numero(conta.acc_id_util_pct));
    // reset_time_duration vem em segundos; só vale como espera quando a conta está no limite.
    if (numero(conta.acc_id_util_pct) >= 100) esperarMs = Math.max(esperarMs, numero(conta.reset_time_duration) * 1000);
  }
  const insights = json('x-fb-ads-insights-throttle') as Record<string, unknown> | null;
  if (insights) maiorPct = Math.max(maiorPct, numero(insights.app_id_util_pct), numero(insights.acc_id_util_pct));
  return viu ? { maiorPct, esperarMs } : null;
}

/** `Retry-After` em segundos ou data HTTP → milissegundos (nulo sem o cabeçalho). */
export function lerRetryAfter(h: Headers, agora: Date = new Date()): number | null {
  const v = h.get('retry-after');
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v) * 1000;
  const data = Date.parse(v);
  return Number.isNaN(data) ? null : Math.max(0, data - agora.getTime());
}

export type AvisoDepreciacao = { deprecation: string | null; sunset: string | null; link: string | null };

/**
 * `Deprecation: @1735689600` (RFC 9745: data estruturada em segundos desde a época) ou o formato antigo
 * `true`; `Sunset: Wed, 31 Dec 2026 23:59:59 GMT` (RFC 8594); `Link: <url>; rel="deprecation"`.
 * Devolve as datas em ISO quando der para ler; nulo quando não há aviso.
 */
export function lerDepreciacao(h: Headers): AvisoDepreciacao | null {
  const dep = h.get('deprecation');
  const sun = h.get('sunset');
  if (!dep && !sun) return null;
  let deprecation: string | null = null;
  if (dep) {
    const m = /^@(\d+)$/.exec(dep.trim());
    deprecation = m ? new Date(Number(m[1]) * 1000).toISOString() : dep.trim();
  }
  let sunset: string | null = null;
  if (sun) {
    const d = Date.parse(sun);
    sunset = Number.isNaN(d) ? sun.trim() : new Date(d).toISOString();
  }
  const link = /<([^>]+)>\s*;\s*rel="?(deprecation|sunset)"?/i.exec(h.get('link') ?? '')?.[1] ?? null;
  return { deprecation, sunset, link };
}
