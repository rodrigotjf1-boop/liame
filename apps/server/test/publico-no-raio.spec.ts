import { describe, expect, it } from 'vitest';
import { PUBLICO_MINIMO_NO_RAIO } from '../src/campanhas/campanha-nova-plano.js';
import { textoDoPublicoPequeno } from '../src/campanhas/campanhas-novas.service.js';
import { alvoDoRaio, PublicoNoRaio, publicoDaEstimativa, publicoSuficiente } from '../src/campanhas/publico-no-raio.js';

// R6, parte 2 (D-RG-50): a estimativa de público da Meta no raio da loja. O que se prova: o alvo é o mesmo raio e a
// mesma idade do conjunto, sem a ampliação da Meta; a resposta vale como objeto ou lista; -1 e o que vem fora do formato
// são "sem estimativa" (não público vazio); a régua é o máximo da faixa a partir de 1.000 pessoas.

describe('a estimativa de público no raio (R6, parte 2)', () => {
  it('o alvo: o raio em km em volta do ponto, 18 anos ou mais, sem a ampliação do público', () => {
    expect(alvoDoRaio(-22.906847, -43.172897, 2.5)).toEqual({
      geo_locations: { custom_locations: [{ latitude: -22.906847, longitude: -43.172897, radius: 2.5, distance_unit: 'kilometer' }] },
      age_min: 18,
      targeting_automation: { advantage_audience: 0 },
    });
  });

  it('a resposta: objeto ou lista de um; número ou texto; -1, faixa invertida ou fora do formato é sem estimativa', () => {
    expect(publicoDaEstimativa({ data: { users_lower_bound: 182000, users_upper_bound: 214000, estimate_ready: true } })).toEqual({ de: 182000, ate: 214000 });
    expect(publicoDaEstimativa({ data: [{ users_lower_bound: '640', users_upper_bound: '760' }] })).toEqual({ de: 640, ate: 760 });
    expect(publicoDaEstimativa({ data: { users_lower_bound: -1, users_upper_bound: -1 } })).toBeNull();
    expect(publicoDaEstimativa({ data: { users_lower_bound: 900, users_upper_bound: 800 } })).toBeNull();
    expect(publicoDaEstimativa({ data: { users_lower_bound: 1.5, users_upper_bound: 3 } })).toBeNull();
    expect(publicoDaEstimativa({ data: [] })).toBeNull();
    expect(publicoDaEstimativa({})).toBeNull();
    expect(publicoDaEstimativa(null)).toBeNull();
  });

  it('a régua: o máximo da faixa a partir de 1.000 pessoas', () => {
    expect(PUBLICO_MINIMO_NO_RAIO).toBe(1000);
    expect(publicoSuficiente({ de: 640, ate: 760 })).toBe(false);
    expect(publicoSuficiente({ de: 850, ate: 999 })).toBe(false);
    expect(publicoSuficiente({ de: 850, ate: 1000 })).toBe(true);
  });

  it('o porquê do público pequeno: a faixa, o raio escrito e a loja, com o que fazer', () => {
    expect(textoDoPublicoPequeno({ de: 640, ate: 760 }, 2.5, 'Loja Centro')).toBe(
      'A Meta estima de 640 a 760 pessoas de 18 anos ou mais num raio de 2,5 km em volta da Loja Centro: com menos de 1.000 pessoas, ela não entrega bem. Aumente o raio.',
    );
  });

  it('sem ligar (o app não subiu a escrita da Meta), não há estimativa', async () => {
    await expect(new PublicoNoRaio().estimar({} as never, { externalId: '1', segredo: null }, { latitude: 0, longitude: 0, raioKm: 3 })).resolves.toBeNull();
  });
});
