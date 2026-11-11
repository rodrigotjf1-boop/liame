import { describe, expect, it } from 'vitest';
import { bairrosDoBasico, csvDoZip, juntarRenda, linhasDoCsv, numeroDoCenso } from '../src/regiao/censo.js';
import { enderecoDoAgregado, enderecoDoPix, LEITURAS_DO_MUNICIPIO, lugarDaLeitura, numerosDaResposta, numerosDoPix, periodoDoIbge, rmDoMunicipio } from '../src/regiao/ibge.js';
import {
  acimaDe,
  correcaoDoIpca,
  corrigido,
  densidade,
  fontesDoRetrato,
  inflacaoDeComerFora,
  mediaDosTrimestres,
  numeroMaisNovo,
  pixDoMunicipio,
  por10Mil,
  situacaoDaFonte,
  situacaoDoRetrato,
} from '../src/regiao/raio-x.js';
import { mesEmBrasilia, mesesAntes } from '../src/worker/regiao-fontes.service.js';
import { arquivosDoZip, ZipInvalido } from '../src/regiao/zip.js';
import { zipCom } from './helpers/zip-de-mentira.js';

// Plano da região, R2, parte 1 (Sua região; migration 0137), sem banco e sem rede: o leitor do .zip do IBGE, os
// arquivos do Censo por bairro (latin1, ponto e vírgula, decimal com vírgula), a resposta da API de agregados e as contas
// do retrato. O caminho com o banco e a rotina está em `test/db/regiao-raio-x.spec.ts`.

const BASICO = [
  '"CD_BAIRRO";"NM_BAIRRO";"CD_MUN";"NM_MUN";"AREA_KM2";"v0001";"v0002";"v0003"',
  '"3304557030";"Tijuca";"3304557";"Rio de Janeiro";"9,9413";"142909";"61200";"1"',
  '"3304557031";"Maracanã";"3304557";"Rio de Janeiro";"1,6";"25000";".";"1"',
  '"33045";"Errado";"3304557";"Rio";"1";"1";"1";"1"',
].join('\r\n');
const RENDA = ['"CD_BAIRRO";"NM_BAIRRO";"V06004";"V06006"', '"3304557030";"Tijuca";"8056,52";"5500"', '"3304557031";"Maracanã";".";"4000"'].join('\n');

describe('o .zip do IBGE', () => {
  it('lê o arquivo guardado e o comprimido', () => {
    const zip = zipCom([
      { nome: 'a.csv', conteudo: Buffer.from('um;dois') },
      { nome: 'b.txt', conteudo: Buffer.from('três', 'latin1'), guardado: true },
    ]);
    const arquivos = arquivosDoZip(zip, 1024);
    expect(arquivos.map((a) => [a.nome, a.conteudo.toString('latin1')])).toEqual([
      ['a.csv', 'um;dois'],
      ['b.txt', 'três'],
    ]);
  });

  it('recusa o que não é .zip e o arquivo maior que o teto (o .zip pequeno que vira gigabytes)', () => {
    expect(() => arquivosDoZip(Buffer.from('não sou um zip, sou um texto comprido o bastante'), 1024)).toThrow(ZipInvalido);
    const grande = zipCom([{ nome: 'a.csv', conteudo: Buffer.alloc(5000, 'a') }]);
    expect(() => arquivosDoZip(grande, 1000)).toThrow(/grande demais/);
  });
});

describe('os arquivos do Censo por bairro', () => {
  it('o .csv com aspas, ponto e vírgula e "" dentro do campo', () => {
    expect(linhasDoCsv('"a";"b ""c""";"d"\r\n"1";"2"\n')).toEqual([
      ['a', 'b "c"', 'd'],
      ['1', '2'],
    ]);
  });

  it('o número com vírgula; "." e vazio são "sem o dado"', () => {
    expect([numeroDoCenso('9,9413'), numeroDoCenso('142909'), numeroDoCenso('.'), numeroDoCenso(''), numeroDoCenso('X')]).toEqual([9.9413, 142909, null, null, null]);
  });

  it('os bairros pelo código, com o nome sem acento para casar com o CEP, e a renda junta pelo código', () => {
    const bairros = bairrosDoBasico(BASICO);
    expect([...bairros.keys()]).toEqual(['3304557030', '3304557031']);
    expect(bairros.get('3304557031')).toMatchObject({ municipio: '3304557', nome: 'Maracanã', chave: 'maracana', areaKm2: 1.6, pessoas: 25000, domicilios: null });
    expect(juntarRenda(bairros, RENDA)).toBe(2);
    expect(bairros.get('3304557030')).toMatchObject({ rendaMedia: 8056.52, rendaMediana: 5500 });
    expect(bairros.get('3304557031')).toMatchObject({ rendaMedia: null, rendaMediana: 4000 });
  });

  it('o .csv de dentro do .zip, em latin1', () => {
    const zip = zipCom([{ nome: 'Agregados_por_bairros_basico_BR.csv', conteudo: Buffer.from(BASICO, 'latin1') }]);
    expect(bairrosDoBasico(csvDoZip(zip)).get('3304557031')?.nome).toBe('Maracanã');
  });

  it('a coluna que sumiu do arquivo para a leitura (o IBGE mudou o formato)', () => {
    expect(() => bairrosDoBasico('"CD_BAIRRO";"NM_BAIRRO"\n"3304557030";"Tijuca"')).toThrow(/coluna CD_MUN/);
  });
});

