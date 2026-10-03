import { describe, expect, it } from 'vitest';
import { cotacoesDaPtax, emReais, enderecoDaPtax, HOST_DA_PTAX } from '../src/cambio/ptax.js';

// A3 · D-A3-14: a PTAX de venda do Banco Central, para a tela mostrar o custo de IA em reais. O endereço é fixo, a
// resposta é conferida antes de virar cotação, e a conta é feita só com inteiros.

/** A resposta do Banco Central, como ele mandou em 03/10/2026 para o período de 26/09 a 03/10 (base §10.1). */
const RESPOSTA = {
  '@odata.context': 'https://was-p.bcnet.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata$metadata#_CotacaoDolarPeriodo(cotacaoVenda,dataHoraCotacao)',
  value: [
    { cotacaoVenda: 5.2132, dataHoraCotacao: '2026-09-28 13:03:11.35885' },
    { cotacaoVenda: 5.2204, dataHoraCotacao: '2026-09-29 13:06:06.446305' },
    { cotacaoVenda: 5.1809, dataHoraCotacao: '2026-09-30 13:11:44.783262' },
    { cotacaoVenda: 5.2079, dataHoraCotacao: '2026-10-01 13:10:35.4469' },
    { cotacaoVenda: 5.2238, dataHoraCotacao: '2026-10-02 13:03:16.256632' },
  ],
};

describe('PTAX do Banco Central (A3, D-A3-14)', () => {
  it('o endereço é o do Banco Central, com as datas no formato dele (MM-DD-AAAA)', () => {
    const u = new URL(enderecoDaPtax('2026-09-26', '2026-10-03'));
    expect(u.protocol).toBe('https:');
    expect(u.hostname).toBe(HOST_DA_PTAX);
    expect(u.pathname).toBe('/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)');
    expect(u.searchParams.get('@dataInicial')).toBe("'09-26-2026'");
    expect(u.searchParams.get('@dataFinalCotacao')).toBe("'10-03-2026'");
    expect(u.searchParams.get('$format')).toBe('json');
  });

  it('uma cotação por dia útil, com quatro casas, o dia de Brasília e a hora do boletim em UTC', () => {
    const c = cotacoesDaPtax(RESPOSTA);
    expect(c.map((x) => [x.dia, x.taxa])).toEqual([
      ['2026-09-28', '5.2132'],
      ['2026-09-29', '5.2204'],
      ['2026-09-30', '5.1809'],
      ['2026-10-01', '5.2079'],
      ['2026-10-02', '5.2238'],
    ]);
    // 13:03:16 em Brasília (UTC−3) é 16:03:16 em UTC.
    expect(c.at(-1)!.publicadaEm).toBe('2026-10-02T16:03:16.000Z');
    // Fim de semana e feriado não têm boletim: a lista vazia é resposta válida.
    expect(cotacoesDaPtax({ value: [] })).toEqual([]);
  });

  it('dois boletins no mesmo dia: vale o último; a ordem da resposta não importa', () => {
    const c = cotacoesDaPtax({
      value: [
        { cotacaoVenda: 5.3, dataHoraCotacao: '2026-10-02 13:03:16.2' },
        { cotacaoVenda: 5.1, dataHoraCotacao: '2026-10-01 13:10:35.4' },
        { cotacaoVenda: 5.2, dataHoraCotacao: '2026-10-02 10:05:00.0' },
      ],
    });
    expect(c.map((x) => [x.dia, x.taxa])).toEqual([
      ['2026-10-01', '5.1000'],
      ['2026-10-02', '5.3000'],
    ]);
  });

  it('resposta fora do formato não vira cotação: número absurdo, data torta ou outro formato são recusados', () => {
    expect(() => cotacoesDaPtax({ value: [{ cotacaoVenda: 0, dataHoraCotacao: '2026-10-02 13:03:16' }] })).toThrow('fora do formato');
    expect(() => cotacoesDaPtax({ value: [{ cotacaoVenda: 5223.8, dataHoraCotacao: '2026-10-02 13:03:16' }] })).toThrow('fora do formato');
    expect(() => cotacoesDaPtax({ value: [{ cotacaoVenda: '5.2238', dataHoraCotacao: '2026-10-02 13:03:16' }] })).toThrow('fora do formato');
    expect(() => cotacoesDaPtax({ value: [{ cotacaoVenda: 5.2, dataHoraCotacao: '02/10/2026 13:03' }] })).toThrow('fora do formato');
    expect(() => cotacoesDaPtax({ erro: 'manutenção' })).toThrow('fora do formato');
    expect(() => cotacoesDaPtax('<html>')).toThrow('fora do formato');
  });

  it('dólar em reais só com inteiros: micros de dólar pela cotação, metade para cima', () => {
    // US$ 1,00 a 5,2238 = R$ 5,2238.
    expect(emReais(1_000_000n, '5.2238')).toBe(5_223_800n);
    // US$ 4,34 (o gasto de um mês de piloto) a 5,2238 = R$ 22,671292.
    expect(emReais(4_340_000n, '5.2238')).toBe(22_671_292n);
    expect(emReais(0n, '5.2238')).toBe(0n);
    // Um micro de dólar: 5,2238 micros de real arredonda para 5.
    expect(emReais(1n, '5.2238')).toBe(5n);
    expect(emReais(1n, '5.5')).toBe(6n);
    expect(emReais(20_000_000n, '5')).toBe(100_000_000n);
  });
});
