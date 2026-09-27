import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// App autenticador (ADR-013, plano da A1 D-A1-5): TOTP da RFC 6238 com a criptografia nativa do Node.
// HMAC-SHA1, 6 dígitos, passo de 30 s: é o que os apps (Google, Microsoft, 1Password) entendem.

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('base32 inválido');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo de 160 bits (o tamanho do HMAC-SHA1), em base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

export function totpCode(secret: string, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  // HMAC-SHA1 é o que a RFC 6238 e os apps autenticadores usam; aqui não é hash de senha.
  // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_sha1
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Confere o código aceitando 1 passo de relógio para cada lado. Recusa passo já usado (`lastStep`),
 * para o mesmo código não valer duas vezes. Devolve o passo aceito, ou null.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { nowMs?: number; lastStep?: number | null; window?: number } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(options.nowMs);
  const window = options.window ?? 1;
  for (let delta = -window; delta <= window; delta++) {
    const step = now + delta;
    if (options.lastStep != null && step <= options.lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** URI que o app autenticador lê pelo QR (formato Key Uri do Google Authenticator). */
export function otpauthUri(secret: string, account: string, issuer = 'Liame'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 10 códigos de recuperação de uso único, fáceis de digitar (ex.: 7KQ2M-XH4RP). */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(7)).slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/**
 * O banco guarda só o hash do código de recuperação (entropia alta: SHA-256 basta). Normaliza o que a
 * pessoa digita: caixa, espaço e hífen; e 0 → O, 1 → I (o base32 não tem 0 nem 1, que se confundem com
 * as letras no papel).
 */
export function hashRecoveryCode(code: string): string {
  const normalizado = code.toUpperCase().replace(/[\s-]/g, '').replaceAll('0', 'O').replaceAll('1', 'I');
  return createHash('sha256').update(normalizado).digest('hex');
}
