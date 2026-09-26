import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Standard Webhooks (standardwebhooks.com): HMAC-SHA256 sobre `id.timestamp.corpo`, cabeçalhos
// `webhook-id`, `webhook-timestamp` e `webhook-signature` (ADR-004). Serve para assinar o que o Liame
// envia e para verificar o que ele recebe de quem usa o mesmo padrão.

const PREFIX = 'whsec_';
/** Tolerância de relógio na verificação (proteção contra reenvio de mensagem antiga). */
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/** Segredo novo no formato do padrão: `whsec_` + 32 bytes em base64. */
export function newWebhookSecret(): string {
  return PREFIX + randomBytes(32).toString('base64');
}

function keyOf(secret: string): Buffer {
  const raw = secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret;
  const key = Buffer.from(raw, 'base64');
  if (key.length < 16) throw new Error('segredo de webhook curto demais');
  return key;
}

export function signWebhook(secret: string, id: string, timestampSeconds: number, payload: string): string {
  const mac = createHmac('sha256', keyOf(secret)).update(`${id}.${timestampSeconds}.${payload}`).digest('base64');
  return `v1,${mac}`;
}

/** Cabeçalhos prontos para enviar o corpo `payload`. */
export function webhookHeaders(secret: string, id: string, payload: string, now = new Date()): WebhookHeaders {
  const timestamp = Math.floor(now.getTime() / 1000);
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signWebhook(secret, id, timestamp, payload) };
}

export type VerifyResult = { ok: true; id: string; timestamp: number } | { ok: false; reason: string };

/**
 * Verifica a assinatura. Aceita várias assinaturas separadas por espaço (troca de segredo) e recusa
 * mensagem fora da tolerância de relógio. Comparação em tempo constante.
 */
export function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  payload: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): VerifyResult {
  const one = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = one('webhook-id');
  const ts = one('webhook-timestamp');
  const signatures = one('webhook-signature');
  if (!id || !ts || !signatures) return { ok: false, reason: 'cabeçalhos do webhook ausentes' };
  const timestamp = Number(ts);
  if (!Number.isInteger(timestamp)) return { ok: false, reason: 'webhook-timestamp inválido' };
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    return { ok: false, reason: 'webhook-timestamp fora da tolerância' };
  }
  const expected = Buffer.from(signWebhook(secret, id, timestamp, payload).slice(3), 'base64');
  for (const candidate of signatures.split(' ')) {
    const [version, value] = candidate.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const got = Buffer.from(value, 'base64');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true, id, timestamp };
  }
  return { ok: false, reason: 'assinatura não confere' };
}
