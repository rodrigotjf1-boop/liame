import { describe, expect, it } from 'vitest';
import { diaEmBrasilia, enderecosVigentes, escolher, type LinhaDaVersao, paraContrato } from '../src/auth/termos/versoes.js';

// As regras puras dos Termos novos (A7, W14, parte 14a; D-A7-99): o dia em Brasília, o que vale, o que vem e o que pede o
// aceite, e o endereço de cada documento quando um ajuste de redação muda só um deles.

const linha = (version: string, kind: 'relevante' | 'redacao', effective: string, o: Partial<LinhaDaVersao> = {}): LinhaDaVersao => ({
  version,
  kind,
  notice_at: '2026-10-01T15:00:00Z',
  effective_at: effective,
  documents: [{ document: 'termos', url: `https://agencialiame.com/termos/${version}`, sha256: 'a'.repeat(64) }],
  changes: [],
  reason: kind === 'redacao' ? 'Um link.' : null,
  withdrawn_at: null,
  ...o,
});

describe('os Termos novos: as regras', () => {
  it('o dia é o de Brasília: 01h de 03/12 em UTC ainda é 02/12 lá', () => {
    expect(diaEmBrasilia(new Date('2026-12-03T01:00:00Z'))).toBe('2026-12-02');
    expect(diaEmBrasilia('2026-12-02T03:00:00Z')).toBe('2026-12-02');
  });

  it('vigente é a mais nova que já vale (de qualquer tipo); a que vem é a relevante futura mais próxima; a retirada não conta', () => {
    const agora = new Date('2026-11-10T12:00:00Z');
    const linhas = [
      linha('2026-10-15', 'relevante', '2026-10-15T03:00:00Z'),
      linha('2026-11-01-a', 'redacao', '2026-11-01T15:00:00Z'),
      linha('2026-12-02', 'relevante', '2026-12-02T03:00:00Z'),
      linha('2026-12-20', 'relevante', '2026-12-20T03:00:00Z', { withdrawn_at: '2026-11-05T12:00:00Z' }),
    ];
    const r = escolher(linhas, agora);
    expect(r.vigente?.version).toBe('2026-11-01-a');
    expect(r.relevanteVigente?.version).toBe('2026-10-15');
    expect(r.aVir?.version).toBe('2026-12-02');
    expect(escolher([], agora)).toEqual({ vigente: null, relevanteVigente: null, aVir: null });
  });

  it('o endereço de cada documento é o da versão mais nova em vigor que o muda; sem nenhuma, o do ambiente', () => {
    const agora = new Date('2026-11-10T12:00:00Z');
    const base = { termos: 'https://agencialiame.com/termos', privacidade: 'https://agencialiame.com/privacidade' };
    const soPolitica = linha('2026-11-01-a', 'redacao', '2026-11-01T15:00:00Z', {
      documents: [{ document: 'privacidade', url: 'https://agencialiame.com/privacidade/2026-11-01-a', sha256: 'b'.repeat(64) }],
    });
    expect(enderecosVigentes([linha('2026-10-15', 'relevante', '2026-10-15T03:00:00Z'), soPolitica], agora, base)).toEqual({
      termos: 'https://agencialiame.com/termos/2026-10-15',
      privacidade: 'https://agencialiame.com/privacidade/2026-11-01-a',
    });
    expect(enderecosVigentes([], agora, base)).toEqual(base);
  });

  it('o contrato diz o dia em que vale em Brasília e se foi retirada, sem a impressão digital', () => {
    const c = paraContrato(linha('2026-12-02', 'relevante', '2026-12-02T03:00:00Z', { withdrawn_at: '2026-11-20T12:00:00Z' }));
    expect(c).toMatchObject({ version: '2026-12-02', effective_on: '2026-12-02', withdrawn: true, notice_at: '2026-10-01T15:00:00.000Z' });
    expect(c.documents).toEqual([{ document: 'termos', url: 'https://agencialiame.com/termos/2026-12-02' }]);
  });
});
