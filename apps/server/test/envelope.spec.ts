import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blindIndex, open, seal } from '../src/vault/envelope.js';
import { createKeyProvider } from '../src/vault/vault.module.js';

describe('envelope AES-256-GCM', () => {
  const key = randomBytes(32);

  it('abre com o mesmo contexto e não abre com outro', () => {
    const s = seal(key, Buffer.from('segredo'), { secret_id: 'a', purpose: 'totp' });
    expect(open(key, s.iv, s.ciphertext, { purpose: 'totp', secret_id: 'a' }).toString()).toBe('segredo');
    expect(() => open(key, s.iv, s.ciphertext, { purpose: 'totp', secret_id: 'b' })).toThrow();
  });

  it('cifra alterada não abre (integridade)', () => {
    const s = seal(key, Buffer.from('segredo'), { id: '1' });
    s.ciphertext[0] = (s.ciphertext[0] ?? 0) ^ 1;
    expect(() => open(key, s.iv, s.ciphertext, { id: '1' })).toThrow();
  });

  it('índice cego é estável por chave e diferente entre chaves', () => {
    const outra = randomBytes(32);
    expect(blindIndex(key, '+5521999990000')).toBe(blindIndex(key, '+5521999990000'));
    expect(blindIndex(key, '+5521999990000')).not.toBe(blindIndex(outra, '+5521999990000'));
  });
});

describe('provedor de chaves pelo ambiente', () => {
  it('em produção, recusa o provedor local (ADR-011)', async () => {
    await expect(createKeyProvider({ NODE_ENV: 'production', KEY_PROVIDER: 'local', LIAME_KEK_LOCAL: `1:${randomBytes(32).toString('base64')}` })).rejects.toThrow(
      /aws-kms/,
    );
  });

  it('recusa chave mestra local com tamanho errado', async () => {
    await expect(createKeyProvider({ NODE_ENV: 'test', LIAME_KEK_LOCAL: `1:${randomBytes(16).toString('base64')}` })).rejects.toThrow(/32 bytes/);
  });
});
