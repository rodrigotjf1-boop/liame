import { describe, expect, it } from 'vitest';
import { conjuntoAlcancaOBairro, distanciaKm, efeitoDoBairro, oQueImpedeOBairro, PEDIDOS_POR_SEMANA_MINIMOS } from '../src/campanhas/teste-regiao-contas.js';

// R8, o teste de região (D-RG-81 e D-RG-82), sem rede e sem banco: quando o bairro pode ser testado; se um conjunto da
// Meta mostra anúncio no bairro pelo público dele (na dúvida, alcança); e o que o anúncio traz no bairro, em faixa.

// A Lapa, no Rio: o centro e o círculo de 1,5 km; a Loja Centro fica a uns 1,9 km.
const LAPA = { meta: '2523742', latitude: -22.9133, longitude: -43.1825, raio_km: 1.5 };
const LOJA = { latitude: -22.906847, longitude: -43.172897 };
const circulo = (latitude: number, longitude: number, radius: number, distance_unit = 'kilometer') => ({ latitude, longitude, radius, distance_unit });

describe('quando o bairro pode ser testado (D-RG-82)', () => {
  const bairros = [
    { nome: 'Centro', pedidos: 292 },
    { nome: 'Lapa', pedidos: 120 },
    { nome: 'Glória', pedidos: 60 },
    { nome: 'Santa Teresa', pedidos: 40 },
  ];
  it('pede 15 pedidos por semana no bairro e 3 outros bairros com pedidos', () => {
    expect(PEDIDOS_POR_SEMANA_MINIMOS).toBe(15);
    expect(oQueImpedeOBairro('Lapa', bairros)).toBeNull();
    expect(oQueImpedeOBairro('Santa Teresa', bairros)).toBe('Santa Teresa teve 10 pedidos por semana nas últimas 4 semanas; o teste pede pelo menos 15. Com menos, a conta não diz nada.');
    expect(oQueImpedeOBairro('Glória', [{ nome: 'Glória', pedidos: 61 }, ...bairros.slice(1, 2)])).toContain('Há 1 outro bairro com pedidos para comparar');
    expect(oQueImpedeOBairro('Saúde', bairros)).toBe('Saúde não aparece nos pedidos de entrega da loja nas últimas 4 semanas: o teste precisa dos pedidos do bairro para comparar.');
    // O bairro sem pedido não conta como bairro para comparar.
    expect(oQueImpedeOBairro('Lapa', [...bairros.slice(0, 2), { nome: 'Glória', pedidos: 0 }, { nome: 'Saúde', pedidos: 0 }])).toContain('Há 1 outro bairro');
    expect(oQueImpedeOBairro('Lapa', [{ nome: 'Lapa', pedidos: 50 }, ...bairros.slice(2)])).toContain('12,5 pedidos por semana');
  });
});

