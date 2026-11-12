import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  chaveDoMunicipio,
  ContagemDoCnpj,
  EQUIVALENCIAS_DA_RECEITA,
  ehMes,
  enderecoDoArquivo,
  equivalenciaDeMunicipios,
  inicioDaJanela,
  itensDaPasta,
  lerArquivoDoCnpj,
  mesCompleto,
  municipiosDaReceita,
  PASTA_DO_CNPJ,
  ultimoMesCompleto,
} from '../src/regiao/cnpj.js';
import { type ContagemGuardada, restaurantesDoRetrato, situacaoDoRetrato } from '../src/regiao/raio-x.js';
import { PrimeiroArquivoDoZip, ZipInvalido } from '../src/regiao/zip.js';
import { zip64Com, zipCom } from './helpers/zip-de-mentira.js';

// Plano da região, R2, parte 4: os restaurantes ativos pelo CNPJ aberto da Receita, sem banco e sem rede. O .zip lido em
// fluxo (o de 2,3 GB passa de 4 GB descompactado: zip64), a pasta da Receita (WebDAV), a tradução do código de
// município da Receita para o do IBGE, a contagem linha a linha (só o CNAE principal conta; nada da linha é guardado)
// e a montagem do retrato. Os dados das linhas são de mentira.

const RIO = '3304557';

/** Uma linha do arquivo de estabelecimentos (30 colunas entre aspas, separadas por ponto e vírgula). */
function linha(o: { situacao?: string; dataSituacao?: string; inicio?: string; cnae?: string; secundaria?: string; bairro?: string; cep?: string; uf?: string; municipio?: string } = {}): string {
  const c: string[] = Array.from({ length: 30 }, () => '');
  c[0] = '12345678';
  c[1] = '0001';
  c[2] = '00';
  c[3] = '1';
  c[4] = 'NOME DE MENTIRA';
  c[5] = o.situacao ?? '02';
  c[6] = o.dataSituacao ?? '20200101';
  c[10] = o.inicio ?? '20150101';
  c[11] = o.cnae ?? '5611201';
  c[12] = o.secundaria ?? '';
  c[14] = 'RUA DE MENTIRA';
  c[17] = o.bairro ?? 'TIJUCA';
  c[18] = o.cep ?? '20520054';
  c[19] = o.uf ?? 'RJ';
  c[20] = o.municipio ?? '6001';
  c[27] = 'contato@exemplo.invalid';
  return c.map((v) => `"${v}"`).join(';');
}

/** A lista de municípios do IBGE (a de verdade tem 5.571; a conferência pede pelo menos 5.000). */
function listaDoIbge(): unknown {
  const lista = Array.from({ length: 5000 }, (_, i) => ({ 'municipio-id': 1_100_000 + i, 'municipio-nome': `Cidade ${i}`, 'UF-sigla': 'RO' }));
  lista.push(
    { 'municipio-id': Number(RIO), 'municipio-nome': 'Rio de Janeiro', 'UF-sigla': 'RJ' },
    { 'municipio-id': 2201903, 'municipio-nome': 'Bom Jesus', 'UF-sigla': 'PI' },
    { 'municipio-id': 4302709, 'municipio-nome': 'Bom Jesus', 'UF-sigla': 'RS' },
    { 'municipio-id': 3303807, 'municipio-nome': 'Paraty', 'UF-sigla': 'RJ' },
    { 'municipio-id': 3550308, 'municipio-nome': "Santa Bárbara d'Oeste", 'UF-sigla': 'SP' },
  );
  return lista;
}

const daReceita = municipiosDaReceita(['"6001";"RIO DE JANEIRO"', '"1111";"BOM JESUS"', '"5875";"PARATI"', '"7171";"SANTA BARBARA D\'OESTE"', '"9999";"CIDADE QUE NAO EXISTE"'].join('\r\n'));
const municipioDe = equivalenciaDeMunicipios(daReceita, listaDoIbge());
const bairroDe = (municipio: string, chave: string) => (municipio === RIO ? ({ tijuca: `${RIO}030`, maracana: `${RIO}031` } as Record<string, string>)[chave] ?? null : null);

