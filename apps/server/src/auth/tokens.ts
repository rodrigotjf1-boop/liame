import { createHash, randomBytes } from 'node:crypto';

/** Token de uso único ou de sessão: 32 bytes aleatórios. O banco guarda só o hash (SHA-256). */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
