import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { Logger } from '@nestjs/common';

// Senha com scrypt nativo do Node (plano da A1, D-A1-3): sem dependência nativa nova.
// Parâmetros do OWASP (N = 2^17, r = 8, p = 1). O formato guarda os parâmetros, para subir o custo depois.
const N_LOG2 = 17;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, KEYLEN, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const options = (nLog2: number, r: number, p: number): ScryptOptions => ({
  N: 2 ** nLog2,
  r,
  p,
  maxmem: 256 * 1024 * 1024,
});

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, options(N_LOG2, R, P));
  return `scrypt$${N_LOG2}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), options(Number(n), Number(r), Number(p)));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** Gasta o mesmo tempo de uma verificação real quando o e-mail não existe (não revela quem tem conta). */
export async function burnPasswordTime(password: string): Promise<void> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
}

const logger = new Logger('senha');

/**
 * Senha vazada? Have I Been Pwned por k-anonimato: só os 5 primeiros caracteres do SHA-1 saem,
 * com preenchimento. Se o serviço não responder, deixa passar e registra o motivo (não trava o cadastro).
 */
export async function isBreachedPassword(password: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  // SHA-1 aqui é o formato exigido pela API de k-anonimato do HIBP, não proteção de senha (a senha fica em scrypt).
  // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_sha1
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'liame-senha' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    return body.split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch (err) {
    logger.warn(`checagem de senha vazada indisponível: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
