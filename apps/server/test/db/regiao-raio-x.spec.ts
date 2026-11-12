import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARQUIVO_BASICO, ARQUIVO_RENDA } from '../../src/regiao/censo.js';
import { ENDERECO_DOS_MUNICIPIOS_DO_IBGE, HOST_DA_RECEITA, PASTA_DO_CNPJ } from '../../src/regiao/cnpj.js';
import { RegiaoCnpjService } from '../../src/worker/regiao-cnpj.service.js';
import { RegiaoFontesService } from '../../src/worker/regiao-fontes.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { zip64Com, zipCom } from '../helpers/zip-de-mentira.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// Plano da região, R2, parte 1 (Sua região; migration 0137), contra Postgres, com o IBGE simulado (nada sai para a
// internet): a rotina importa os bairros do Censo uma vez e lê as tabelas do município da loja no mapa; a rota "Sua
// região" monta o retrato (o bairro, a posição da renda entre os bairros, a gente das áreas de entrega, o município);
// a falha de uma fonte aparece como "falhou", com a próxima tentativa; a empresa só lê as tabelas do sistema. As
// tabelas são do produto (sem empresa): o teste limpa no começo e no fim.

const RIO = '3304557';
// A rotina lê o município de TODAS as lojas no mapa do banco (o de teste é dividido com as outras suítes): a loja da
// falha usa um código novo a cada rodada, para a leitura dele nunca estar em dia de uma rodada anterior.
const SP = `35${String(Date.now() % 100_000).padStart(5, '0')}`;

function arquivoBasico(): Buffer {
  const linhas = ['"CD_BAIRRO";"NM_BAIRRO";"CD_MUN";"NM_MUN";"AREA_KM2";"v0001";"v0002"'];
  linhas.push(`"${RIO}030";"Tijuca";"${RIO}";"Rio de Janeiro";"9,9413";"142909";"61200"`);
  linhas.push(`"${RIO}031";"Maracanã";"${RIO}";"Rio de Janeiro";"1,6";"25000";"9000"`);
  linhas.push(`"${RIO}032";"Grajaú";"${RIO}";"Rio de Janeiro";"5";"38000";"14000"`);
  // A sanidade da rotina pede mais de mil bairros (o arquivo de verdade tem 17,5 mil).
  for (let m = 0; m < 2; m++) for (let i = 0; i < 600; i++) linhas.push(`"999999${m}${String(i).padStart(3, '0')}";"Bairro ${i}";"999999${m}";"Cidade";"1";"100";"40"`);
  return zipCom([{ nome: 'Agregados_por_bairros_basico_BR.csv', conteudo: Buffer.from(linhas.join('\r\n'), 'latin1') }]);
}

function arquivoRenda(): Buffer {
  const linhas = ['"CD_BAIRRO";"NM_BAIRRO";"V06004";"V06006"', `"${RIO}030";"Tijuca";"8056,52";"5500"`, `"${RIO}031";"Maracanã";"5000";"4000"`, `"${RIO}032";"Grajaú";"4000";"3000"`];
  return zipCom([{ nome: 'Agregados_por_bairros_renda_responsavel_BR.csv', conteudo: Buffer.from(linhas.join('\n'), 'latin1') }]);
}

/**
 * As fontes simuladas: as tabelas do IBGE (pela tabela e pelo recorte no endereço), a lista das RMs do IBGE (a do Rio com
 * a capital) e o Pix do Banco Central (out/2025, out/2026 e o mês corrente, parcial); `falhar` lista as tabelas que
 * respondem 500.
 */
