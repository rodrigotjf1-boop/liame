import { describe, expect, it } from 'vitest';
import { diaNoFuso, enderecoDoCardapio, periodoDoVinculo, plataformaDoEndereco, sugerirPlataforma } from '../src/coupons/plataforma.js';

// A2.5 · F6: a plataforma de pedidos sugerida pelos anúncios, o endereço de "outra plataforma" e o período do
// vínculo do cupom em dias do fuso da loja.

const CARDAPIO = 'https://app.dmsregem.com/c/525ad7a2c822';

describe('plataforma de pedidos pelo endereço do anúncio', () => {
  it('reconhece o Anota AI e o CardápioWeb pelo domínio, e o cardápio do Regem pelo endereço da loja', () => {
    expect(plataformaDoEndereco('https://pedido.anota.ai/loja/mister-burgers', [CARDAPIO])).toEqual({ plataforma: 'anotaai', host: 'pedido.anota.ai' });
    expect(plataformaDoEndereco('https://anota.ai/x', [])).toEqual({ plataforma: 'anotaai', host: 'anota.ai' });
    expect(plataformaDoEndereco('https://mister.cardapioweb.com/', [])).toEqual({ plataforma: 'cardapioweb', host: 'mister.cardapioweb.com' });
    expect(plataformaDoEndereco('https://app.dmsregem.com/c/outra-loja?utm_source=meta', [CARDAPIO])).toEqual({ plataforma: 'regem', host: 'app.dmsregem.com' });
  });

  it('não confunde domínio parecido nem aceita endereço que não é web', () => {
    expect(plataformaDoEndereco('https://anota.ai.golpe.com/x', [])).toBeNull();
    expect(plataformaDoEndereco('https://naoanota.ai/x', [])).toBeNull();
    expect(plataformaDoEndereco('https://cardapioweb.com.br/x', [])).toBeNull();
    expect(plataformaDoEndereco('https://www.ifood.com.br/delivery/x', [CARDAPIO])).toBeNull();
    expect(plataformaDoEndereco('whatsapp://send?phone=1', [])).toBeNull();
    expect(plataformaDoEndereco('não é endereço', [])).toBeNull();
  });

  it('sugere a plataforma da maior parte dos anúncios ativos, contando cada anúncio uma vez', () => {
    const destinos = [
      { adId: 'a1', provider: 'meta_ads', url: 'https://pedido.anota.ai/loja/m' },
      { adId: 'a1', provider: 'meta_ads', url: 'https://pedido.anota.ai/loja/m?x=1' },
      { adId: 'a2', provider: 'meta_ads', url: 'https://pedido.anota.ai/loja/m' },
      { adId: 'a3', provider: 'google_ads', url: CARDAPIO },
      { adId: 'a4', provider: 'meta_ads', url: 'https://www.ifood.com.br/x' },
    ];
    expect(sugerirPlataforma(destinos, [CARDAPIO])).toEqual({ platform: 'anotaai', host: 'pedido.anota.ai', provider: 'meta_ads', ads: 2 });
  });

  it('no empate, a integração vence o cardápio do Regem; sem destino conhecido, não sugere', () => {
    const empate = [
      { adId: 'a1', provider: 'google_ads', url: CARDAPIO },
      { adId: 'a2', provider: 'meta_ads', url: 'https://mister.cardapioweb.com/' },
    ];
    expect(sugerirPlataforma(empate, [CARDAPIO])?.platform).toBe('cardapioweb');
    expect(sugerirPlataforma([{ adId: 'a1', provider: 'meta_ads', url: 'https://www.ifood.com.br/x' }], [CARDAPIO])).toBeNull();
    expect(sugerirPlataforma([], [])).toBeNull();
  });
});

describe('endereço do cardápio de outra plataforma', () => {
  it('aceita só https com domínio, sem usuário e senha', () => {
    expect(enderecoDoCardapio(' https://pedidos.misterburgers.com.br/cardapio ')).toEqual({ ok: true, url: 'https://pedidos.misterburgers.com.br/cardapio' });
    expect(enderecoDoCardapio('http://pedidos.misterburgers.com.br')).toEqual({ ok: false, motivo: 'esquema' });
    expect(enderecoDoCardapio('https://joao:senha@pedidos.misterburgers.com.br')).toEqual({ ok: false, motivo: 'credenciais' });
    expect(enderecoDoCardapio('https://localhost/cardapio')).toEqual({ ok: false, motivo: 'sem_dominio' });
    expect(enderecoDoCardapio('pedidos.misterburgers.com.br')).toEqual({ ok: false, motivo: 'invalido' });
    expect(enderecoDoCardapio(`https://a.com.br/${'x'.repeat(1100)}`)).toEqual({ ok: false, motivo: 'invalido' });
  });
});

describe('período do vínculo', () => {
  it('o dia de hoje é o do fuso da loja', () => {
    // 01/10 02:30 UTC ainda é 30/09 em São Paulo.
    expect(diaNoFuso(new Date('2026-10-01T02:30:00Z'), 'America/Sao_Paulo')).toBe('2026-09-30');
    expect(diaNoFuso(new Date('2026-10-01T03:30:00Z'), 'America/Sao_Paulo')).toBe('2026-10-01');
  });

  it('começa hoje (padrão) ou depois; o fim, inclusive, não vem antes do início', () => {
    expect(periodoDoVinculo('2026-09-30')).toEqual({ ok: true, inicio: '2026-09-30', fim: null });
    expect(periodoDoVinculo('2026-09-30', '2026-10-02', '2026-10-31')).toEqual({ ok: true, inicio: '2026-10-02', fim: '2026-10-31' });
    expect(periodoDoVinculo('2026-09-30', '2026-09-30', '2026-09-30')).toEqual({ ok: true, inicio: '2026-09-30', fim: '2026-09-30' });
    expect(periodoDoVinculo('2026-09-30', '2026-09-29')).toEqual({ ok: false, motivo: 'inicio_no_passado' });
    expect(periodoDoVinculo('2026-09-30', undefined, '2026-09-29')).toEqual({ ok: false, motivo: 'fim_antes_do_inicio' });
    expect(periodoDoVinculo('2026-09-30', '2026-02-30')).toEqual({ ok: false, motivo: 'dia_invalido' });
    expect(periodoDoVinculo('2026-09-30', '2026-10-01', '2026-13-01')).toEqual({ ok: false, motivo: 'dia_invalido' });
  });
});
