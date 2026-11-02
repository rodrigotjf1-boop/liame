import { describe, expect, it } from 'vitest';
import { ajustarAoMaximo, conferirTermos, dentroDoMaximo, sobe } from '../src/agencia/vinculo.service.js';

const REAL = 1_000_000;
const termos = (t: Partial<Parameters<typeof sobe>[0]> = {}) => ({
  maxRole: 'gestor' as const,
  limite: 50 * REAL as number | null,
  dupla: true,
  fim: null as string | null,
  ...t,
});

// As regras puras do vínculo de parceiro (A7, W6, parte 2; D-A7-47 e D-A7-49): o que conta como dar mais poder à agência
// (pede o código do app) e a regra do limite, a mesma dos convites.
describe('subir ou baixar o que a agência pode', () => {
  it('o nível acima é subir; o abaixo é baixar', () => {
    expect(sobe(termos(), termos({ maxRole: 'administrador' }))).toBe(true);
    expect(sobe(termos(), termos({ maxRole: 'aprovador' }))).toBe(false);
    expect(sobe(termos(), termos({ maxRole: 'somente_leitura', limite: null }))).toBe(false);
    // Sair de "Somente leitura" para um nível que aprova é subir, mesmo com limite pequeno.
    expect(sobe(termos({ maxRole: 'somente_leitura', limite: null }), termos({ maxRole: 'aprovador', limite: 1 }))).toBe(true);
  });

  it('o limite maior, ou sem limite, é subir; o menor é baixar', () => {
    expect(sobe(termos(), termos({ limite: 60 * REAL }))).toBe(true);
    expect(sobe(termos(), termos({ limite: null }))).toBe(true);
    expect(sobe(termos(), termos({ limite: 40 * REAL }))).toBe(false);
    expect(sobe(termos({ limite: null }), termos({ limite: 40 * REAL }))).toBe(false);
    expect(sobe(termos({ limite: null }), termos({ limite: null }))).toBe(false);
  });

  it('tirar o "eu também aprovo" é subir; pôr de volta é baixar', () => {
    expect(sobe(termos(), termos({ dupla: false }))).toBe(true);
    expect(sobe(termos({ dupla: false }), termos({ dupla: true }))).toBe(false);
  });

  it('dar mais tempo (ou tirar a data de fim) é subir; pôr ou adiantar a data é baixar', () => {
    const daqui30 = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const daqui60 = new Date(Date.now() + 60 * 86_400_000).toISOString();
    expect(sobe(termos({ fim: daqui30 }), termos({ fim: daqui60 }))).toBe(true);
    expect(sobe(termos({ fim: daqui30 }), termos({ fim: null }))).toBe(true);
    expect(sobe(termos(), termos({ fim: daqui30 }))).toBe(false);
    expect(sobe(termos({ fim: daqui60 }), termos({ fim: daqui30 }))).toBe(false);
  });

  it('nada muda: não sobe', () => {
    expect(sobe(termos(), termos())).toBe(false);
  });
});

describe('os termos do vínculo', () => {
  it('o nível que aprova pede o limite informado (nulo é sem limite)', () => {
    expect(() => conferirTermos({ maxRole: 'gestor', limite: undefined, dupla: true, fim: null })).toThrow();
    expect(conferirTermos({ maxRole: 'gestor', limite: null, dupla: false, fim: null })).toEqual({ maxRole: 'gestor', limite: null, dupla: false, fim: null });
  });

  it('o nível que não aprova fica sem limite e com o "eu também aprovo"', () => {
    expect(conferirTermos({ maxRole: 'somente_leitura', limite: 10 * REAL, dupla: false, fim: null })).toEqual({
      maxRole: 'somente_leitura',
      limite: null,
      dupla: true,
      fim: null,
    });
  });
});

// O time da agência no cliente (A7, W6, parte 3; D-A7-48 e D-A7-49).
describe('o time da agência até o máximo do Dono', () => {
  it('baixar o máximo desce quem estava acima e corta o limite acima do novo', () => {
    const maximo = termos({ maxRole: 'aprovador', limite: 10 * REAL });
    expect(ajustarAoMaximo({ role: 'administrador', limite: 50 * REAL, dupla: true }, maximo)).toEqual({ role: 'aprovador', limite: 10 * REAL, dupla: true, mudou: true });
    expect(ajustarAoMaximo({ role: 'aprovador', limite: 5 * REAL, dupla: true }, maximo)).toEqual({ role: 'aprovador', limite: 5 * REAL, dupla: true, mudou: false });
    // Sem limite, com o máximo que tem limite: fica com o do Dono.
    expect(ajustarAoMaximo({ role: 'gestor', limite: null, dupla: true }, maximo)).toEqual({ role: 'aprovador', limite: 10 * REAL, dupla: true, mudou: true });
  });

  it('o máximo que não aprova tira o limite de todos; o "eu também aprovo" do Dono vale para todos', () => {
    expect(ajustarAoMaximo({ role: 'gestor', limite: 20 * REAL, dupla: true }, termos({ maxRole: 'somente_leitura', limite: null }))).toEqual({
      role: 'somente_leitura',
      limite: null,
      dupla: true,
      mudou: true,
    });
    expect(ajustarAoMaximo({ role: 'gestor', limite: 20 * REAL, dupla: false }, termos({ dupla: true }))).toEqual({
      role: 'gestor',
      limite: 20 * REAL,
      dupla: true,
      mudou: true,
    });
  });

  it('o acesso que a agência pede: nunca acima do nível, do limite nem sem o "eu também aprovo" do Dono; sem limite, fica o do Dono', () => {
    const maximo = termos();
    expect(() => dentroDoMaximo({ role: 'administrador' }, maximo, 'Caio')).toThrow(
      expect.objectContaining({ code: 'acima-do-maximo', detail: expect.stringContaining('o máximo da agência neste cliente é Gestor') }),
    );
    expect(() => dentroDoMaximo({ role: 'gestor', approve_limit_micros: 60 * REAL }, maximo, 'Caio')).toThrow();
    expect(() => dentroDoMaximo({ role: 'gestor', approve_limit_micros: null }, maximo, 'Caio')).toThrow();
    expect(() => dentroDoMaximo({ role: 'gestor', dual_approval: false }, maximo, 'Caio')).toThrow();
    expect(dentroDoMaximo({ role: 'gestor' }, maximo, 'Caio')).toEqual({ role: 'gestor', limite: 50 * REAL, dupla: true });
    expect(dentroDoMaximo({ role: 'somente_leitura', approve_limit_micros: 5 * REAL }, maximo, 'Caio')).toEqual({ role: 'somente_leitura', limite: null, dupla: true });
    // O Dono sem limite e sem o "eu também aprovo": a agência pode dar sem limite e dispensar.
    expect(dentroDoMaximo({ role: 'gestor', approve_limit_micros: null, dual_approval: false }, termos({ limite: null, dupla: false }), 'Caio')).toEqual({
      role: 'gestor',
      limite: null,
      dupla: false,
    });
  });
});