function ibgeDeMentira(falhar: Set<string>, pedidos: string[]): typeof fetch {
  const serie = (id: string, lugar: string, valores: Record<string, string>, categoria?: string) => ({
    id,
    resultados: [{ classificacoes: categoria ? [{ categoria: { [categoria]: 'x' } }] : [], series: [{ localidade: { id: lugar }, serie: valores }] }],
  });
  const json = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } });
  return (async (entrada: string | URL | Request) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    pedidos.push(url);
    if (url === ARQUIVO_BASICO) return new Response(arquivoBasico(), { status: 200 });
    if (url === ARQUIVO_RENDA) return new Response(arquivoRenda(), { status: 200 });
    if (url.includes('/localidades/regioes-metropolitanas')) return json([{ id: '03301', municipios: [{ id: Number(RIO) }, { id: 3303302 }] }]);
    if (url.includes('olinda.bcb.gov.br')) {
      const mun = Number(/Municipio_Ibge%20eq%20([0-9]{7})/.exec(url)?.[1] ?? '0');
      const linha = (AnoMes: number, pessoas: number, valor: number) => ({ AnoMes, Municipio_Ibge: mun, VL_PagadorPF: valor, QT_PES_PagadorPF: pessoas });
      return json({ value: [linha(202510, 4900000, 40000000000), linha(202610, 5109806, 44244787453.94), linha(202611, 4817947, 17335615315.87)] });
    }
    const tabela = /agregados\/([0-9]+)\//.exec(url)?.[1] ?? '';
    const decod = decodeURIComponent(url);
    const lugar = /N1\[all\]/.test(decod) ? '1' : (/N[367]\[([0-9]+)\]/.exec(decod)?.[1] ?? '');
    if (falhar.has(tabela)) return new Response('erro', { status: 500 });
    const ipca12 = (fora: string, refeicao: string, lanche: string) => [
      { id: '2265', resultados: [serie('2265', lugar, { '202609': fora }, '7432').resultados[0], serie('2265', lugar, { '202609': refeicao }, '7434').resultados[0], serie('2265', lugar, { '202609': lanche }, '7435').resultados[0]] },
    ];
    const corpo =
      tabela === '4714'
        ? [serie('93', lugar, { '2022': '6211223' }), serie('614', lugar, { '2022': '5174.60' })]
        : tabela === '6579'
          ? [serie('9324', lugar, { '2026': '6731133' })]
          : tabela === '10295'
            ? [serie('13431', lugar, { '2022': '2515.32' }), serie('13534', lugar, { '2022': '1212.00' })]
            : tabela === '9528'
              ? [serie('706', lugar, { '2024': '16242' }, '117551')]
              : tabela === '1737'
                ? [serie('2266', lugar, decod.includes('periodos/202207/') ? { '202207': '6411.95' } : { '202609': '7695.82' })]
                : tabela === '7531'
                  ? [serie('10824', lugar, { '2025': '2732' }, '49243')]
                  : tabela === '7395'
                    ? [serie('4196', lugar, { '2025': '2972' })]
                    : tabela === '6472'
                      ? [serie('5933', lugar, { '202503': '5907', '202504': '5844', '202601': '5791', '202602': '5227' })]
                      : tabela === '7060'
                        ? lugar === '1'
                          ? ipca12('5.79', '5.01', '7.59')
                          : ipca12('4.31', '2.66', '7.75')
                        : [];
    return json(corpo);
  }) as typeof fetch;
}

/** Uma linha do arquivo de estabelecimentos da Receita (30 colunas; os dados da pessoa são de mentira). */
function linhaDoCnpj(o: { situacao?: string; dataSituacao?: string; inicio?: string; cnae?: string; bairro: string; cep: string }): string {
  const c: string[] = Array.from({ length: 30 }, () => '');
  [c[0], c[1], c[2], c[3], c[4]] = ['12345678', '0001', '00', '1', 'NOME DE MENTIRA'];
  c[5] = o.situacao ?? '02';
  c[6] = o.dataSituacao ?? '20200101';
  c[10] = o.inicio ?? '20150101';
  c[11] = o.cnae ?? '5611201';
  c[14] = 'RUA DE MENTIRA';
  [c[17], c[18], c[19], c[20]] = [o.bairro, o.cep, 'RJ', '6001'];
  c[27] = 'contato@exemplo.invalid';
  return c.map((v) => `"${v}"`).join(';');
}