describe('o conjunto mostra anúncio no bairro? (na dúvida, alcança)', () => {
  it('a distância entre dois pontos', () => {
    expect(distanciaKm(LOJA, LAPA)).toBeGreaterThan(1.1);
    expect(distanciaKm(LOJA, LAPA)).toBeLessThan(1.3);
    expect(distanciaKm(LOJA, LOJA)).toBe(0);
  });

  it('o círculo em volta da loja que encosta no bairro alcança; o pequeno e o longe, não', () => {
    expect(conjuntoAlcancaOBairro({ geo_locations: { custom_locations: [circulo(LOJA.latitude, LOJA.longitude, 3)] } }, LAPA)).toEqual({ alcanca: true, porque: 'um círculo do público encosta no bairro' });
    expect(conjuntoAlcancaOBairro({ geo_locations: { custom_locations: [circulo(-23.0, -43.4, 2)] } }, LAPA).alcanca).toBe(false);
    // Em milhas (o padrão da Meta quando a unidade não vem).
    expect(conjuntoAlcancaOBairro({ geo_locations: { custom_locations: [{ latitude: -23.0, longitude: -43.4, radius: 15 }] } }, LAPA).alcanca).toBe(true);
  });

  it('os bairros da Meta pela chave; sem a chave do bairro, um público por bairros conta como alcança', () => {
    expect(conjuntoAlcancaOBairro({ geo_locations: { neighborhoods: [{ key: '2523742', name: 'Lapa' }] } }, LAPA).alcanca).toBe(true);
    expect(conjuntoAlcancaOBairro({ geo_locations: { neighborhoods: [{ key: '999', name: 'Leblon' }] } }, LAPA)).toEqual({ alcanca: false, porque: 'os lugares do público ficam longe do bairro' });
    expect(conjuntoAlcancaOBairro({ geo_locations: { neighborhoods: [{ key: '999' }] } }, { ...LAPA, meta: null }).alcanca).toBe(true);
  });

  it('cidade, estado, país e outros lugares contam como alcança; o tipo de local não muda nada', () => {
    for (const geo of [{ cities: [{ key: '268442' }] }, { regions: [{ key: '460' }] }, { countries: ['BR'] }, { zips: [{ key: 'BR:20040' }] }, { places: [{ key: 'x' }] }]) {
      expect(conjuntoAlcancaOBairro({ geo_locations: geo }, LAPA).alcanca).toBe(true);
    }
    expect(conjuntoAlcancaOBairro({ geo_locations: { custom_locations: [circulo(-23.0, -43.4, 2)], location_types: ['home', 'recent'] } }, LAPA).alcanca).toBe(false);
    // Lista vazia de cidades não é lugar.
    expect(conjuntoAlcancaOBairro({ geo_locations: { cities: [], custom_locations: [circulo(-23.0, -43.4, 2)] } }, LAPA).alcanca).toBe(false);
  });

  it('o bairro nos lugares de fora (pela chave ou dentro de um círculo de fora) não é alcançado', () => {
    const emVolta = { custom_locations: [circulo(LOJA.latitude, LOJA.longitude, 5)] };
    expect(conjuntoAlcancaOBairro({ geo_locations: emVolta, excluded_geo_locations: { neighborhoods: [{ key: '2523742' }] } }, LAPA)).toEqual({ alcanca: false, porque: 'o bairro está nos lugares de fora' });
    expect(conjuntoAlcancaOBairro({ geo_locations: emVolta, excluded_geo_locations: { custom_locations: [circulo(LAPA.latitude, LAPA.longitude, 2)] } }, LAPA).alcanca).toBe(false);
    // O círculo de fora que só encosta não tira o bairro inteiro.
    expect(conjuntoAlcancaOBairro({ geo_locations: emVolta, excluded_geo_locations: { custom_locations: [circulo(LAPA.latitude, LAPA.longitude, 1)] } }, LAPA).alcanca).toBe(true);
  });

  it('o que não pode ser lido conta como alcança', () => {
    for (const t of [null, {}, { geo_locations: null }, { geo_locations: {} }, { geo_locations: { custom_locations: 'x' } }, { geo_locations: { custom_locations: [{ latitude: 'a', longitude: 1, radius: 1 }] } }, { geo_locations: { custom_locations: [circulo(-23, -43.4, 2, 'parsec')] } }]) {
      expect(conjuntoAlcancaOBairro(t, LAPA).alcanca, JSON.stringify(t)).toBe(true);
    }
  });
});

describe('o que o anúncio traz no bairro, em faixa de 95%', () => {
  it('o exemplo do protótipo: 30 pedidos por semana antes e 21 sem anúncio dão de 0 a 17 por semana, sem prova', () => {
    // 4 semanas antes (Lapa 30/semana; os outros 107/semana) e as 2 do teste (Lapa 21/semana; os outros 110/semana).
    const e = efeitoDoBairro({ alvoAntes: 120, outrosAntes: 428, alvoDurante: 42, outrosDurante: 220 })!;
    expect(e.esperadoPorSemana).toBeCloseTo(30.84, 1);
    expect(e.feitoPorSemana).toBe(21);
    expect(e.trazPorSemana).toBeCloseTo(9.84, 1);
    expect(e.faixa.de).toBe(0);
    expect(Math.round(e.faixa.ate)).toBe(17);
    expect(e.provou).toBe(false);
  });

  it('com quatro vezes os pedidos, a mesma queda passa a provar, e a faixa fica mais estreita em proporção', () => {
    const e = efeitoDoBairro({ alvoAntes: 480, outrosAntes: 1712, alvoDurante: 168, outrosDurante: 880 })!;
    expect(e.trazPorSemana).toBeCloseTo(39.36, 1);
    expect(e.faixa.de).toBeGreaterThan(20);
    expect(e.faixa.ate).toBeLessThan(55);
    expect(e.provou).toBe(true);
  });

  it('o bairro que vendeu mais sem anúncio: o anúncio não traz nada que se veja; sem uma das contagens, não há conta', () => {
    const e = efeitoDoBairro({ alvoAntes: 120, outrosAntes: 428, alvoDurante: 70, outrosDurante: 220 })!;
    expect([e.trazPorSemana, e.faixa.de, e.provou]).toEqual([0, 0, false]);
    expect(efeitoDoBairro({ alvoAntes: 120, outrosAntes: 428, alvoDurante: 0, outrosDurante: 220 })).toBeNull();
    expect(efeitoDoBairro({ alvoAntes: 0, outrosAntes: 428, alvoDurante: 10, outrosDurante: 220 })).toBeNull();
  });
});
