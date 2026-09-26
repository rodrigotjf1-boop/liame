import { describe, expect, it } from 'vitest';
import { hashPassword, isBreachedPassword, verifyPassword } from '../src/auth/password.js';

describe('senha: scrypt e checagem de vazamento', () => {
  it('confere a senha certa, recusa a errada e não guarda a senha', async () => {
    const hash = await hashPassword('minha frase de teste bem longa');
    expect(hash).toMatch(/^scrypt\$17\$8\$1\$/);
    expect(hash).not.toContain('minha frase');
    expect(await verifyPassword('minha frase de teste bem longa', hash)).toBe(true);
    expect(await verifyPassword('minha frase de teste bem longA', hash)).toBe(false);
  });

  it('dois hashes da mesma senha são diferentes (sal)', async () => {
    const [a, b] = await Promise.all([hashPassword('mesma frase comprida'), hashPassword('mesma frase comprida')]);
    expect(a).not.toBe(b);
  });

  it('manda só o prefixo do SHA-1 e reconhece a senha vazada', async () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    let url = '';
    const fake = (async (input: string | URL | Request) => {
      url = String(input);
      return new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:3861493\r\n0000000000000000000000000000000000A:0');
    }) as typeof fetch;
    expect(await isBreachedPassword('password', fake)).toBe(true);
    expect(url).toMatch(/\/range\/5BAA6$/);
  });

  it('senha que não aparece na lista passa', async () => {
    const fake = (async () => new Response('0000000000000000000000000000000000A:0')) as unknown as typeof fetch;
    expect(await isBreachedPassword('frase que ninguém usa 8472', fake)).toBe(false);
  });

  it('serviço fora do ar não trava o cadastro (passa e registra)', async () => {
    const fake = (async () => {
      throw new Error('sem rede');
    }) as unknown as typeof fetch;
    expect(await isBreachedPassword('qualquer frase longa aqui', fake)).toBe(false);
  });
});
