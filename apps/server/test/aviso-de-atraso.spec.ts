import { describe, expect, it } from 'vitest';
import { avisoDoDia, DIAS_DO_AVISO, emailDoAviso } from '../src/cobranca/aviso-de-atraso.js';

// A7 · W3, parte 2 (D-A7-15, D-A7-39; Termos 10.4): em que dia de atraso cada aviso vai e o texto de cada um, sem banco.

const BASE = { marca: 'Casa Brasa', vencimento: '2026-11-22', valorCents: '24900', link: 'https://app.agencialiame.com/cobranca?marca=m1' };

describe('o aviso do atraso por e-mail (A7 · W3, parte 2)', () => {
  it('vai no 1º, no 7º, no 10º e no 30º dia; o do maior dia já alcançado vale (o que passou com a rotina parada não vai mais)', () => {
    expect([...DIAS_DO_AVISO]).toEqual([1, 7, 10, 30]);
    expect([0, 1, 6, 7, 8, 9, 10, 29, 30, 45].map(avisoDoDia)).toEqual([null, 1, 1, 7, 7, 7, 10, 10, 30, 30]);
    expect(avisoDoDia(-3)).toBeNull();
  });

  it('o texto de cada dia: o que aconteceu, as datas do que vem, onde pagar; o valor com o espaço comum (e-mail, V63)', () => {
    const um = emailDoAviso({ ...BASE, aviso: 1 });
    expect(um.subject).toBe('Liame: a mensalidade de Casa Brasa venceu em 22/11');
    expect(um.text).toContain('Ainda não recebemos a mensalidade de novembro da marca Casa Brasa (R$ 249,00), que venceu em 22/11.');
    expect(um.text).toContain('Pague até 01/12 para os funcionários de IA continuarem trabalhando. Em 02/12, eles param; em 22/12, a conta é suspensa');
    expect(um.text).toContain('Para pagar, abra Plano e cobrança no Liame: https://app.agencialiame.com/cobranca?marca=m1');
    expect(um.text).toContain('a confirmação do PIX leva alguns minutos');
    expect(um.text).not.toContain(String.fromCharCode(160));

    expect(emailDoAviso({ ...BASE, aviso: 7 }).subject).toBe('Liame: faltam 3 dias para os funcionários de IA de Casa Brasa pararem');

    const dez = emailDoAviso({ ...BASE, aviso: 10 });
    expect(dez.subject).toBe('Liame: os funcionários de IA de Casa Brasa estão parados');
    expect(dez.text).toContain('Desde 02/12, os funcionários de IA de Casa Brasa não fazem nada novo, por causa da mensalidade de novembro');
    expect(dez.text).toContain('os anúncios seguem como estão: o Liame não pausa nenhum');
    expect(dez.text).toContain('Em 22/12, a conta é suspensa, e só o Dono entra, para pagar ou exportar os dados. Pagou, tudo volta na hora.');
    expect(dez.text).not.toContain('desconsiderar');

    const trinta = emailDoAviso({ ...BASE, aviso: 30 });
    expect(trinta.subject).toBe('Liame: a conta de Casa Brasa está suspensa');
    expect(trinta.text).toContain('Desde 22/12, só o Dono entra, para pagar ou exportar os dados.');
    expect(trinta.text).toContain('Pagou, tudo volta na hora. A equipe entra de novo, e os funcionários de IA voltam a trabalhar.');

    // Vencida no fim do mês curto: as contas de data atravessam o mês certo.
    expect(emailDoAviso({ ...BASE, vencimento: '2027-01-31', aviso: 1 }).text).toContain('Pague até 09/02 para os funcionários de IA continuarem trabalhando. Em 10/02, eles param; em 02/03');
  });
});
