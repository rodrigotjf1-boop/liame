import { describe, expect, it } from 'vitest';
import { frescor } from '../src/media/frescor.js';

describe('frescor de cada fonte', () => {
  const agora = new Date('2026-09-26T12:00:00Z');
  const ha = (min: number) => new Date(agora.getTime() - min * 60_000);

  it('dentro do intervalo esperado (com folga de 50%) é fresco; até 3 intervalos, atrasado; além, velho', () => {
    expect(frescor({ lastSuccessAt: ha(60), expectedEveryMinutes: 60 }, agora)).toBe('fresh');
    expect(frescor({ lastSuccessAt: ha(90), expectedEveryMinutes: 60 }, agora)).toBe('fresh');
    expect(frescor({ lastSuccessAt: ha(150), expectedEveryMinutes: 60 }, agora)).toBe('delayed');
    expect(frescor({ lastSuccessAt: ha(181), expectedEveryMinutes: 60 }, agora)).toBe('stale');
  });

  it('nunca sincronizou: desconhecido', () => {
    expect(frescor({ lastSuccessAt: null, expectedEveryMinutes: 60 }, agora)).toBe('unknown');
  });
});