/**
 * A Receita simulada (R2, parte 4): a pasta WebDAV com os meses pedidos (todos inteiros), o arquivo de municípios, a lista
 * de municípios do IBGE e os 10 arquivos de cada mês (`partes[mes][n]` = as linhas do arquivo n); `falhar` lista os
 * arquivos ("2026-11/3") que respondem 500 uma vez.
 */
function receitaDeMentira(partes: Record<string, string[][]>, falhar: Set<string>, pedidos: string[]): typeof fetch {
  const raiz = new URL(PASTA_DO_CNPJ).pathname;
  const xml = (itens: Array<{ href: string; tamanho?: number }>) =>
    `<d:multistatus xmlns:d="DAV:">${itens.map((i) => `<d:response><d:href>${i.href}</d:href><d:propstat><d:prop>${i.tamanho === undefined ? '' : `<d:getcontentlength>${i.tamanho}</d:getcontentlength>`}</d:prop></d:propstat></d:response>`).join('')}</d:multistatus>`;
  return (async (entrada: string | URL | Request) => {
    const url = String(entrada instanceof Request ? entrada.url : entrada);
    pedidos.push(url);
    if (url === ENDERECO_DOS_MUNICIPIOS_DO_IBGE) {
      const lista = Array.from({ length: 5000 }, (_, i) => ({ 'municipio-id': 1_100_000 + i, 'municipio-nome': `Cidade ${i}`, 'UF-sigla': 'RO' }));
      lista.push({ 'municipio-id': Number(RIO), 'municipio-nome': 'Rio de Janeiro', 'UF-sigla': 'RJ' });
      return new Response(JSON.stringify(lista), { status: 200 });
    }
    if (url === PASTA_DO_CNPJ) return new Response(xml([{ href: raiz }, ...Object.keys(partes).map((m) => ({ href: `${raiz}${m}/` }))]), { status: 207 });
    const [mes, arquivo] = url.slice(PASTA_DO_CNPJ.length).split('/') as [string, string];
    if (!arquivo) {
      return new Response(xml([{ href: `${raiz}${mes}/Municipios.zip`, tamanho: 43443 }, ...Array.from({ length: 10 }, (_, i) => ({ href: `${raiz}${mes}/Estabelecimentos${i}.zip`, tamanho: 1000 }))]), { status: 207 });
    }
    if (arquivo === 'Municipios.zip') {
      const linhas = ['"6001";"RIO DE JANEIRO"', ...Array.from({ length: 5000 }, (_, i) => `"${String(i + 1).padStart(4, '0')}";"CIDADE ${i}"`)];
      return new Response(zipCom([{ nome: 'F.K03200$Z.D61010.MUNICCSV', conteudo: Buffer.from(linhas.join('\n'), 'latin1') }]));
    }
    const n = Number(arquivo.replace('Estabelecimentos', '').replace('.zip', ''));
    if (falhar.delete(`${mes}/${n}`)) return new Response('erro', { status: 500 });
    return new Response(zip64Com('K3241.ESTABELE', Buffer.from(`${(partes[mes]?.[n] ?? []).join('\n')}\n`, 'latin1')));
  }) as typeof fetch;
}

const limpar = async () => {
  await ownerQuery(`delete from liame.region_food_part`);
  await ownerQuery(`delete from liame.region_food_count`);
  await ownerQuery(`delete from liame.region_source_read`);
  await ownerQuery(`delete from liame.region_fact`);
  await ownerQuery(`delete from liame.region_district`);
};

