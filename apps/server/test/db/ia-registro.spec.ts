import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { funcionarioAtivo } from '../../src/ai/registro/ativacao.js';
import type { FerramentaDef, FuncionarioDef, PromptDef, Registro, Trava } from '../../src/ai/registro/definicoes.js';
import { FerramentasDeLeitura } from '../../src/ai/registro/leituras.js';
import { DATABASE } from '../../src/database/database.module.js';
import { AtencaoCicloService } from '../../src/results/atencao-ciclo.service.js';
import { RegistroIaService } from '../../src/worker/registro-ia.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

describe.skipIf(!hasDb)('registros da IA no banco, ativação por empresa e ferramentas de leitura (A3, I2)', () => {
  const RODADA = `teste_${randomBytes(4).toString('hex')}`;
  let api: TestApi;
  let database: Database;
  let registro: RegistroIaService;
  let leituras: FerramentasDeLeitura;

  async function dono(company = 'Empresa dos Registros') {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    const marcas = await api.call('GET', '/v1/brands', { cookie: s.cookie });
    return { cookie: s.cookie, tenantId: s.me.active_organization_id as string, userId: s.me.user.id as string, brandId: marcas.body.items[0].id as string };
  }
  const ferramenta = (extra: Partial<FerramentaDef> = {}): FerramentaDef => ({
    name: `${RODADA}_ferramenta`,
    version: 1,
    description: 'Ferramenta só deste teste.',
    risk: 'R0',
    permission: 'vendas.ver',
    owner: 'testes',
    input: z.strictObject({ brand_id: z.uuid().optional() }),
    ...extra,
  });
  const prompt = (extra: Partial<PromptDef> = {}): PromptDef => ({ key: `${RODADA}.explicar`, version: 1, task: `${RODADA}_explicar`, content: 'Explique com os números recebidos.', ...extra });
  const funcionario = (extra: Partial<FuncionarioDef> = {}): FuncionarioDef => ({
    key: `${RODADA}_analista`,
    version: 1,
    name: 'Analista de teste',
    cargo: 'Analista de resultados',
    responsabilidades: ['Explicar os números'],
    ferramentas: [`${RODADA}_ferramenta`],
    tarefas: [{ task: `${RODADA}_explicar`, prompt: `${RODADA}.explicar` }],
    ativoPorPadrao: true,
    ...extra,
  });
  const so = (parte: Partial<Registro>): Registro => ({ ferramentas: [], prompts: [], funcionarios: [], ...parte });
  const versoes = (tabela: 'tool_registry' | 'prompt_version' | 'agent_definition', coluna: 'name' | 'key', nome: string) =>
    ownerQuery<{ version: number; status: string; aposentada: boolean; content_hash: string }>(
      `select version, status, retired_at is not null as aposentada, content_hash from liame.${tabela} where ${coluna} = $1 order by version`,
      [nome],
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    registro = new RegistroIaService(database);
    leituras = api.app.get(FerramentasDeLeitura);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await ownerQuery(`delete from liame.tool_registry where name like $1`, [`${RODADA}%`]);
    await ownerQuery(`delete from liame.prompt_version where key like $1`, [`${RODADA}%`]);
    await ownerQuery(`delete from liame.agent_definition where key like $1`, [`${RODADA}%`]);
    await api?.close();
  });

  it('a subida grava as versões que o código traz, iguais às da trava; rodar de novo não muda nada', async () => {
    await registro.registrar();
    expect(await registro.registrar()).toEqual({ novas: [], conflitos: [] });
    const trava = JSON.parse(readFileSync(resolve(process.cwd(), 'ia-registro.lock.json'), 'utf8')) as Trava;
    const ativas = await ownerQuery<{ name: string; version: number; content_hash: string; risk: string; permission: string | null; input_schema: { type: string } }>(
      `select name, version, content_hash, risk, permission, input_schema from liame.tool_registry where status = 'ativa' and name = any($1::text[]) order by name`,
      [Object.keys(trava.ferramentas)],
    );
    expect(Object.fromEntries(ativas.map((f) => [f.name, { version: f.version, hash: f.content_hash }]))).toEqual(trava.ferramentas);
    expect(ativas.find((f) => f.name === 'fontes_frescor')).toMatchObject({ risk: 'R0', permission: 'contas.ver', input_schema: { type: 'object' } });
    expect(ativas.find((f) => f.name === 'regem_cupom_criar')).toMatchObject({ risk: 'R1', permission: null });
  });

  it('versão nova aposenta a anterior; a mesma versão com outro conteúdo é recusada e nada é sobrescrito', async () => {
    const v1 = so({ ferramentas: [ferramenta()], prompts: [prompt()], funcionarios: [funcionario()] });
    expect((await registro.registrar(v1)).novas).toEqual([`tool_registry:${RODADA}_ferramenta@1`, `prompt_version:${RODADA}.explicar@1`, `agent_definition:${RODADA}_analista@1`]);

    // Conteúdo diferente com a mesma versão: é o que o teste da trava barra no PR; se chegar aqui, o registro não aceita.
    const adulterado = so({ ferramentas: [ferramenta({ description: 'Outra descrição, sem subir a versão.' })], prompts: [prompt({ content: 'Explique de outro jeito.' })] });
    expect(await registro.registrar(adulterado)).toEqual({ novas: [], conflitos: [`tool_registry:${RODADA}_ferramenta@1`, `prompt_version:${RODADA}.explicar@1`] });
    const [guardado] = await ownerQuery<{ content: string }>(`select content from liame.prompt_version where key = $1 and version = 1`, [`${RODADA}.explicar`]);
    expect(guardado!.content).toBe('Explique com os números recebidos.');

    const v2 = so({ ferramentas: [ferramenta({ version: 2, description: 'Descrição nova, com versão nova.' })], prompts: [prompt({ version: 2, content: 'Explique de outro jeito.' })], funcionarios: [funcionario({ version: 2, cargo: 'Analista sênior' })] });
    expect((await registro.registrar(v2)).novas).toHaveLength(3);
    for (const [tabela, coluna, nome] of [['tool_registry', 'name', `${RODADA}_ferramenta`], ['prompt_version', 'key', `${RODADA}.explicar`], ['agent_definition', 'key', `${RODADA}_analista`]] as const) {
      expect((await versoes(tabela, coluna, nome)).map((v) => [v.version, v.status, v.aposentada])).toEqual([[1, 'aposentada', true], [2, 'ativa', false]]);
    }
    const [def] = await ownerQuery<{ definition: Record<string, unknown> }>(`select definition from liame.agent_definition where key = $1 and version = 2`, [`${RODADA}_analista`]);
    expect(def!.definition).toMatchObject({ cargo: 'Analista sênior', ferramentas: [`${RODADA}_ferramenta`], ativo_por_padrao: true });

    // Código antigo subindo depois do novo (troca de versão em andamento): não derruba a versão ativa.
    expect(await registro.registrar(v1)).toEqual({ novas: [], conflitos: [] });
    expect((await versoes('tool_registry', 'name', `${RODADA}_ferramenta`)).map((v) => [v.version, v.status])).toEqual([[1, 'aposentada'], [2, 'ativa']]);
  });

  it('duas réplicas subindo juntas gravam a mesma versão uma vez só, e ela fica ativa', async () => {
    const nome = `${RODADA}_juntas`;
    await registro.registrar(so({ ferramentas: [ferramenta({ name: nome })] }));
    const v2 = so({ ferramentas: [ferramenta({ name: nome, version: 2, description: 'Versão que as duas réplicas trazem.' })] });
    const replicas = await Promise.all(Array.from({ length: 4 }, () => new RegistroIaService(database).registrar(v2)));
    expect(replicas.flatMap((r) => r.conflitos)).toEqual([]);
    expect((await versoes('tool_registry', 'name', nome)).map((v) => [v.version, v.status, v.aposentada])).toEqual([[1, 'aposentada', true], [2, 'ativa', false]]);
  });

  it('registro inconsistente não é gravado; a aplicação, no contexto de uma empresa, só lê os registros', async () => {
    await expect(registro.registrar(so({ funcionarios: [funcionario({ key: `${RODADA}_solto`, ferramentas: ['nao_existe'], tarefas: [] })] }))).rejects.toThrow('ferramenta desconhecida nao_existe');
    expect(await versoes('agent_definition', 'key', `${RODADA}_solto`)).toEqual([]);

    const d = await dono();
    const comoEmpresa = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext(database.db, { tenantId: d.tenantId, userId: d.userId }, fn);
    const lidas = await comoEmpresa((tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.tool_registry where status = 'ativa'`));
    expect(Number(lidas.rows[0]!.n)).toBeGreaterThanOrEqual(5);
    await expect(
      comoEmpresa((tx) => tx.execute(sql`update liame.tool_registry set description = 'trocada pela empresa, sem passar pelo registro' where name = 'fontes_frescor' returning name`)),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      comoEmpresa((tx) =>
        tx.execute(sql`insert into liame.prompt_version (key, version, status, task, content, content_hash) values (${`${RODADA}.invasor`}, 1, 'ativa', 'x_tarefa', 'x', ${'0'.repeat(64)})`),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  it('ativação: sem linha vale o padrão da definição; a linha da marca vale mais que a da empresa; a empresa não se ativa sozinha', async () => {
    const [a, b] = [await dono('Empresa A'), await dono('Empresa B')];
    const agentKey = `${RODADA}_analista`;
    const ativo = (quem: typeof a, brandId: string | null, ativoPorPadrao: boolean) =>
      withContext(database.db, { tenantId: quem.tenantId, userId: quem.userId }, (tx) => funcionarioAtivo(tx, { tenantId: quem.tenantId, brandId, agentKey, ativoPorPadrao }));
    expect([await ativo(a, null, true), await ativo(a, null, false), await ativo(a, a.brandId, true)]).toEqual([true, false, true]);

    await ownerQuery(`insert into liame.agent_activation (id, tenant_id, brand_id, agent_key, enabled, set_by, reason) values (gen_random_uuid(), $1, null, $2, false, 'testes', 'fora do plano')`, [a.tenantId, agentKey]);
    expect([await ativo(a, null, true), await ativo(a, a.brandId, true)]).toEqual([false, false]);
    await ownerQuery(`insert into liame.agent_activation (id, tenant_id, brand_id, agent_key, enabled, set_by) values (gen_random_uuid(), $1, $2, $3, true, 'testes')`, [a.tenantId, a.brandId, agentKey]);
    expect([await ativo(a, null, true), await ativo(a, a.brandId, true)]).toEqual([false, true]);
    // A decisão de A não muda B.
    expect(await ativo(b, null, true)).toBe(true);

    await expect(
      withContext(database.db, { tenantId: b.tenantId, userId: b.userId }, (tx) =>
        tx.execute(sql`insert into liame.agent_activation (id, tenant_id, agent_key, enabled, set_by) values (gen_random_uuid(), ${b.tenantId}, ${agentKey}, true, 'a propria empresa')`),
      ),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  it('A3-4: a ferramenta só existe para quem tem a permissão da rota, e lê só a empresa da pessoa', async () => {
    const [a, b] = [await dono('Empresa A'), await dono('Empresa B')];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
       values (gen_random_uuid(), $1, $2, 'meta_ads', 'act_' || $3, 'Conta só da A', 'BRL', 'America/Sao_Paulo')`,
      [a.tenantId, a.brandId, Math.floor(Math.random() * 1e9).toString()],
    );
    const de = (quem: typeof a, ...permissoes: string[]) => leituras.paraPedido({ tenantId: quem.tenantId, userId: quem.userId, permissions: new Set(permissoes) });
    const usar = async (lista: ReturnType<typeof de>, nome: string, input: unknown) => lista.find((f) => f.name === nome)!.executar(input);

    // Permissões: nenhuma, uma de cada, e a rotina do sistema (sem pessoa) com todas.
    expect(de(a).map((f) => f.name)).toEqual([]);
    expect(de(a, 'cupons.criar').map((f) => f.name)).toEqual([]);
    expect(de(a, 'contas.ver').map((f) => f.name)).toEqual(['fontes_frescor']);
    expect(de(a, 'campanhas.ver').map((f) => f.name)).toEqual(['atencao_avisos', 'midia_entrega']);
    expect(de(a, 'vendas.ver').map((f) => f.name)).toEqual(['resultados_ciclo_fechado', 'cupons_campanha', 'links_rastreio']);
    expect(leituras.paraPedido({ tenantId: a.tenantId, userId: null, permissions: 'sistema' }).map((f) => f.name)).toEqual([
      'fontes_frescor',
      'atencao_avisos',
      'resultados_ciclo_fechado',
      'midia_entrega',
      'cupons_campanha',
      'links_rastreio',
    ]);
    expect(leituras.paraPedido({ tenantId: a.tenantId, userId: null, permissions: 'sistema' }, ['atencao_avisos']).map((f) => f.name)).toEqual(['atencao_avisos']);

    // A lê a conta dela; B não vê a conta da A, nem pedindo a marca da A pelo id.
    const daA = await usar(de(a, 'contas.ver'), 'fontes_frescor', { brand_id: a.brandId });
    expect(daA).toMatchObject({ ok: true, valor: { fuso: 'America/Sao_Paulo', contas: [{ plataforma: 'Meta', conta: 'Conta só da A', dados: [{ conjunto: 'metricas', frescor: 'nunca leu' }] }] } });
    expect(await usar(de(b, 'contas.ver'), 'fontes_frescor', { brand_id: a.brandId })).toEqual({ ok: true, valor: { fuso: 'America/Sao_Paulo', contas: [] } });
    expect(await usar(de(b, 'contas.ver'), 'fontes_frescor', {})).toEqual({ ok: true, valor: { fuso: 'America/Sao_Paulo', contas: [] } });

    // Avisos: os de vendas só entram para quem tem `vendas.ver`, como na rota deles.
    const vendas = vi.spyOn(api.app.get(AtencaoCicloService), 'atencao');
    const soMidia = await usar(de(a, 'campanhas.ver'), 'atencao_avisos', { brand_id: a.brandId });
    expect(soMidia).toMatchObject({ ok: true, valor: { avisos: expect.any(Array) } });
    expect(vendas).not.toHaveBeenCalled();
    expect(await usar(de(a, 'campanhas.ver', 'vendas.ver'), 'atencao_avisos', { brand_id: a.brandId })).toMatchObject({ ok: true });
    expect(vendas).toHaveBeenCalledTimes(1);
    // Marca de outra empresa nos avisos de vendas: o erro de domínio vira um texto curto, sem dado da A.
    expect(await usar(de(b, 'campanhas.ver', 'vendas.ver'), 'atencao_avisos', { brand_id: a.brandId })).toEqual({ ok: false, erro: 'Marca não encontrada nesta empresa.' });
    vendas.mockRestore();

    // Parâmetro fora do formato não chega ao serviço.
    expect(await usar(de(a, 'contas.ver'), 'fontes_frescor', { brand_id: 'não é um id' })).toEqual({ ok: false, erro: 'Parâmetros inválidos para esta ferramenta.' });
    expect(await usar(de(a, 'contas.ver'), 'fontes_frescor', { brand_id: a.brandId, outro: 1 })).toEqual({ ok: false, erro: 'Parâmetros inválidos para esta ferramenta.' });
  });

  it('A3-4: entrega de mídia somada por campanha e por dia, com as razões calculadas pelo código; outra empresa não vê', async () => {
    const [a, b] = [await dono('Empresa A'), await dono('Empresa B')];
    const conta = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', 'act_' || $4, 'Conta da A', 'BRL', 'America/Sao_Paulo')`,
      [conta, a.tenantId, a.brandId, Math.floor(Math.random() * 1e9).toString()],
    );
    // Duas campanhas da Meta (lida por anúncio); a primeira com dois anúncios, que somam na campanha.
    const anuncios: Record<string, string> = {};
    for (const [campanha, nomes] of [['Delivery noite', ['Combo', 'Pizza grande']], ['Almoço executivo', ['Prato do dia']]] as const) {
      const [c, g] = [randomUUID(), randomUUID()];
      await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, $5, 'ativa')`, [c, a.tenantId, conta, `c_${c.slice(0, 8)}`, campanha]);
      await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, 'Grupo', 'ativa')`, [g, a.tenantId, conta, c, `g_${g.slice(0, 8)}`]);
      for (const nome of nomes) {
        const ad = randomUUID();
        anuncios[nome] = ad;
        await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, $6, 'ativa')`, [ad, a.tenantId, conta, g, `a_${ad.slice(0, 8)}`, nome]);
      }
    }
    const ponto = (anuncio: string, dia: string, metrica: string, valor: number, janela = '') =>
      ownerQuery(
        `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, observed_at, changed_at)
         values ($1, 'ad', $2, $3, $4, $5, $6, $7, 'meta_ads', $8, $9, $10, now(), now())`,
        [conta, `a_${anuncios[anuncio]!.slice(0, 8)}`, dia, metrica, janela, a.tenantId, a.brandId, anuncios[anuncio], valor, metrica === 'spend' ? 'BRL' : null],
      );
    await ponto('Combo', '2026-09-01', 'spend', 100.5);
    await ponto('Combo', '2026-09-01', 'impressions', 10_000);
    await ponto('Combo', '2026-09-01', 'clicks', 150);
    await ponto('Combo', '2026-09-01', 'link_clicks', 120);
    await ponto('Pizza grande', '2026-09-02', 'spend', 899.5);
    await ponto('Pizza grande', '2026-09-02', 'impressions', 90_000);
    await ponto('Pizza grande', '2026-09-02', 'clicks', 850);
    await ponto('Prato do dia', '2026-09-02', 'spend', 40);
    await ponto('Prato do dia', '2026-09-02', 'impressions', 1_234_567);
    // Fora do recorte: métrica com janela de atribuição e dia fora do período.
    await ponto('Combo', '2026-09-01', 'purchases', 9, '7d_click');
    await ponto('Combo', '2026-08-31', 'spend', 5000);

    const de = (quem: typeof a) => leituras.paraPedido({ tenantId: quem.tenantId, userId: quem.userId, permissions: new Set(['campanhas.ver']) }).find((f) => f.name === 'midia_entrega')!;
    expect(await de(a).executar({ brand_id: a.brandId, from: '2026-09-01', to: '2026-09-30' })).toEqual({
      ok: true,
      valor: {
        periodo: { de: '01/09/2026', ate: '30/09/2026' },
        campanhas: [
          // 1.000,00 ÷ 1.000 cliques = 1,00 por clique; 1.000 ÷ 100.000 impressões = 1,00%; 10,00 por mil impressões.
          { plataforma: 'Meta', campanha: 'Delivery noite', situacao: 'ativa', investimento: 'R$ 1.000,00', impressoes: '100.000', cliques: '1.000', cliques_no_link: '120', ctr: '1,00%', custo_por_clique: 'R$ 1,00', custo_por_mil_impressoes: 'R$ 10,00' },
          // Sem clique lido: sem CTR e sem custo por clique (não vira zero).
          { plataforma: 'Meta', campanha: 'Almoço executivo', situacao: 'ativa', investimento: 'R$ 40,00', impressoes: '1.234.567', custo_por_mil_impressoes: 'R$ 0,03' },
        ],
        por_dia: [
          { dia: '01/09/2026', investimento: 'R$ 100,50', impressoes: '10.000', cliques: '150' },
          { dia: '02/09/2026', investimento: 'R$ 939,50', impressoes: '1.324.567', cliques: '850' },
        ],
      },
    });
    // A empresa B, pedindo a marca da A ou tudo o que é dela: nada.
    expect(await de(b).executar({ brand_id: a.brandId, from: '2026-09-01', to: '2026-09-30' })).toMatchObject({ ok: true, valor: { campanhas: [], por_dia: [] } });
    expect(await de(b).executar({ from: '2026-09-01', to: '2026-09-30' })).toMatchObject({ ok: true, valor: { campanhas: [], por_dia: [] } });
    // Período ao contrário ou longo demais: o erro de domínio vira o texto curto.
    expect(await de(a).executar({ from: '2026-09-30', to: '2026-09-01' })).toEqual({ ok: false, erro: 'O período vai de 1 a 92 dias, com o início antes do fim.' });
    expect(await de(a).executar({ from: '2026-01-01', to: '2026-09-01' })).toMatchObject({ ok: false });
    expect(await de(a).executar({ from: '01/09/2026', to: '2026-09-30' })).toEqual({ ok: false, erro: 'Parâmetros inválidos para esta ferramenta.' });
  });

  it('A3-4: resultados, cupons e links leem a marca da própria empresa; a de outra empresa não existe para a ferramenta', async () => {
    const [a, b] = [await dono('Empresa A'), await dono('Empresa B')];
    const de = (quem: typeof a) => leituras.paraPedido({ tenantId: quem.tenantId, userId: quem.userId, permissions: new Set(['vendas.ver']) });
    const usar = (quem: typeof a, nome: string, input: unknown) => de(quem).find((f) => f.name === nome)!.executar(input);
    const periodo = { from: '2026-09-01', to: '2026-09-30' };

    // Empresa sem conta conectada: a leitura funciona e diz que não há nada (não inventa número).
    expect(await usar(a, 'resultados_ciclo_fechado', { brand_id: a.brandId, ...periodo })).toMatchObject({
      ok: true,
      valor: { periodo: { de: '01/09/2026', ate: '30/09/2026' }, totais: { investimento: 'R$ 0,00', pedidos_confirmados: '0', receita_confirmada: 'R$ 0,00' }, plataformas: [], campanhas: [], fontes: [] },
    });
    expect(await usar(a, 'cupons_campanha', { brand_id: a.brandId })).toMatchObject({ ok: true, valor: { lojas: [], total_de_cupons: 0, cupons: [], pedidos_de_criacao: [], criar_cupom_pelo_liame: 'desligado' } });
    expect(await usar(a, 'links_rastreio', { brand_id: a.brandId })).toMatchObject({ ok: true, valor: { rastreio_dos_anuncios: { anuncios_ativos: '0' }, total_de_links: 0, links: [] } });
    // A rotina do sistema (sem pessoa) lê do mesmo jeito.
    const doSistema = leituras.paraPedido({ tenantId: a.tenantId, userId: null, permissions: 'sistema' }, ['cupons_campanha'])[0]!;
    expect(await doSistema.executar({ brand_id: a.brandId })).toMatchObject({ ok: true, valor: { total_de_cupons: 0 } });

    for (const [nome, input] of [['resultados_ciclo_fechado', { brand_id: a.brandId, ...periodo }], ['cupons_campanha', { brand_id: a.brandId }], ['links_rastreio', { brand_id: a.brandId }]] as const) {
      expect(await usar(b, nome, input), nome).toEqual({ ok: false, erro: 'Marca não encontrada nesta empresa.' });
      // A marca é obrigatória nestas três.
      expect(await usar(a, nome, {}), nome).toEqual({ ok: false, erro: 'Parâmetros inválidos para esta ferramenta.' });
    }
  });
});
