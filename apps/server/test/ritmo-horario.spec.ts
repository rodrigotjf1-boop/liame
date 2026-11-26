import { describe, expect, it } from 'vitest';
import { pausadaSemLigar } from '../src/campanhas/ritmo-avisos.js';
import { momentoDoHorario, situacaoDeixada } from '../src/campanhas/ritmo-horario.js';

// R7, parte 2b (D-RG-61 e D-RG-104), sem rede e sem banco: o que a janela pede em cada momento da semana (ligada dentro,
// pausada fora, o "pausar" da véspera antes da primeira janela, nada antes da semana e depois da última janela), a janela
// que passa da meia-noite, a situação em que o Liame deixou o objeto pelos passos feitos e a campanha pausada pelo
// horário que o Liame não conseguiu ligar de novo.

const SEMANA = { de: '2026-11-30', ate: '2026-12-06' };
const NOITE = { de: '17:00', ate: '22:00' };
const PASSA = { de: '21:00', ate: '01:00' };
const em = (dia: string, hora: string) => ({ dia, hora });

describe('o horário do ritmo da semana (R7, parte 2b)', () => {
  it('a janela da noite: ligada dentro, pausada fora; o pausar da véspera antes da primeira; nada fora da semana', () => {
    // Antes da semana, o horário não vale.
    expect(momentoDoHorario(em('2026-11-29', '23:59'), SEMANA, NOITE)).toBeNull();
    // Na segunda antes da janela: pausada, pelo pausar da véspera da semana (a campanha vinha ligada o dia todo).
    expect(momentoDoHorario(em('2026-11-30', '00:00'), SEMANA, NOITE)).toEqual({ status: 'pausado', tipo: 'pausar', dia: '2026-11-29' });
    expect(momentoDoHorario(em('2026-11-30', '16:59'), SEMANA, NOITE)).toEqual({ status: 'pausado', tipo: 'pausar', dia: '2026-11-29' });
    // Dentro da janela (o começo conta, o fim não): o ligar do dia.
    expect(momentoDoHorario(em('2026-11-30', '17:00'), SEMANA, NOITE)).toEqual({ status: 'ativo', tipo: 'ligar', dia: '2026-11-30' });
    expect(momentoDoHorario(em('2026-11-30', '21:59'), SEMANA, NOITE)).toEqual({ status: 'ativo', tipo: 'ligar', dia: '2026-11-30' });
    // Depois dela, até a janela do dia seguinte: o pausar do dia.
    expect(momentoDoHorario(em('2026-11-30', '22:00'), SEMANA, NOITE)).toEqual({ status: 'pausado', tipo: 'pausar', dia: '2026-11-30' });
    expect(momentoDoHorario(em('2026-12-01', '10:00'), SEMANA, NOITE)).toEqual({ status: 'pausado', tipo: 'pausar', dia: '2026-11-30' });
    expect(momentoDoHorario(em('2026-12-06', '18:00'), SEMANA, NOITE)).toEqual({ status: 'ativo', tipo: 'ligar', dia: '2026-12-06' });
    // Depois da última janela da semana, o horário acabou: a campanha fica ligada o dia todo (o soltar).
    expect(momentoDoHorario(em('2026-12-06', '22:00'), SEMANA, NOITE)).toBeNull();
    expect(momentoDoHorario(em('2026-12-07', '18:00'), SEMANA, NOITE)).toBeNull();
  });

  it('a janela que passa da meia-noite termina no dia seguinte, e o passo é do dia em que ela começou', () => {
    expect(momentoDoHorario(em('2026-11-30', '20:59'), SEMANA, PASSA)).toEqual({ status: 'pausado', tipo: 'pausar', dia: '2026-11-29' });
    expect(momentoDoHorario(em('2026-11-30', '23:30'), SEMANA, PASSA)).toEqual({ status: 'ativo', tipo: 'ligar', dia: '2026-11-30' });
    expect(momentoDoHorario(em('2026-12-01', '00:30'), SEMANA, PASSA)).toEqual({ status: 'ativo', tipo: 'ligar', dia: '2026-11-30' });
    expect(momentoDoHorario(em('2026-12-01', '01:00'), SEMANA, PASSA)).toEqual({ status: 'pausado', tipo: 'pausar', dia: '2026-11-30' });
    // A janela do domingo vai até a 01:00 da segunda seguinte; depois dela, acabou.
    expect(momentoDoHorario(em('2026-12-07', '00:59'), SEMANA, PASSA)).toEqual({ status: 'ativo', tipo: 'ligar', dia: '2026-12-06' });
    expect(momentoDoHorario(em('2026-12-07', '01:00'), SEMANA, PASSA)).toBeNull();
  });

  it('a situação em que o Liame deixou o objeto: pelo último passo de situação feito; os da verba não contam', () => {
    expect(situacaoDeixada([])).toBe('ativo');
    expect(situacaoDeixada([{ kind: 'ritmo' }, { kind: 'volta' }])).toBe('ativo');
    expect(situacaoDeixada([{ kind: 'pausar' }])).toBe('pausado');
    expect(situacaoDeixada([{ kind: 'pausar' }, { kind: 'ritmo' }])).toBe('pausado');
    expect(situacaoDeixada([{ kind: 'pausar' }, { kind: 'ligar' }])).toBe('ativo');
    expect(situacaoDeixada([{ kind: 'pausar' }, { kind: 'soltar' }])).toBe('ativo');
  });

  it('pausada sem ligar de novo: depois do último pausar feito, um ligar ou soltar bloqueado (e nenhum feito)', () => {
    const p = (tipo: 'ligar' | 'pausar' | 'soltar', situacao: string, dia = '2026-12-01') => ({ dia, tipo, situacao });
    expect(pausadaSemLigar([])).toBeNull();
    expect(pausadaSemLigar([p('pausar', 'feito')])).toBeNull();
    expect(pausadaSemLigar([p('pausar', 'feito'), p('soltar', 'bloqueado', '2026-12-02')])).toBe('2026-12-02');
    expect(pausadaSemLigar([p('pausar', 'feito'), p('ligar', 'bloqueado', '2026-12-02'), p('soltar', 'bloqueado', '2026-12-03')])).toBe('2026-12-03');
    // Ligou depois: não está mais pausada pelo Liame.
    expect(pausadaSemLigar([p('pausar', 'feito'), p('soltar', 'bloqueado'), p('ligar', 'feito')])).toBeNull();
    // O ligar que ainda está na fila não é falha.
    expect(pausadaSemLigar([p('pausar', 'feito'), p('ligar', 'pedido')])).toBeNull();
  });
});