describe.skipIf(!hasDb)('Sua região: a rotina das fontes públicas e o retrato da loja (plano da região, R2, parte 1)', () => {
  let api: TestApi;
  let database: Database;
  let rotina: RegiaoFontesService;
  let cookie: string;
  let tenantId: string;
  let userId: string;
  let brandId: string;
  const tijuca = randomUUID();
  const paulista = randomUUID();
  const agora = new Date('2026-11-11T15:00:00Z');

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await limpar();
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    rotina = new RegiaoFontesService(database);
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Sua região');
    cookie = s.cookie;
    await enableMfa(api, cookie);
    tenantId = s.me.active_organization_id as string;
    userId = s.me.user.id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_street, address_number, address_district, address_city, address_state,
                               ibge_city_code, latitude, longitude, location_precision, location_source, delivery_radius_km, delivery_areas)
       values ($1, $2, $3, 'Loja Tijuca', '20520054', 'Rua Conde de Bonfim', '450', 'Tijuca', 'Rio de Janeiro', 'RJ', $4, -22.9244, -43.2327, 'endereco', 'cep', 3,
               '["Tijuca", "Maracana", "Bairro Inventado"]'::jsonb)`,
      [tijuca, tenantId, brandId, RIO],
    );
    await ligarFlagDaEmpresa(api, 'regiao', tenantId, true);
  }, 120_000);

  afterAll(async () => {
    await ligarFlagDaEmpresa(api, 'regiao', tenantId, false);
    await ownerQuery(`delete from liame.unit where id = any($1::uuid[])`, [[tijuca, paulista]]);
    await limpar();
    await api?.close();
  });

  const retrato = (unitId: string) => api.call('GET', `/v1/region/overview?brand_id=${brandId}&unit_id=${unitId}`, { cookie });

  it('antes da rotina, o retrato está "lendo"; depois, pronto: o bairro, a renda entre os bairros, a área de entrega e o município', async () => {
    const antes = await retrato(tijuca);
    expect(antes.status, JSON.stringify(antes.body)).toBe(200);
    expect(antes.body).toMatchObject({ status: 'lendo', district_status: 'lendo', district: null });

    const pedidos: string[] = [];
    // Outras suítes põem lojas no mapa no mesmo banco: a volta pode ler outros municípios também (o lote cobre todos).
    const feitas = (await rotina.executarLote(50, agora, ibgeDeMentira(new Set(), pedidos))).filter((f) => [RIO, '0', '33', '3301', '1'].includes(f.lugar));
    expect(feitas.map((f) => `${f.fonte}:${f.lugar}:${f.situacao}`).sort()).toEqual(
      [
        'ibge_censo_bairro:0:lida',
        `ibge_rm:${RIO}:lida`,
        `ibge_10295:${RIO}:lida`,
        `ibge_4714:${RIO}:lida`,
        `ibge_6579:${RIO}:lida`,
        `ibge_9528:${RIO}:lida`,
        // O Rio é capital: a renda do trabalho da PNAD trimestral.
        `ibge_6472:${RIO}:lida`,
        `bcb_pix:${RIO}:lida`,
        // A UF, a RM do Rio (resolvida na mesma volta) e o Brasil.
        'ibge_7531:33:lida',
        'ibge_7395:3301:lida',
        'ibge_7060:3301:lida',
        'ibge_1737_censo:1:lida',
        'ibge_1737:1:lida',
        'ibge_7060_brasil:1:lida',
      ].sort(),
    );
    // As fontes recebem só códigos de lugar (e os arquivos do Censo): nada da loja.
    expect(pedidos.every((u) => u.startsWith('https://ftp.ibge.gov.br/') || u.startsWith('https://servicodados.ibge.gov.br/') || u.startsWith('https://olinda.bcb.gov.br/'))).toBe(true);
    expect(pedidos.some((u) => u.includes('20520054') || u.includes('Conde'))).toBe(false);

    const r = await retrato(tijuca);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      availability: { status: 'disponivel' },
      status: 'pronto',
      district_status: 'achado',
      district: { code: `${RIO}030`, name: 'Tijuca', population: 142909, area_km2: 9.9413, density: 14375.3, head_income_median: 5500, head_income_mean: 8056.52 },
      // Tijuca (5.500) fica acima dos outros dois bairros do Rio com renda (4.000 e 3.000): 66%; a mediana deles é 4.000.
      delivery_area: { matched: 2, total: 3, population: 167909 },
      city: {
        code: RIO,
        name: 'Rio de Janeiro',
        population: { value: 6211223, period: '2022', source: 'ibge_4714' },
        population_estimate: { value: 6731133, period: '2026', source: 'ibge_6579' },
        income_pc_median: { value: 1212, period: '2022', source: 'ibge_10295' },
        restaurants: { value: 16242, period: '2024', source: 'ibge_9528' },
        restaurants_per_10k: 24.1,
      },
    });
    expect(r.body.district.income_rank).toEqual({ above_pct: 66, districts: 3, typical_median: 4000 });
    // O CNPJ da Receita (parte 4) ainda não foi lido: a Concorrência fica "lendo" e o resto do retrato já está pronto.
    expect(r.body.sources.filter((f: { source: string }) => f.source !== 'receita_cnpj').every((f: { status: string }) => f.status === 'em_dia')).toBe(true);
    expect(r.body.sources.find((f: { source: string }) => f.source === 'receita_cnpj')).toMatchObject({ status: 'lendo' });
    expect(r.body.food_places).toBeNull();
    // Os números mais novos que o Censo (parte 3): a renda do bairro corrigida pelo IPCA (7.695,82 ÷ 6.411,95 = 1,2002),
    // a renda da PNAD na UF e na RM, a média dos 4 trimestres da capital, o Pix (out/2026 × out/2025; o mês corrente,
    // parcial, fica de fora) e a inflação de comer fora na RM e no Brasil.
    expect(r.body.ipca).toEqual({ from: '2022-07', to: '2026-09', factor: 1.2002 });
    expect(r.body.district).toMatchObject({ head_income_median_today: 6601, head_income_mean_today: 9669 });
    expect(r.body.city).toMatchObject({
      rm_code: '3301',
      income_pc_uf: { value: 2732, period: '2025', source: 'ibge_7531' },
      income_pc_rm: { value: 2972, period: '2025', source: 'ibge_7395' },
      work_income_capital: { value: 5692, period: '2026-06', quarters: 4, source: 'ibge_6472' },
      pix: { period: '2026-10', payers: 5109806, value: 44244787453.94, payers_prev_year: 4900000, value_prev_year: 40000000000 },
      food_away_inflation: { scope: 'rm', period: '2026-09', away: 4.31, meal: 2.66, snack: 7.75, brasil: { away: 5.79, meal: 5.01, snack: 7.59 } },
    });

    // A volta seguinte não lê de novo o que está em dia (nem o Censo, que entra uma vez).
    expect((await rotina.executarLote(50, new Date(agora.getTime() + 60_000), ibgeDeMentira(new Set(), []))).filter((f) => f.lugar === RIO || f.lugar === '0')).toEqual([]);
  });

  it('os restaurantes do CNPJ (parte 4): um arquivo por volta, o mês somado no fim, a falha e o mês com defeito', async () => {
    const cnpj = new RegiaoCnpjService(database);
    const tijucaRest = linhaDoCnpj({ bairro: 'TIJUCA', cep: '20520054' });
    const maracanaLanche = linhaDoCnpj({ cnae: '5611203', bairro: 'MARACANA', cep: '20271110' });
    const tijucaBarNovo = linhaDoCnpj({ cnae: '5611204', bairro: 'Tijuca', cep: '20520100', inicio: '20260301' });
    const grajauCasa = linhaDoCnpj({ cnae: '5620104', bairro: 'GRAJAÚ', cep: '20561000' });
    const tijucaBaixado = linhaDoCnpj({ situacao: '08', dataSituacao: '20260601', bairro: 'TIJUCA', cep: '20520054' });
    const semBairro = linhaDoCnpj({ bairro: 'BAIRRO QUE O CENSO NAO TEM', cep: '21000000' });
    const outubro = [[tijucaRest, maracanaLanche], [tijucaBarNovo], [grajauCasa], [tijucaBaixado], ...Array.from({ length: 6 }, () => [semBairro])];
    const pedidos: string[] = [];
    const falhar = new Set<string>(['2026-10/4']);
    let t = agora.getTime();
    const volta = (meses: Record<string, string[][]>) => cnpj.executar(new Date((t += 61 * 60_000)), receitaDeMentira(meses, falhar, pedidos));

    // Um arquivo por volta; o 5º responde 500 uma vez (a próxima tentativa fica para 1 hora depois) e é lido de novo.
    const situacoes: string[] = [];
    for (let i = 0; i < 11; i++) situacoes.push((await volta({ '2026-10': outubro })).situacao);
    expect(situacoes).toEqual(['arquivo_lido', 'arquivo_lido', 'arquivo_lido', 'arquivo_lido', 'falhou', 'arquivo_lido', 'arquivo_lido', 'arquivo_lido', 'arquivo_lido', 'arquivo_lido', 'retrato_trocado']);
    expect((await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.region_food_part`))[0]!.n).toBe(0);
    // A Receita e o IBGE recebem só os pedidos dos arquivos públicos: nada da loja.
    expect(pedidos.every((u) => new URL(u).host === HOST_DA_RECEITA || u === ENDERECO_DOS_MUNICIPIOS_DO_IBGE)).toBe(true);
    expect(pedidos.some((u) => u.includes('20520') || u.includes('Conde') || u.includes('Tijuca'))).toBe(false);
    // Só contagens no banco: nenhum nome, rua, e-mail ou CNPJ.
    expect(JSON.stringify(await ownerQuery(`select * from liame.region_food_count`))).not.toMatch(/MENTIRA|exemplo|12345678/);

    const r = await retrato(tijuca);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('pronto');
    expect(r.body.sources.find((f: { source: string }) => f.source === 'receita_cnpj')).toMatchObject({ status: 'em_dia' });
    // Rio: 10 ativos (7 restaurantes, 1 lanchonete, 1 bar, 1 para casa), 1 aberto e 1 baixado em 12 meses; 4 dos 10 com bairro do Censo.
    expect(r.body.food_places).toEqual({
      period: '2026-10',
      since: '2025-10',
      city: { active: 10, restaurant: 7, snack: 1, bar: 1, home: 1, opened_12m: 1, closed_12m: 1, per_10k: 0, district_coverage_pct: 40 },
      district: { active: 2, restaurant: 1, snack: 0, bar: 1, home: 0, opened_12m: 1, closed_12m: 1, per_km2: 0.2 },
      postal: { active: 2, restaurant: 1, snack: 0, bar: 1, home: 0, opened_12m: 1, closed_12m: 1, prefix: '20520' },
      // As áreas de entrega que casaram: Tijuca e Maracanã ("Bairro Inventado" não casa).
      delivery_area: { active: 3, restaurant: 1, snack: 1, bar: 1, home: 0, opened_12m: 1, closed_12m: 1, matched: 2 },
    });

    // O mês em dia: a volta seguinte (depois das 12 horas) só confere a pasta.
    t += 12 * 60 * 60_000;
    expect((await volta({ '2026-10': outubro })).situacao).toBe('em_dia');

    // Um mês novo com quase nada ativo (arquivo da Receita com defeito) não troca o retrato.
    t += 12 * 60 * 60_000;
    const novembro = [[tijucaRest], ...Array.from({ length: 9 }, () => [tijucaBaixado])];
    const deNovembro: string[] = [];
    for (let i = 0; i < 10; i++) deNovembro.push((await volta({ '2026-10': outubro, '2026-11': novembro })).situacao);
    expect(deNovembro.slice(0, 9).every((s) => s === 'arquivo_lido')).toBe(true);
    expect(deNovembro[9]).toBe('falhou');
    const leitura = (await ownerQuery<{ last_error: string }>(`select last_error from liame.region_source_read where source = 'receita_cnpj' and geo_code = '0'`))[0]!;
    expect(leitura.last_error).toContain('menos de 80%');
    expect((await retrato(tijuca)).body.food_places).toMatchObject({ period: '2026-10', city: { active: 10 } });

    // A empresa lê as contagens, mas não grava.
    const quem = { tenantId, userId };
    await expect(
      withContext(database.db, quem, (tx) =>
        tx.execute(sql`insert into liame.region_food_count (geo_code, area_kind, area_key, period, active, active_restaurant, active_snack, active_bar, active_home, opened_12m, closed_12m)
                       values ('3304557', 'cep', '99999', '2026-10', 1, 1, 0, 0, 0, 0, 0)`),
      ),
    ).rejects.toThrow();
    await ownerQuery(`delete from liame.region_food_part`);
  });

  it('a fonte que falha aparece como "falhou", com a próxima tentativa em 1 hora; o resto vale', async () => {
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_district, address_city, address_state, ibge_city_code, location_source, delivery_radius_km)
       values ($1, $2, $3, 'Loja Paulista', '01310100', 'Bela Vista', 'São Paulo', 'SP', $4, 'cep', 3)`,
      [paulista, tenantId, brandId, SP],
    );
    const feitas = await rotina.executarLote(50, agora, ibgeDeMentira(new Set(['4714']), []));
    expect(feitas.find((f) => f.fonte === 'ibge_4714' && f.lugar === SP)).toMatchObject({ situacao: 'falhou', motivo: 'o IBGE respondeu 500' });
    const r = await retrato(paulista);
    expect(r.body).toMatchObject({ status: 'parcial', district_status: 'nao_achado', district: null, city: { population: null, restaurants: { value: 16242 } } });
    // Fora da capital e fora de RM da PNAD: sem a renda da capital e da RM; a da UF vale; a inflação de comer fora é a do Brasil.
    expect(feitas.some((f) => f.fonte === 'ibge_6472' && f.lugar === SP)).toBe(false);
    expect(r.body.city).toMatchObject({ rm_code: null, income_pc_rm: null, work_income_capital: null, income_pc_uf: { value: 2732, period: '2025' } });
    expect(r.body.city.food_away_inflation).toMatchObject({ scope: 'brasil', away: 5.79, brasil: null });
    expect(r.body.sources.find((f: { source: string }) => f.source === 'ibge_4714')).toEqual({ source: 'ibge_4714', status: 'falhou', read_at: null, next_try_at: '2026-11-11T16:00:00.000Z' });
  });

  it('a empresa só lê as tabelas do sistema; a função desligada e a loja sem endereço', async () => {
    const quem = { tenantId, userId };
    await expect(
      withContext(database.db, quem, (tx) => tx.execute(sql`insert into liame.region_fact (geo_level, geo_code, indicator, period, value, source) values ('municipio', '3304557', 'teste', '2026', 1, 'ibge_4714')`)),
    ).rejects.toThrow();
    const lidas = await withContext(database.db, quem, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from liame.region_district where city_code = ${RIO}`));
    expect(lidas.rows[0]!.n).toBe(3);

    const semEndereco = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Sem Endereço')`, [semEndereco, tenantId, brandId]);
    expect((await retrato(semEndereco)).body).toMatchObject({ status: 'sem_endereco', city: null });
    expect((await retrato(randomUUID())).status).toBe(404);

    await ligarFlagDaEmpresa(api, 'regiao', tenantId, false);
    expect((await retrato(tijuca)).body).toMatchObject({ availability: { status: 'desligado_pela_liame' }, sources: [] });
    await ligarFlagDaEmpresa(api, 'regiao', tenantId, true);
  });
});
