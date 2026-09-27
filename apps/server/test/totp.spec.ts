import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from '../src/auth/totp.js';

// Vetores oficiais da RFC 6238 (apêndice B), SHA-1, segredo "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('bate com os vetores oficiais da RFC', () => {
    for (const [seconds, expected] of VECTORS) {
      expect(totpCode(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(expected);
    }
  });

  it('base32 ida e volta', () => {
    const buf = Buffer.from('liame-segredo-de-teste');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('aceita 1 passo de relógio para cada lado e recusa 2', () => {
    const secret = newTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step - 1), { nowMs: now })).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), { nowMs: now })).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), { nowMs: now })).toBeNull();
  });

  it('o mesmo código não vale duas vezes (passo já usado)', () => {
    const secret = newTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code, { nowMs: now, lastStep: null })).toBe(step);
    expect(verifyTotp(secret, code, { nowMs: now, lastStep: step })).toBeNull();
  });

  it('recusa formato errado sem calcular nada', () => {
    expect(verifyTotp(newTotpSecret(), '12345')).toBeNull();
    expect(verifyTotp(newTotpSecret(), 'abcdef')).toBeNull();
  });

  it('URI do QR no formato dos apps autenticadores', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'ana@exemplo.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\/Liame%3Aana%40exemplo\.com\?secret=JBSWY3DPEHPK3PXP&issuer=Liame&algorithm=SHA1&digits=6&period=30$/);
  });

  it('10 códigos de recuperação distintos; o hash ignora caixa e hífen', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    expect(hashRecoveryCode(codes[0]!.toLowerCase().replace('-', ''))).toBe(hashRecoveryCode(codes[0]!));
    // Zero e um digitados no lugar das letras O e I (o base32 não tem 0 nem 1).
    expect(hashRecoveryCode('4035H-3FWT1')).toBe(hashRecoveryCode('4O35H-3FWTI'));
  });
});
