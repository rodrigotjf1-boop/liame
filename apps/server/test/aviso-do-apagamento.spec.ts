import { describe, expect, it } from 'vitest';
import { AVISOS_DO_APAGAMENTO, apagamentoPeloAtraso, avisoDoApagamento, emailDoAvisoDoApagamento } from '../src/cobranca/aviso-do-apagamento.js';

// A7 · W3, parte 4b (D-A7-106 e D-A7-107; Termos 11.2), sem banco: em que dias o aviso do apagamento vai, o dia projetado
// da assinatura em atraso e o texto de cada e-mail (a assinatura que terminou e a que segue em atraso; só a marca e a
// empresa inteira; 7 dias antes e a véspera).

const base = { marca: 'Casa Brasa', apagaEm: '2026-12-21', link: 'https://app.exemplo/cobranca?marca=1' } as const;

describe('o aviso do apagamento (A7 · W3, parte 4b)', () => {
  it('os dias: o de 7 vai de 7 a 2 dias antes; a véspera com 1; no dia, antes de 7 e depois, nenhum', () => {
    expect(AVISOS_DO_APAGAMENTO).toEqual([7, 1]);
    expect([10, 8, 7, 6, 2, 1, 0, -1].map(avisoDoApagamento)).toEqual([null, null, 7, 7, 7, 1, null, null]);
  });

  it('o dia da assinatura em atraso: o 60º dia de atraso da mensalidade mais antiga (o mesmo dia em que ela termina)', () => {
    expect(apagamentoPeloAtraso('2026-10-10')).toBe('2026-12-09');
    expect(apagamentoPeloAtraso('2026-12-31')).toBe('2027-03-01');
  });

  it('o e-mail da assinatura que terminou: o dia, só a marca, que não tem volta, exportar e assinar de novo', () => {
    const e = emailDoAvisoDoApagamento({ ...base, aviso: 7, alcance: 'marca', motivo: 'terminou' });
    expect(e.subject).toBe('Liame: os dados de Casa Brasa serão apagados em 21/12/2026');
    expect(e.text).toContain('A assinatura da marca Casa Brasa terminou. Pelos Termos (11.2), os dados ficam guardados por 30 dias depois do fim');
    expect(e.text).toContain('Em 21/12/2026, o Liame apaga todos os dados da marca Casa Brasa no Liame. As outras marcas da empresa continuam como estão. Apagar não tem volta.');
    expect(e.text).toContain(`"Exportar os dados" em Plano e cobrança: ${base.link}`);
    expect(e.text).toContain('assine de novo na mesma tela');
    expect(e.text).not.toContain('certificado');
  });

  it('a véspera e a empresa inteira: "amanhã", a conta da empresa e o certificado ao Dono', () => {
    const e = emailDoAvisoDoApagamento({ ...base, aviso: 1, alcance: 'empresa', motivo: 'terminou' });
    expect(e.subject).toBe('Liame: amanhã, os dados de Casa Brasa são apagados');
    expect(e.text).toContain('Amanhã, 21/12/2026, o Liame apaga a conta da empresa inteira, com todos os dados, porque Casa Brasa é a última marca dela com assinatura.');
    expect(e.text).toContain('certificado da exclusão');
  });

  it('a assinatura em atraso: o 60º dia, e o que evita é pagar o que está em aberto', () => {
    const e = emailDoAvisoDoApagamento({ ...base, aviso: 7, alcance: 'marca', motivo: 'atraso' });
    expect(e.text).toContain('A mensalidade da marca Casa Brasa está em aberto há quase 60 dias, e a conta segue suspensa.');
    expect(e.text).toContain('pague a mensalidade em aberto na mesma tela');
    expect(e.text).not.toContain('assine de novo');
  });
});
