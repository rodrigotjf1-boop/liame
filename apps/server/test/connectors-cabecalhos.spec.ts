import { describe, expect, it } from 'vitest';
import { lerDepreciacao, lerRetryAfter, lerUsoMeta } from '../src/connectors/cabecalhos.js';
import { classificar, enderecoLiberado } from '../src/connectors/cliente-http.js';

describe('cabeçalhos das plataformas', () => {
  it('uso de cota da Meta: maior porcentagem entre as cotas e a espera pedida', () => {
    const h = new Headers({
      'x-business-use-case-usage': JSON.stringify({ '123': [{ type: 'ads_insights', call_count: 12, total_cputime: 40, total_time: 95, estimated_time_to_regain_access: 0 }] }),
      'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 20, reset_time_duration: 0 }),
      'x-fb-ads-insights-throttle': JSON.stringify({ app_id_util_pct: 7, acc_id_util_pct: 3 }),
    });
    expect(lerUsoMeta(h)).toEqual({ maiorPct: 95, esperarMs: 0 });
    const bloqueada = new Headers({ 'x-business-use-case-usage': JSON.stringify({ '123': [{ call_count: 100, estimated_time_to_regain_access: 5 }] }) });
    expect(lerUsoMeta(bloqueada)).toEqual({ maiorPct: 100, esperarMs: 300_000 });
    expect(lerUsoMeta(new Headers())).toBeNull();
  });

  it('Retry-After em segundos e em data', () => {
    expect(lerRetryAfter(new Headers({ 'retry-after': '30' }))).toBe(30_000);
    const agora = new Date('2026-09-26T12:00:00Z');
    expect(lerRetryAfter(new Headers({ 'retry-after': 'Sat, 26 Sep 2026 12:01:00 GMT' }), agora)).toBe(60_000);
    expect(lerRetryAfter(new Headers())).toBeNull();
  });

  it('depreciação (RFC 9745) e fim (RFC 8594), com o link', () => {
    const h = new Headers({
      deprecation: '@1788220800',
      sunset: 'Wed, 30 Dec 2026 23:59:59 GMT',
      link: '<https://developers.example/versions>; rel="deprecation"',
    });
    expect(lerDepreciacao(h)).toEqual({
      deprecation: '2026-09-01T00:00:00.000Z',
      sunset: '2026-12-30T23:59:59.000Z',
      link: 'https://developers.example/versions',
    });
    expect(lerDepreciacao(new Headers())).toBeNull();
  });
});

describe('endereços liberados', () => {
  const meta = ['https://graph.facebook.com'];
  it('mesma origem passa; parecido não passa', () => {
    expect(enderecoLiberado('https://graph.facebook.com/v26.0/me/adaccounts?limit=200', meta)).toBe(true);
    expect(enderecoLiberado('https://graph.facebook.com.outro.site/v26.0/me', meta)).toBe(false);
    expect(enderecoLiberado('https://graph.facebook.com@outro.site/v26.0/me', meta)).toBe(false);
    expect(enderecoLiberado('http://graph.facebook.com/v26.0/me', meta)).toBe(false);
    expect(enderecoLiberado('https://graph.facebook.com:8443/v26.0/me', meta)).toBe(false);
    expect(enderecoLiberado('nem-endereco', meta)).toBe(false);
  });
  it('com caminho na base, só abaixo dele', () => {
    const base = ['http://127.0.0.1:4000/meta'];
    expect(enderecoLiberado('http://127.0.0.1:4000/meta/v26.0/x', base)).toBe(true);
    expect(enderecoLiberado('http://127.0.0.1:4000/metaoutra/v26.0/x', base)).toBe(false);
    expect(enderecoLiberado('http://127.0.0.1:4000/outra', base)).toBe(false);
  });
});

describe('classificação dos erros das plataformas', () => {
  const h = new Headers();
  it('Meta', () => {
    expect(classificar('meta_ads', 400, { error: { code: 17, message: 'User request limit reached' } }, h, null).tipo).toBe('limite');
    expect(classificar('meta_ads', 400, { error: { code: 80004, message: 'too many calls' } }, h, null).tipo).toBe('limite');
    expect(classificar('meta_ads', 400, { error: { code: 190, message: 'Error validating access token' } }, h, null).tipo).toBe('autenticacao');
    expect(classificar('meta_ads', 400, { error: { code: 200, message: 'Permissions error' } }, h, null).tipo).toBe('permissao');
    expect(classificar('meta_ads', 500, { error: { code: 2, message: 'Service temporarily unavailable' } }, h, null).tipo).toBe('transitorio');
    expect(classificar('meta_ads', 400, { error: { code: 100, message: 'Invalid parameter' } }, h, null).tipo).toBe('definitivo');
  });
  it('Google', () => {
    expect(classificar('google_ads', 429, { error: { status: 'RESOURCE_EXHAUSTED' } }, h, null).tipo).toBe('limite');
    expect(classificar('google_ads', 401, { error: { status: 'UNAUTHENTICATED' } }, h, null).tipo).toBe('autenticacao');
    expect(classificar('ga4', 403, { error: { status: 'PERMISSION_DENIED' } }, h, null).tipo).toBe('permissao');
    expect(classificar('google_ads', 503, { error: { status: 'UNAVAILABLE' } }, h, null).tipo).toBe('transitorio');
  });
});