async function descompactar(zip: Buffer, pedaco: number): Promise<{ texto: string; info: PrimeiroArquivoDoZip['info'] }> {
  const partes: Buffer[] = [];
  for (let i = 0; i < zip.length; i += pedaco) partes.push(zip.subarray(i, i + pedaco));
  const leitor = new PrimeiroArquivoDoZip({ soDeflate: true });
  const saida: Buffer[] = [];
  const inflar = createInflateRaw();
  inflar.on('data', (d: Buffer) => saida.push(d));
  await pipeline(Readable.from(partes), leitor, inflar);
  return { texto: Buffer.concat(saida).toString('latin1'), info: leitor.info };
}

describe('o .zip lido em fluxo (R2, parte 4)', () => {
  it('lê o primeiro arquivo em pedaços pequenos, com o cabeçalho comum e com o zip64', async () => {
    const conteudo = Buffer.from('linha 1\nlinha 2\n'.repeat(500), 'latin1');
    const comum = await descompactar(zipCom([{ nome: 'K3241.ESTABELE', conteudo }]), 7);
    expect(comum.texto).toBe(conteudo.toString('latin1'));
    expect(comum.info).toMatchObject({ nome: 'K3241.ESTABELE', metodo: 8, tamanho: conteudo.length });
    const grande = await descompactar(zip64Com('K3241.ESTABELE', conteudo), 5);
    expect(grande.texto).toBe(conteudo.toString('latin1'));
    expect(grande.info).toMatchObject({ metodo: 8, tamanho: conteudo.length });
  });

  it('recusa o arquivo cortado, com senha, sem o tamanho no cabeçalho e o guardado quando pede deflate', async () => {
    const conteudo = Buffer.from('x'.repeat(5000), 'latin1');
    const zip = zipCom([{ nome: 'a.csv', conteudo }]);
    await expect(descompactar(zip.subarray(0, 40), 9)).rejects.toThrow(ZipInvalido);
    await expect(descompactar(zip64Com('a.csv', conteudo, 1), 9)).rejects.toThrow('arquivo com senha');
    await expect(descompactar(zip64Com('a.csv', conteudo, 8), 9)).rejects.toThrow('descritor de dados');
    await expect(descompactar(zipCom([{ nome: 'a.csv', conteudo, guardado: true }]), 9)).rejects.toThrow('método de compressão 0');
    await expect(descompactar(Buffer.from('não é zip nenhum, só texto comprido o bastante'), 9)).rejects.toThrow('cabeçalho local');
  });
});

