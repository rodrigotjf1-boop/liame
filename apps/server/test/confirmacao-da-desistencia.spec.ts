import { describe, expect, it } from 'vitest';
import { emailDaDesistencia, protocoloDaDesistencia } from '../src/cobranca/confirmacao-da-desistencia.js';

// A confirmação da desistência em 7 dias (A7; D-A7-19, D-A7-43; Decreto 7.962/2013, art. 5º), sem banco: o protocolo
// tirado da assinatura e o texto do e-mail, no calendário da empresa.

const ID = '01a40000-0000-7000-8000-0000001a2b3c';

describe('a confirmação da desistência', () => {
  it('o protocolo: o ano do pedido e os 8 últimos caracteres do id da assinatura, em maiúsculas, o mesmo a cada vez', () => {
    const quando = new Date('2026-10-25T15:00:00.000Z');
    expect(protocoloDaDesistencia(ID, quando)).toBe('L-2026-001A2B3C');
    expect(protocoloDaDesistencia(ID, quando)).toBe(protocoloDaDesistencia(ID, new Date('2026-12-31T12:00:00.000Z')));
    // O ano é o do instante (UTC): a véspera do ano novo em São Paulo, já 2027 em UTC, dá o de 2027.
    expect(protocoloDaDesistencia(ID, new Date('2027-01-01T01:00:00.000Z'))).toBe('L-2027-001A2B3C');
  });

  it('o e-mail: a data e a hora no fuso da empresa, o protocolo, a devolução e o link, com o espaço comum no "R$" (V63)', () => {
    const e = emailDaDesistencia({
      marca: 'Mister Burgers',
      protocolo: 'L-2026-001A2B3C',
      quando: new Date('2026-10-25T23:30:00.000Z'),
      fuso: 'America/Sao_Paulo',
      devolveCents: 24_900,
      forma: 'pix',
      link: 'https://app.exemplo/cobranca?marca=x',
    });
    expect(e.subject).toBe('Liame: recebemos a sua desistência da assinatura da Mister Burgers');
    expect(e.text).toContain('Recebemos o seu pedido de desistência da assinatura da Mister Burgers em 25/10/2026, às 20:30.');
    expect(e.text).toContain('Protocolo: L-2026-001A2B3C');
    expect(e.text).toContain('Devolução: R$ 249,00, para a conta que pagou o PIX.');
    expect(e.text).not.toContain(' ');
    expect(e.text).toContain('Plano e cobrança: https://app.exemplo/cobranca?marca=x');
    expect(e.text).toContain('Termos de Uso, item 11.1');
  });

  it('no cartão, o estorno; sem nada pago, nada a devolver', () => {
    const base = { marca: 'M', protocolo: 'P', quando: new Date('2026-10-25T15:00:00.000Z'), fuso: 'America/Sao_Paulo', link: 'l' };
    expect(emailDaDesistencia({ ...base, devolveCents: 44_900, forma: 'cartao' }).text).toContain('Devolução: R$ 449,00, pelo estorno no cartão.');
    expect(emailDaDesistencia({ ...base, devolveCents: 0, forma: 'pix' }).text).toContain('nada foi pago nesta assinatura');
  });
});
