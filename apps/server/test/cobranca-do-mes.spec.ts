import { describe, expect, it } from 'vitest';
import { DIA_DA_COBRANCA_DO_MES, emailDaCobrancaDoMes } from '../src/cobranca/cobranca-do-mes.js';

// A cobrança do mês por e-mail, com o PIX (A7; D-A7-17, D-A7-44), sem banco: o texto do e-mail.

describe('o e-mail da cobrança do mês', () => {
  it('o mês do período, a marca, o plano, o valor com o espaço comum (V63), o vencimento, o código do PIX e o link', () => {
    const e = emailDaCobrancaDoMes({
      marca: 'Mister Burgers',
      plano: 'Essencial',
      periodoComeca: '2026-11-22',
      vencimento: '2026-11-22',
      valorCents: '24900',
      copiaECola: '00020101021226820014br.gov.bcb.pix',
      link: 'https://app.exemplo/cobranca?marca=x',
    });
    expect(e.subject).toBe('Liame: a mensalidade de novembro da Mister Burgers vence em 22/11');
    expect(e.text).toContain('A mensalidade de novembro da Mister Burgers (plano Essencial), de R$ 249,00, vence em 22/11.');
    expect(e.text).not.toContain(' ');
    expect(e.text).toContain('Para pagar, copie o código do PIX abaixo e cole no app do seu banco (PIX copia e cola):\n\n00020101021226820014br.gov.bcb.pix\n');
    expect(e.text).toContain('Ou abra o QR Code em Plano e cobrança: https://app.exemplo/cobranca?marca=x');
    expect(DIA_DA_COBRANCA_DO_MES).toBe(0);
  });
});