describe('a pasta da Receita (WebDAV)', () => {
  const resposta = (itens: Array<{ href: string; tamanho?: number }>) =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${itens
      .map((i) => `<d:response><d:href>${i.href}</d:href><d:propstat><d:prop>${i.tamanho === undefined ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:getcontentlength>${i.tamanho}</d:getcontentlength>`}</d:prop></d:propstat></d:response>`)
      .join('')}</d:multistatus>`;
  const raiz = '/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CNPJ/';
  const arquivos = (mes: string, sem?: string) =>
    resposta([
      { href: `${raiz}${mes}/` },
      { href: `${raiz}${mes}/Municipios.zip`, tamanho: 43443 },
      ...Array.from({ length: 10 }, (_, i) => ({ href: `${raiz}${mes}/Estabelecimentos${i}.zip`, tamanho: 341948627 })).filter((a) => !sem || !a.href.endsWith(sem)),
    ]);

  it('lê os itens, reconhece os meses e o mês inteiro', () => {
    const itens = itensDaPasta(arquivos('2026-10'));
    expect(itens[0]).toEqual({ nome: '2026-10', tamanho: null });
    expect(itens).toContainEqual({ nome: 'Estabelecimentos9.zip', tamanho: 341948627 });
    expect(mesCompleto(itens)).toBe(true);
    expect(mesCompleto(itensDaPasta(arquivos('2026-10', 'Estabelecimentos7.zip')))).toBe(false);
    expect(['2026-10', '2026-13', 'cnpj.tar.gz', '2026-1', '202610'].map(ehMes)).toEqual([true, false, false, false, false]);
    expect(inicioDaJanela('2026-10')).toBe('20251001');
    expect(inicioDaJanela('2026-01')).toBe('20250101');
    expect(enderecoDoArquivo('2026-10', 3)).toBe(`${PASTA_DO_CNPJ}2026-10/Estabelecimentos3.zip`);
  });

  it('o mês mais novo que já está inteiro (o que a Receita ainda sobe fica para depois)', async () => {
    const pedidos: Array<{ url: string; metodo: string }> = [];
    const buscar = (async (url: string, init?: RequestInit) => {
      pedidos.push({ url, metodo: init?.method ?? 'GET' });
      const corpo =
        url === PASTA_DO_CNPJ
          ? resposta([{ href: raiz }, { href: `${raiz}2026-09/` }, { href: `${raiz}2026-11/` }, { href: `${raiz}2026-10/` }, { href: `${raiz}cnpj.tar.gz`, tamanho: 10 }])
          : url.endsWith('2026-11/')
            ? arquivos('2026-11', 'Estabelecimentos9.zip')
            : arquivos('2026-10');
      return new Response(corpo, { status: 207 });
    }) as typeof fetch;
    expect(await ultimoMesCompleto(buscar)).toBe('2026-10');
    expect(pedidos.every((p) => p.metodo === 'PROPFIND' && p.url.startsWith(PASTA_DO_CNPJ))).toBe(true);
  });
});

describe('o município da Receita no código do IBGE', () => {
  it('casa pelo nome e pela UF, usa a tabela dos que mudaram de nome e deixa de fora o que não casa', () => {
    expect(municipioDe('6001', 'RJ')).toBe(RIO);
    // O mesmo nome em duas UFs: a UF da linha decide.
    expect(municipioDe('1111', 'PI')).toBe('2201903');
    expect(municipioDe('1111', 'RS')).toBe('4302709');
    // Parati → Paraty (tabela conferida); o apóstrofo e o acento não atrapalham.
    expect(municipioDe('5875', 'RJ')).toBe('3303807');
    expect(municipioDe('7171', 'SP')).toBe('3550308');
    expect(municipioDe('9999', 'SP')).toBeNull();
    expect(municipioDe('6001', 'SP')).toBeNull();
    expect(Object.keys(EQUIVALENCIAS_DA_RECEITA)).toHaveLength(16);
    expect(chaveDoMunicipio("Sant'Ana do Livramento")).toBe('sant ana do livramento');
    expect(() => equivalenciaDeMunicipios(daReceita, [])).toThrow();
  });
});

describe('a contagem linha a linha', () => {
  const desde = inicioDaJanela('2026-10');
  const linhas = [
    linha(), // restaurante ativo na Tijuca
    linha({ cnae: '5611203', bairro: 'Maracanã', cep: '20271110' }), // lanchonete ativa no Maracanã
    linha({ cnae: '5611205', inicio: '20260315' }), // bar ativo, aberto na janela
    linha({ cnae: '5620104', bairro: 'BAIRRO QUE O CENSO NAO TEM' }), // comida para casa, bairro sem par
    linha({ situacao: '08', dataSituacao: '20260520' }), // baixado na janela
    linha({ situacao: '08', dataSituacao: '20190101' }), // baixado antes da janela: não conta
    linha({ situacao: '04' }), // inapto, antigo: não conta
    linha({ cnae: '4721102', secundaria: '5611203' }), // comida só na secundária: não conta
    linha({ municipio: '9999', uf: 'SP' }), // município sem par no IBGE
    linha({ municipio: '1111', uf: 'RS', bairro: 'CENTRO', cep: '9547' }), // outro município; CEP inválido
    '"x";"5611201";"curta"', // fora do formato (a busca acha o CNAE, mas a linha não tem 30 colunas)
  ];

  it('conta por município, bairro do Censo e CEP, em pedaços que cortam as linhas no meio', () => {
    const contagem = new ContagemDoCnpj(desde, municipioDe, bairroDe);
    const tudo = Buffer.from(linhas.join('\r\n'), 'latin1');
    for (let i = 0; i < tudo.length; i += 37) contagem.pedaco(tudo.subarray(i, i + 37));
    contagem.fim();
    const por = new Map(contagem.linhas().map((l) => [`${l.municipio}|${l.tipo}|${l.chave}`, l.contagem]));
    // [ativos, restaurante, lanchonete, bar, para casa, abertos em 12 meses, baixados em 12 meses]
    expect(por.get(`${RIO}|municipio|`)).toEqual([4, 1, 1, 1, 1, 1, 1]);
    expect(por.get(`${RIO}|bairro|${RIO}030`)).toEqual([2, 1, 0, 1, 0, 1, 1]);
    expect(por.get(`${RIO}|bairro|${RIO}031`)).toEqual([1, 0, 1, 0, 0, 0, 0]);
    expect(por.get(`${RIO}|cep|20520`)).toEqual([3, 1, 0, 1, 1, 1, 1]);
    expect(por.get(`${RIO}|cep|20271`)).toEqual([1, 0, 1, 0, 0, 0, 0]);
    expect(por.get('4302709|municipio|')).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect([...por.keys()].some((k) => k.startsWith('4302709|cep'))).toBe(false);
    expect(contagem.estatistica).toEqual({ linhas: 9, foraDoFormato: 1, semMunicipio: 1, ativosComBairro: 3, ativos: 5 });
    // Só contagens saem: nenhuma chave leva nome, rua, e-mail ou CNPJ.
    expect(JSON.stringify(contagem.linhas())).not.toMatch(/MENTIRA|exemplo|12345678/);
  });

  it('lê um arquivo da Receita inteiro pela rede simulada (zip64), confere o tamanho e recusa endereço de fora', async () => {
    const conteudo = Buffer.from(`${linhas.join('\n')}\n`, 'latin1');
    const contagem = new ContagemDoCnpj(desde, municipioDe, bairroDe);
    const pedidos: string[] = [];
    const avancos: number[] = [];
    const buscar = (async (url: string) => {
      pedidos.push(url);
      return new Response(zip64Com('K3241.K03200Y0.D61010.ESTABELE', conteudo));
    }) as typeof fetch;
    const info = await lerArquivoDoCnpj(enderecoDoArquivo('2026-10', 0), contagem, { buscar, aoAvancar: (b) => void avancos.push(b) });
    expect(info).toMatchObject({ tamanho: conteudo.length, metodo: 8 });
    expect(pedidos).toEqual([`${PASTA_DO_CNPJ}2026-10/Estabelecimentos0.zip`]);
    expect(avancos.at(-1)).toBe(conteudo.length);
    expect(contagem.estatistica.ativos).toBe(5);
    await expect(lerArquivoDoCnpj('https://exemplo.invalid/Estabelecimentos0.zip', contagem, { buscar })).rejects.toThrow('fora da Receita');
  });

  it('o arquivo que para no meio cai pelo vigia; o que chega cortado ou com tamanho diferente é recusado', async () => {
    const conteudo = Buffer.from(`${linhas.join('\n')}\n`.repeat(40), 'latin1');
    const zip = zip64Com('a.csv', conteudo);
    const parado = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(zip.subarray(0, 60));
          },
        }),
      )) as unknown as typeof fetch;
    await expect(lerArquivoDoCnpj(enderecoDoArquivo('2026-10', 1), new ContagemDoCnpj(desde, municipioDe, bairroDe), { buscar: parado, paradoMs: 50 })).rejects.toThrow('parou de mandar');
    const cortado = (async () => new Response(zip.subarray(0, zip.length - 20))) as unknown as typeof fetch;
    await expect(lerArquivoDoCnpj(enderecoDoArquivo('2026-10', 1), new ContagemDoCnpj(desde, municipioDe, bairroDe), { buscar: cortado })).rejects.toThrow();
    const mentiroso = Buffer.from(zip);
    mentiroso.writeBigUInt64LE(BigInt(conteudo.length + 1), 30 + 5 + 4);
    const errado = (async () => new Response(mentiroso)) as unknown as typeof fetch;
    await expect(lerArquivoDoCnpj(enderecoDoArquivo('2026-10', 1), new ContagemDoCnpj(desde, municipioDe, bairroDe), { buscar: errado })).rejects.toThrow('tamanho descompactado');
    const recusa = (async () => new Response('não', { status: 404 })) as unknown as typeof fetch;
    await expect(lerArquivoDoCnpj(enderecoDoArquivo('2026-10', 1), new ContagemDoCnpj(desde, municipioDe, bairroDe), { buscar: recusa })).rejects.toThrow('a Receita respondeu 404');
  });
});

