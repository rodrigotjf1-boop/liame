import { describe, expect, it } from 'vitest';
import {
  bairroNaBuscaDaMeta,
  bairrosEscritos,
  deslocamentoEmKm,
  lugaresDoRaio,
  lugaresDosBairros,
  MAXIMO_DE_BAIRROS,
  raioDoBairro,
} from '../src/campanhas/bairros-da-campanha.js';
import { textoDoPublicoPequenoNosBairros } from '../src/campanhas/campanhas-novas.service.js';
import { alvoDosLugares } from '../src/campanhas/publico-no-raio.js';

// R6, parte 3 (D-RG-53 a D-RG-56), sem rede e sem banco: o círculo de cada bairro pelo tamanho dele no IBGE, o centro a
// partir da loja para a prévia em escala, o bairro da Meta só com o mesmo nome na mesma cidade, os lugares que vão para a
// Meta (os bairros dela pela chave e os círculos dos outros) e a frase do público pequeno nos bairros.

describe('os bairros da campanha nova (R6, parte 3)', () => {
  it('o círculo: o raio de um círculo da mesma área, para cima de meio em meio km, de 1 a 3 km; sem a área, 1 km', () => {
    expect(raioDoBairro(null)).toBe(1);
    expect(raioDoBairro(0)).toBe(1);
    expect(raioDoBairro(1)).toBe(1); // 0,56 km
    expect(raioDoBairro(4.5)).toBe(1.5); // 1,20 km
    expect(raioDoBairro(7.41)).toBe(2); // 1,54 km (a média dos bairros do Rio no IBGE)
    expect(raioDoBairro(30)).toBe(3); // 3,09 km, no teto
    expect(MAXIMO_DE_BAIRROS).toBe(20);
  });

  it('o centro a partir da loja, em km para leste e para norte', () => {
    const loja = { latitude: -22.906847, longitude: -43.172897 };
    expect(deslocamentoEmKm(loja, loja)).toEqual({ x: 0, y: 0 });
    const d = deslocamentoEmKm(loja, { latitude: -22.915, longitude: -43.18 });
    expect(d.y).toBeCloseTo(-0.9, 1);
    expect(d.x).toBeCloseTo(-0.73, 1);
  });

  it('o bairro da Meta: só o tipo bairro, com o mesmo nome e a mesma cidade (sem acento e sem maiúscula); sem certeza, nulo', () => {
    const resposta = {
      data: [
        { key: '111', name: 'Lapa', type: 'neighborhood', primary_city: 'São Paulo', region: 'São Paulo' },
        { key: '222', name: 'Lapa', type: 'city', primary_city: 'Rio de Janeiro' },
        { key: '333', name: 'LAPA', type: 'neighborhood', primary_city: 'rio de janeiro', region: 'Rio de Janeiro' },
      ],
    };
    expect(bairroNaBuscaDaMeta(resposta, 'Lapa', 'Rio de Janeiro')).toBe('333');
    expect(bairroNaBuscaDaMeta(resposta, 'Glória', 'Rio de Janeiro')).toBeNull();
    // Sem a cidade na resposta, não dá para saber de qual "Centro" é: vai o círculo.
    expect(bairroNaBuscaDaMeta({ data: [{ key: '9', name: 'Centro', type: 'neighborhood', region: 'Rio de Janeiro' }] }, 'Centro', 'Rio de Janeiro')).toBeNull();
    expect(bairroNaBuscaDaMeta({ data: [{ key: '', name: 'Centro', type: 'neighborhood', primary_city: 'Rio de Janeiro' }] }, 'Centro', 'Rio de Janeiro')).toBeNull();
    expect(bairroNaBuscaDaMeta({ data: [{ key: '9', name: 'x'.repeat(201), type: 'neighborhood', primary_city: 'Rio de Janeiro' }] }, 'x'.repeat(201), 'Rio de Janeiro')).toBeNull();
    expect(bairroNaBuscaDaMeta({}, 'Centro', 'Rio de Janeiro')).toBeNull();
    expect(bairroNaBuscaDaMeta(null, 'Centro', 'Rio de Janeiro')).toBeNull();
  });

  it('os lugares na Meta: os bairros dela pela chave e um círculo em km no centro de cada um dos outros; o raio em volta da loja', () => {
    const centro = { codigo: '3304557001', nome: 'Centro', meta: '333', latitude: -22.9, longitude: -43.17, raio_km: 2 };
    const gloria = { codigo: '3304557002', nome: 'Glória', meta: null, latitude: -22.92, longitude: -43.175, raio_km: 1 };
    expect(lugaresDosBairros([centro, gloria])).toEqual({
      custom_locations: [{ latitude: -22.92, longitude: -43.175, radius: 1, distance_unit: 'kilometer' }],
      neighborhoods: [{ key: '333' }],
    });
    expect(lugaresDosBairros([gloria])).toEqual({ custom_locations: [{ latitude: -22.92, longitude: -43.175, radius: 1, distance_unit: 'kilometer' }] });
    expect(lugaresDosBairros([centro])).toEqual({ neighborhoods: [{ key: '333' }] });
    expect(lugaresDoRaio(-22.9, -43.17, 5)).toEqual({ custom_locations: [{ latitude: -22.9, longitude: -43.17, radius: 5, distance_unit: 'kilometer' }] });
    // A estimativa pergunta pelos mesmos lugares, 18 anos ou mais, sem a ampliação.
    expect(alvoDosLugares(lugaresDosBairros([gloria]))).toEqual({
      geo_locations: { custom_locations: [{ latitude: -22.92, longitude: -43.175, radius: 1, distance_unit: 'kilometer' }] },
      age_min: 18,
      targeting_automation: { advantage_audience: 0 },
    });
  });

  it('as palavras: os bairros e o público pequeno nos bairros, com o que fazer', () => {
    expect(bairrosEscritos(1)).toBe('1 bairro');
    expect(bairrosEscritos(3)).toBe('3 bairros');
    expect(textoDoPublicoPequenoNosBairros({ de: 300, ate: 400 }, 1)).toBe(
      'A Meta estima de 300 a 400 pessoas de 18 anos ou mais no bairro escolhido: com menos de 1.000 pessoas, ela não entrega bem. Escolha mais bairros.',
    );
    expect(textoDoPublicoPequenoNosBairros({ de: 640, ate: 760 }, 2)).toContain('nos 2 bairros escolhidos');
  });
});
