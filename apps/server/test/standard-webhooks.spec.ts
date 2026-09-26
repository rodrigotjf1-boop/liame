import { describe, expect, it } from 'vitest';
import { assertSafeUrl, isPrivateAddress, safePost } from '../src/events/safe-http.js';
import { newWebhookSecret, signWebhook, verifyWebhook, webhookHeaders } from '../src/events/standard-webhooks.js';

describe('Standard Webhooks', () => {
  it('bate com o exemplo da especificação', () => {
    // Vetor público do repositório standard-webhooks (não é segredo de verdade).
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'; // gitleaks:allow
    const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek'; // gitleaks:allow
    const expected = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='; // gitleaks:allow
    expect(signWebhook(secret, id, 1614265330, '{"test": 2432232314}')).toBe(expected);
  });

  it('assina e verifica; corpo alterado, segredo errado ou mensagem velha não passam', () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const body = '{"type":"liame.brand.created"}';
    const now = new Date('2026-09-26T12:00:00Z');
    const headers = webhookHeaders(secret, 'evt_1', body, now);
    expect(verifyWebhook(secret, { ...headers }, body, { now })).toEqual({ ok: true, id: 'evt_1', timestamp: 1790424000 });
    expect(verifyWebhook(secret, { ...headers }, `${body} `, { now }).ok).toBe(false);
    expect(verifyWebhook(newWebhookSecret(), { ...headers }, body, { now }).ok).toBe(false);
    const later = new Date(now.getTime() + 6 * 60_000);
    expect(verifyWebhook(secret, { ...headers }, body, { now: later })).toEqual({ ok: false, reason: 'webhook-timestamp fora da tolerância' });
    expect(verifyWebhook(secret, {}, body).ok).toBe(false);
  });

  it('aceita uma entre várias assinaturas (troca de segredo)', () => {
    const [velho, novo] = [newWebhookSecret(), newWebhookSecret()];
    const body = '{}';
    const now = new Date();
    const h = webhookHeaders(novo, 'evt_2', body, now);
    const both = `${signWebhook(velho, 'evt_2', Number(h['webhook-timestamp']), body)} ${h['webhook-signature']}`;
    expect(verifyWebhook(novo, { ...h, 'webhook-signature': both }, body, { now }).ok).toBe(true);
  });
});

describe('proteção contra SSRF nos webhooks de saída', () => {
  it('reconhece endereço privado, de loopback, link-local e reservado', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1']) {
      expect({ ip, privado: isPrivateAddress(ip) }).toEqual({ ip, privado: true });
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:808:808']) {
      expect({ ip, privado: isPrivateAddress(ip) }).toEqual({ ip, privado: false });
    }
  });

  it('recusa http, localhost, IP interno e usuário na URL quando a rede privada não é permitida', () => {
    expect(() => assertSafeUrl('http://parceiro.com.br/hook', false)).toThrow('https');
    expect(() => assertSafeUrl('https://localhost/hook', false)).toThrow('rede interna');
    expect(() => assertSafeUrl('https://169.254.169.254/latest', false)).toThrow('rede interna');
    expect(() => assertSafeUrl('https://[::1]/hook', false)).toThrow('rede interna');
    expect(() => assertSafeUrl('https://user:pass@parceiro.com.br/hook', false)).toThrow('usuário e senha');
    expect(() => assertSafeUrl('ftp://parceiro.com.br/hook', false)).toThrow('https');
    expect(assertSafeUrl('https://parceiro.com.br/hook', false).hostname).toBe('parceiro.com.br');
  });

  it('não chega a abrir conexão para a rede interna', async () => {
    await expect(safePost('https://127.0.0.1:9443/hook', '{}', {}, { allowPrivateNetwork: false })).rejects.toThrow('rede interna');
  });
});