describe('os restaurantes no retrato da loja', () => {
  const l = (area_kind: string, area_key: string, v: number[]): ContagemGuardada => ({
    area_kind,
    area_key,
    period: '2026-10',
    active: v[0]!,
    active_restaurant: v[1]!,
    active_snack: v[2]!,
    active_bar: v[3]!,
    active_home: v[4]!,
    opened_12m: String(v[5]),
    closed_12m: String(v[6]),
  });
  const linhas = [l('municipio', '', [30000, 12000, 9000, 6000, 3000, 4000, 2500]), l('bairro', `${RIO}030`, [800, 300, 250, 200, 50, 90, 60]), l('bairro', `${RIO}031`, [200, 80, 70, 30, 20, 20, 10]), l('cep', '20520', [120, 50, 40, 20, 10, 15, 8])];

  it('município com cobertura e por 10 mil, bairro por km², a área do CEP e as áreas de entrega sem repetir', () => {
    const r = restaurantesDoRetrato({
      linhas,
      bairro: { codigo: `${RIO}030`, areaKm2: 9.9413 },
      prefixoDoCep: '20520',
      bairrosDaEntrega: [`${RIO}030`, `${RIO}031`, `${RIO}031`],
      ativosComBairro: 21000,
      populacao: 6731133,
    });
    expect(r).toEqual({
      period: '2026-10',
      since: '2025-10',
      city: { active: 30000, restaurant: 12000, snack: 9000, bar: 6000, home: 3000, opened_12m: 4000, closed_12m: 2500, per_10k: 44.6, district_coverage_pct: 70 },
      district: { active: 800, restaurant: 300, snack: 250, bar: 200, home: 50, opened_12m: 90, closed_12m: 60, per_km2: 80.5 },
      postal: { active: 120, restaurant: 50, snack: 40, bar: 20, home: 10, opened_12m: 15, closed_12m: 8, prefix: '20520' },
      delivery_area: { active: 1000, restaurant: 380, snack: 320, bar: 230, home: 70, opened_12m: 110, closed_12m: 70, matched: 2 },
    });
  });

  it('sem o mês lido é nulo; bairro e CEP sem linha valem zero; sem bairro, sem CEP e sem entrega, nulos', () => {
    expect(restaurantesDoRetrato({ linhas: [], bairro: null, prefixoDoCep: null, bairrosDaEntrega: [], ativosComBairro: 0, populacao: null })).toBeNull();
    const r = restaurantesDoRetrato({ linhas: [linhas[0]!], bairro: { codigo: `${RIO}099`, areaKm2: null }, prefixoDoCep: '99999', bairrosDaEntrega: [], ativosComBairro: 0, populacao: null });
    expect(r?.district).toEqual({ active: 0, restaurant: 0, snack: 0, bar: 0, home: 0, opened_12m: 0, closed_12m: 0, per_km2: null });
    expect(r?.postal?.active).toBe(0);
    expect(r?.delivery_area).toBeNull();
    expect(r?.city).toMatchObject({ per_10k: null, district_coverage_pct: 0 });
    expect(restaurantesDoRetrato({ linhas: [linhas[0]!], bairro: null, prefixoDoCep: null, bairrosDaEntrega: [], ativosComBairro: 0, populacao: 1 })).toMatchObject({ district: null, postal: null });
  });

  it('a leitura do CNPJ (horas na primeira vez) não segura o retrato', () => {
    const f = (source: string, status: string) => ({ source, status, read_at: null, next_try_at: null });
    expect(situacaoDoRetrato([f('ibge_4714', 'em_dia'), f('receita_cnpj', 'lendo')])).toBe('pronto');
    expect(situacaoDoRetrato([f('ibge_4714', 'em_dia'), f('receita_cnpj', 'falhou')])).toBe('pronto');
    expect(situacaoDoRetrato([f('ibge_4714', 'lendo'), f('receita_cnpj', 'em_dia')])).toBe('lendo');
  });
});
