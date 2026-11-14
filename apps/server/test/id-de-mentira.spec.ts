import { describe, expect, it } from 'vitest';
import { idNumericoDeMentira } from './helpers/id-de-mentira.js';

// Os ids de mentira das redes (V156; ERR-236): criados em seguida, no mesmo milissegundo, nunca saem iguais. Antes, os
// últimos algarismos eram sorteados a cada id, e duas publicações criadas uma atrás da outra repetiam o id de vez em
// quando: a leitura via três onde o teste tinha criado quatro, e o CI reprovava sem motivo aparente.

describe('os ids de mentira das redes (ERR-236)', () => {
  it('milhares de ids criados em seguida são todos diferentes, com 17 algarismos', () => {
    const ids = Array.from({ length: 5_000 }, () => idNumericoDeMentira());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^\d{17}$/.test(id))).toBe(true);
  });

  it('a Página tem 15 algarismos: os criados em seguida também não se repetem', () => {
    const ids = Array.from({ length: 50 }, () => idNumericoDeMentira(15));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^\d{15}$/.test(id))).toBe(true);
  });
});