describe('a API de agregados do IBGE', () => {
  const [pop, , renda, restaurantes] = LEITURAS_DO_MUNICIPIO;

  it('o endereço da tabela pelo município, com a classificação quando há', () => {
    const u = new URL(enderecoDoAgregado(pop!, '3304557'));
    expect([u.host, decodeURIComponent(u.pathname), u.searchParams.get('localidades')]).toEqual(['servicodados.ibge.gov.br', '/api/v3/agregados/4714/periodos/2022/variaveis/93|614', 'N6[3304557]']);
    expect(enderecoDoAgregado(restaurantes!, '3304557')).toContain('classificacao=12762%5B117551%5D');
    expect(() => enderecoDoAgregado(pop!, '33')).toThrow();
  });

  it('os números da resposta: só o município pedido, o período mais novo, sem "-" nem "..."', () => {
    const corpo = [
      { id: '93', resultados: [{ series: [{ localidade: { id: '3304557' }, serie: { '2022': '6211223' } }, { localidade: { id: '9999999' }, serie: { '2022': '1' } }] }] },
      { id: '614', resultados: [{ series: [{ localidade: { id: '3304557' }, serie: { '2022': '5174.60' } }] }] },
    ];
    expect(numerosDaResposta(corpo, pop!, '3304557')).toEqual([
      { indicador: 'populacao', periodo: '2022', valor: 6211223 },
      { indicador: 'densidade', periodo: '2022', valor: 5174.6 },
    ]);
    const semDado = [{ id: '13534', resultados: [{ series: [{ localidade: { id: '3304557' }, serie: { '2022': '-' } }] }] }];
    expect(numerosDaResposta(semDado, renda!, '3304557')).toEqual([]);
    const varios = [{ id: '706', resultados: [{ series: [{ localidade: { id: '3304557' }, serie: { '2023': '16000', '2024': '16242' } }] }] }];
    expect(numerosDaResposta(varios, restaurantes!, '3304557')).toEqual([{ indicador: 'restaurantes', periodo: '2024', valor: 16242 }]);
    expect(numerosDaResposta({ erro: 1 }, restaurantes!, '3304557')).toEqual([]);
  });
});

describe('as contas do retrato', () => {
  it('o número mais novo, a densidade, por 10 mil e acima de quantos por cento', () => {
    const numeros = [
      { indicator: 'populacao_estimada', period: '2025', value: '6700000', source: 'ibge_6579' },
      { indicator: 'populacao_estimada', period: '2026', value: 6731133, source: 'ibge_6579' },
    ];
    expect(numeroMaisNovo(numeros, 'populacao_estimada')).toEqual({ value: 6731133, period: '2026', source: 'ibge_6579' });
    expect(numeroMaisNovo(numeros, 'restaurantes')).toBeNull();
    expect([densidade(142909, 9.9413), densidade(10, 0), densidade(null, 1)]).toEqual([14375.3, null, null]);
    expect([por10Mil(16242, 6731133), por10Mil(1, 0)]).toEqual([24.1, null]);
    expect([acimaDe(141, 162), acimaDe(0, 0)]).toEqual([87, 0]);
  });

  it('a situação de cada fonte e do retrato: lendo, falhou (nunca deu certo) e em dia (o guardado vale)', () => {
    expect(situacaoDaFonte('ibge_4714', undefined)).toEqual({ source: 'ibge_4714', status: 'lendo', read_at: null, next_try_at: null });
    const falhou = situacaoDaFonte('ibge_4714', { source: 'ibge_4714', geo_code: '3304557', last_ok_at: null, last_error: 'o IBGE respondeu 500', next_try_at: '2026-11-11T16:00:00Z' });
    expect(falhou).toEqual({ source: 'ibge_4714', status: 'falhou', read_at: null, next_try_at: '2026-11-11T16:00:00.000Z' });
    const renovacaoFalhou = situacaoDaFonte('ibge_4714', { source: 'ibge_4714', geo_code: '3304557', last_ok_at: '2026-11-01T10:00:00Z', last_error: 'x', next_try_at: null });
    expect(renovacaoFalhou.status).toBe('em_dia');
    expect(situacaoDoRetrato([renovacaoFalhou, falhou])).toBe('parcial');
    expect(situacaoDoRetrato([renovacaoFalhou, situacaoDaFonte('x', undefined)])).toBe('lendo');
    expect(situacaoDoRetrato([renovacaoFalhou])).toBe('pronto');
  });
});

