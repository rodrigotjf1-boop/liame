import { describe, expect, it } from 'vitest';
import { descreverAparelho, mascararIp } from '../src/auth/aparelho.js';

describe('aparelho e IP para a tela de segurança', () => {
  it('reconhece navegador e sistema pelos agentes comuns', () => {
    const casos: [string, string][] = [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Chrome no Windows'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0', 'Edge no Windows'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari no iPhone'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari no Mac'],
      ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36', 'Samsung Internet no Android'],
      ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'Firefox no Linux'],
      ['curl/8.9.1', 'Aparelho desconhecido'],
    ];
    for (const [ua, esperado] of casos) expect(descreverAparelho(ua)).toBe(esperado);
    expect(descreverAparelho(null)).toBe('Aparelho desconhecido');
  });

  it('esconde o final do IP', () => {
    expect(mascararIp('177.52.18.201')).toBe('177.52.18.x');
    expect(mascararIp('::ffff:189.40.7.9')).toBe('189.40.7.x');
    expect(mascararIp('2804:14c:65:8a00:1234:5678:9abc:def0')).toBe('2804:14c:65::x');
    // Forma comprimida: expande antes de cortar, e nunca mostra o endereço inteiro (ERR-032).
    expect(mascararIp('::1')).toBe('0:0:0::x');
    expect(mascararIp('2804::1a2b')).toBe('2804:0:0::x');
    expect(mascararIp('2804:14c::1')).toBe('2804:14c:0::x');
    expect(mascararIp('2804:014C:0065::8A00')).toBe('2804:14c:65::x');
    expect(mascararIp('fe80::1%eth0')).toBe('fe80:0:0::x');
    expect(mascararIp('64:ff9b::192.0.2.1')).toBe('64:ff9b:0::x');
    expect(mascararIp('não é ip')).toBeNull();
    expect(mascararIp('2804:::1')).toBeNull();
    expect(mascararIp(null)).toBeNull();
  });
});
