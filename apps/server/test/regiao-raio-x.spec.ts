import { describe, expect, it } from 'vitest';
import { bairrosDoBasico, csvDoZip, juntarRenda, linhasDoCsv, numeroDoCenso } from '../src/regiao/censo.js';
import { enderecoDoAgregado, LEITURAS_DO_MUNICIPIO, numerosDaResposta } from '../src/regiao/ibge.js';
import { acimaDe, densidade, numeroMaisNovo, por10Mil, situacaoDaFonte, situacaoDoRetrato } from '../src/regiao/raio-x.js';
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