describe('as fontes mais novas que o Censo (parte 3; base §19.5)', () => {
  const leitura = (fonte: string) => LEITURAS_DO_MUNICIPIO.find((l) => l.fonte === fonte)!;

  it('o período do IBGE: o ano, o mês e o trimestre pelo mês em que termina', () => {
    expect([periodoDoIbge('2025', false), periodoDoIbge('202609', false), periodoDoIbge('202602', true), periodoDoIbge('202604', true), periodoDoIbge('202605', true), periodoDoIbge('202613', false)]).toEqual([
      '2025',
      '2026-09',
      '2026-06',
      '2026-12',
      null,
      null,
    ]);
  });

  it('o lugar de cada leitura: a UF, a capital (só ela), a RM (só com a RM resolvida), o IPCA local e o Brasil', () => {
    const rio = '3304557';
    const niteroi = '3303302';
    expect(lugarDaLeitura(leitura('ibge_7531'), niteroi, '3301')).toEqual({ nivel: 'uf', codigo: '33', localidade: 'N3[33]' });
    expect(lugarDaLeitura(leitura('ibge_6472'), rio, '3301')).toEqual({ nivel: 'municipio', codigo: rio, localidade: `N6[${rio}]` });
    expect(lugarDaLeitura(leitura('ibge_6472'), niteroi, '3301')).toBeNull();
    expect(lugarDaLeitura(leitura('ibge_7395'), niteroi, '3301')).toEqual({ nivel: 'rm', codigo: '3301', localidade: 'N7[3301]' });
    expect(lugarDaLeitura(leitura('ibge_7395'), niteroi, null)).toBeNull();
    expect(lugarDaLeitura(leitura('ibge_7060'), niteroi, '3301')).toMatchObject({ nivel: 'rm', codigo: '3301' });
    // Goiânia: o IPCA cobre o município sozinho; Manaus: a RM da PNAD existe (1301), mas o IPCA não a cobre.
    expect(lugarDaLeitura(leitura('ibge_7060'), '5208707', '5201')).toMatchObject({ nivel: 'municipio', codigo: '5208707' });
    expect(lugarDaLeitura(leitura('ibge_7060'), '1302603', '1301')).toBeNull();
    expect(lugarDaLeitura(leitura('ibge_1737'), niteroi, null)).toEqual({ nivel: 'brasil', codigo: '1', localidade: 'N1[all]' });
    expect(fontesDoRetrato(niteroi, null).map((f) => f.fonte)).not.toContain('ibge_6472');
  });

  it('a RM do município: a RM legal que tem ele e a capital da UF vira a RM da PNAD ("UF01")', () => {
    const lista = [{ municipios: [{ id: 3304557 }, { id: 3303302 }] }, { municipios: [{ id: 3300100 }] }];
    expect([rmDoMunicipio(lista, '3303302'), rmDoMunicipio(lista, '3304557'), rmDoMunicipio(lista, '3300100'), rmDoMunicipio({ erro: 1 }, '3304557')]).toEqual(['3301', '3301', null, null]);
  });

  it('a resposta com categorias (IPCA de comer fora) e com todos os trimestres (renda do trabalho)', () => {
    const ipca = [
      {
        id: '2265',
        resultados: [
          { classificacoes: [{ categoria: { '7432': 'Alimentação fora do domicílio' } }], series: [{ localidade: { id: '3301' }, serie: { '202609': '4.31' } }] },
          { classificacoes: [{ categoria: { '7435': 'Lanche' } }], series: [{ localidade: { id: '3301' }, serie: { '202609': '7.75' } }] },
          { classificacoes: [{ categoria: { '9999': 'Outra' } }], series: [{ localidade: { id: '3301' }, serie: { '202609': '1' } }] },
        ],
      },
    ];
    expect(numerosDaResposta(ipca, leitura('ibge_7060'), '3301')).toEqual([
      { indicador: 'ipca_fora_12m', periodo: '2026-09', valor: 4.31 },
      { indicador: 'ipca_lanche_12m', periodo: '2026-09', valor: 7.75 },
    ]);
    const trimestres = [{ id: '5933', resultados: [{ series: [{ localidade: { id: '3304557' }, serie: { '202601': '5791', '202602': '5227' } }] }] }];
    expect(numerosDaResposta(trimestres, leitura('ibge_6472'), '3304557')).toEqual([
      { indicador: 'renda_trabalho', periodo: '2026-03', valor: 5791 },
      { indicador: 'renda_trabalho', periodo: '2026-06', valor: 5227 },
    ]);
  });

  it('o Pix: só os meses completos do município; o endereço pede desde 13 meses antes', () => {
    const corpo = { value: [{ AnoMes: 202610, Municipio_Ibge: 3304557, VL_PagadorPF: 10.5, QT_PES_PagadorPF: 7 }, { AnoMes: 202611, Municipio_Ibge: 3304557, VL_PagadorPF: 1, QT_PES_PagadorPF: 1 }] };
    expect(numerosDoPix(corpo, '3304557', '202611')).toEqual([
      { indicador: 'pix_pf_pagadores', periodo: '2026-10', valor: 7 },
      { indicador: 'pix_pf_valor', periodo: '2026-10', valor: 10.5 },
    ]);
    expect(enderecoDoPix('3304557', '202510')).toContain("@DataBase='202510'");
    expect(() => enderecoDoPix('33', '202510')).toThrow();
    expect([mesesAntes('202611', 13), mesesAntes('202601', 1), mesEmBrasilia(new Date('2026-12-01T01:00:00Z'))]).toEqual(['202510', '202512', '202611']);
  });

  it('as contas: o IPCA desde julho de 2022, a média dos trimestres, o Pix um ano antes e a inflação de comer fora', () => {
    const n = (geo_level: string, geo_code: string, indicator: string, period: string, value: number, source = 'x') => ({ geo_level, geo_code, indicator, period, value, source });
    const numeros = [
      n('brasil', '1', 'ipca_indice', '2022-07', 6411.95),
      n('brasil', '1', 'ipca_indice', '2026-09', 7695.82),
      n('municipio', '3304557', 'renda_trabalho', '2025-09', 5907),
      n('municipio', '3304557', 'renda_trabalho', '2025-12', 5844),
      n('municipio', '3304557', 'renda_trabalho', '2026-03', 5791),
      n('municipio', '3304557', 'renda_trabalho', '2026-06', 5227),
      n('municipio', '3304557', 'renda_trabalho', '2025-06', 1),
      n('municipio', '3304557', 'pix_pf_pagadores', '2026-10', 5109806),
      n('municipio', '3304557', 'pix_pf_valor', '2026-10', 44.2),
      n('municipio', '3304557', 'pix_pf_pagadores', '2025-10', 4900000),
      n('rm', '3301', 'ipca_fora_12m', '2026-09', 4.31),
      n('rm', '3301', 'ipca_refeicao_12m', '2026-09', 2.66),
      n('brasil', '1', 'ipca_fora_12m', '2026-09', 5.79),
    ];
    const ipca = correcaoDoIpca(numeros);
    expect(ipca).toEqual({ from: '2022-07', to: '2026-09', factor: 1.2002 });
    expect([corrigido(5500, ipca), corrigido(null, ipca), corrigido(5500, null)]).toEqual([6601, null, null]);
    expect(correcaoDoIpca(numeros.filter((x) => x.period !== '2022-07'))).toBeNull();
    // A média dos 4 trimestres mais novos (o de jun/2025 fica de fora).
    expect(mediaDosTrimestres(numeros, 'renda_trabalho', '3304557')).toEqual({ value: 5692, period: '2026-06', quarters: 4, source: 'x' });
    expect(pixDoMunicipio(numeros, '3304557')).toEqual({ period: '2026-10', payers: 5109806, value: 44.2, payers_prev_year: 4900000, value_prev_year: null });
    expect(inflacaoDeComerFora(numeros, 'rm', '3301')).toEqual({ scope: 'rm', period: '2026-09', away: 4.31, meal: 2.66, snack: null, brasil: { away: 5.79, meal: null, snack: null } });
    // O número de outro lugar não se mistura.
    expect(numeroMaisNovo(numeros, 'ipca_fora_12m', 'rm', '3301')).toMatchObject({ value: 4.31 });
    expect(numeroMaisNovo(numeros, 'ipca_fora_12m', 'brasil', '1')).toMatchObject({ value: 5.79 });
  });
});
