import { describe, expect, it } from 'vitest';
import {
  DIA_DA_SUSPENSAO,
  DIA_DAS_ACOES_PARADAS,
  DIAS_DA_FATURA_ANTES,
  DIAS_PARA_DESISTIR,
  DIAS_PARA_O_PRIMEIRO_PAGAMENTO,
  diaDoMes,
  diaNoFuso,
  diasEntre,
  diferencaDoPlano,
  passosDoAtraso,
  proximoVencimento,
  situacaoPeloAtraso,
  somarDias,
  ultimoDiaParaDesistir,
} from '../src/cobranca/vida.js';

// A7 · W1: as contas da vida da assinatura (Termos 10.4 e 11.1; `plano-a7.md` D-A7-6, D-A7-16, D-A7-19, D-A7-21 e
// D-A7-22), com os exemplos do protótipo P26 aprovado (o vencimento em 21/10/2026, a troca de R$ 249 para R$ 449 com 30
// dos 31 dias, a desistência até 29/10/2026) e os meses curtos que o protótipo não mostrava.

describe('A vida da assinatura: as contas (A7 · W1)', () => {
  it('os prazos são os dos Termos e do P26: 10º e 30º dia, a fatura 5 dias antes, 7 dias para desistir e para o primeiro pagamento', () => {
    expect([DIA_DAS_ACOES_PARADAS, DIA_DA_SUSPENSAO, DIAS_DA_FATURA_ANTES, DIAS_PARA_DESISTIR, DIAS_PARA_O_PRIMEIRO_PAGAMENTO]).toEqual([10, 30, 5, 7, 7]);
  });

  it('o vencimento seguinte fica no dia do primeiro pagamento; no mês sem esse dia, no último dia do mês (D-A7-21)', () => {
    expect(proximoVencimento('2026-10-21', 21)).toBe('2026-11-21');
    expect(proximoVencimento('2026-12-15', 15)).toBe('2027-01-15');
    // 31: fevereiro tem 28 (ou 29), e o dia volta a 31 em março.
    expect(proximoVencimento('2026-01-31', 31)).toBe('2026-02-28');
    expect(proximoVencimento('2026-02-28', 31)).toBe('2026-03-31');
    expect(proximoVencimento('2026-03-31', 31)).toBe('2026-04-30');
    expect(proximoVencimento('2026-04-30', 31)).toBe('2026-05-31');
    expect(proximoVencimento('2028-01-31', 31)).toBe('2028-02-29');
    // 30 e 29 também voltam depois de fevereiro.
    expect(proximoVencimento('2027-01-30', 30)).toBe('2027-02-28');
    expect(proximoVencimento('2027-02-28', 30)).toBe('2027-03-30');
    expect(proximoVencimento('2027-01-29', 29)).toBe('2027-02-28');
    expect(proximoVencimento('2027-02-28', 29)).toBe('2027-03-29');
  });

  it('um ano inteiro de vencimentos no dia 31 nunca escorrega para o mês seguinte', () => {
    const falhas: string[] = [];
    let venc = '2026-01-31';
    for (let i = 0; i < 24; i++) {
      const prox = proximoVencimento(venc, 31);
      if (prox.slice(0, 7) === venc.slice(0, 7) || diasEntre(venc, prox) < 28 || diasEntre(venc, prox) > 31) falhas.push(`${venc} → ${prox}`);
      venc = prox;
    }
    expect(falhas).toEqual([]);
    expect(venc).toBe('2028-01-31');
  });

  it('os dias de atraso: em dia no vencimento; do 1º ao 9º, em atraso; do 10º ao 29º, as ações paradas; do 30º em diante, suspensa (D-A7-22)', () => {
    const venc = '2026-10-21';
    expect(situacaoPeloAtraso(null, '2026-12-31')).toBe('ativa');
    expect(situacaoPeloAtraso(venc, '2026-10-20')).toBe('ativa');
    expect(situacaoPeloAtraso(venc, venc)).toBe('ativa');
    expect(situacaoPeloAtraso(venc, somarDias(venc, 1))).toBe('em_atraso');
    expect(situacaoPeloAtraso(venc, somarDias(venc, 9))).toBe('em_atraso');
    expect(situacaoPeloAtraso(venc, somarDias(venc, 10))).toBe('acoes_paradas');
    expect(situacaoPeloAtraso(venc, somarDias(venc, 29))).toBe('acoes_paradas');
    expect(situacaoPeloAtraso(venc, somarDias(venc, 30))).toBe('suspensa');
    expect(situacaoPeloAtraso(venc, somarDias(venc, 90))).toBe('suspensa');
  });

  it('as datas dos passos do atraso são as do P26: com o vencimento em 21/10/2026, as ações param em 31/10 e a conta é suspensa em 20/11', () => {
    expect(passosDoAtraso('2026-10-21')).toEqual({ acoesParamEm: '2026-10-31', suspendeEm: '2026-11-20' });
  });

  it('a diferença da troca: a do P26 (R$ 200 a mais, 30 dos 31 dias) é R$ 193,55; descer, o último dia e o período inteiro', () => {
    expect(diferencaDoPlano(24_900, 44_900, 30, 31)).toBe(19_355);
    expect(diferencaDoPlano(24_900, 44_900, 31, 31)).toBe(20_000);
    expect(diferencaDoPlano(24_900, 44_900, 1, 30)).toBe(667);
    expect(diferencaDoPlano(24_900, 44_900, 0, 31)).toBe(0);
    // Mais dias que o período não cobra mais que a diferença inteira.
    expect(diferencaDoPlano(24_900, 44_900, 40, 31)).toBe(20_000);
    // Descer (ou o mesmo preço) não tem diferença: vale no período seguinte.
    expect(diferencaDoPlano(44_900, 24_900, 30, 31)).toBe(0);
    expect(diferencaDoPlano(24_900, 24_900, 30, 31)).toBe(0);
  });

  it('a desistência vai até o 7º dia depois do primeiro pagamento, contando o dia do pagamento como o dia zero (Termos 11.1; o P26: até 29/10/2026)', () => {
    expect(ultimoDiaParaDesistir('2026-10-22')).toBe('2026-10-29');
    expect(ultimoDiaParaDesistir('2026-12-28')).toBe('2027-01-04');
  });

  it('o dia da empresa é o do fuso dela: 23h em São Paulo ainda é o dia anterior ao de Greenwich', () => {
    const instante = new Date('2026-10-23T02:00:00Z');
    expect(diaNoFuso(instante, 'America/Sao_Paulo')).toBe('2026-10-22');
    expect(diaNoFuso(instante, 'UTC')).toBe('2026-10-23');
    expect(diaDoMes('2026-10-22')).toBe(22);
  });

  it('as contas de dia atravessam a virada do ano e do horário de verão sem perder um dia', () => {
    expect(somarDias('2026-12-30', 3)).toBe('2027-01-02');
    expect(somarDias('2027-01-02', -3)).toBe('2026-12-30');
    expect(diasEntre('2026-10-21', '2026-11-20')).toBe(30);
    expect(diasEntre('2026-11-20', '2026-10-21')).toBe(-30);
    // A troca de horário em outros países (a do fim de outubro na Europa e nos EUA) não muda a conta de calendário.
    expect(diasEntre('2026-10-24', '2026-11-02')).toBe(9);
  });
});
