import { createDatabase, type Database, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gravarDias, gravarSemana } from '../../src/buscas/buscas-store.js';
import { type CursorDasBuscas, DATASET_DIAS, DATASET_SEMANAS, somarDias } from '../../src/buscas/sincronizador-das-buscas.js';
import { loadConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { SearchConsoleLoop } from '../../src/worker/search-console-loop.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComLoja, empresaComSiteDoSearchConsole, GoogleComPerfil, SITE_DO_SEARCH_CONSOLE } from '../helpers/perfil-google-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z3 (parte c): a leitura dos sites do Search Console, de ponta a ponta, contra um Google local. O site nasce pelo
// caminho do produto (a pessoa autoriza o Google e escolhe o site). O que se prova aqui: o pedido exato de cada leitura
// (as datas do Pacífico, só dias e semanas fechados), o que é guardado (por dia e por semana, e a lista do Google
// manda na semana relida), a função desligada, o limite sem insistir, a recusa, a semana que cai no meio, a autorização
// revogada, a leitura uma vez só com voltas ao mesmo tempo, a guarda de 12 meses das buscas e as regras do banco.

const MIN_MS = 60_000;
const DIA_MS = 86_400_000;
/** O relógio do teste (V89): quarta-feira, 14/10/2026, 8h no Pacífico. Ontem lá: 13/10; a última semana fechada: 05/10. */
const AGORA = new Date('2026-10-14T15:00:00Z');
const em = (minutos: number) => new Date(AGORA.getTime() + minutos * MIN_MS);

type Estado = { last_success_at: Date | null; last_attempt_at: Date | null; last_error: string | null; cursor: CursorDasBuscas; expected_every_minutes: number };

describe.skipIf(!hasDb)('ler o Search Console (A6 · Z3)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let loop: SearchConsoleLoop;
  let purge: LifecyclePurgeService;
  const google = new GoogleComPerfil();

  beforeAll(async () => {
    await google.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 6, applicationName: 'liame-test' });
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    processador = new ConexaoProcessor(database, loadConfig(), vault, flags);
    loop = new SearchConsoleLoop(database, loadConfig(), vault, flags);
    purge = new LifecyclePurgeService(database, vault, api.app.get(Mailer));
  }, 120_000);
  beforeEach(async () => {
    google.limpar();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google.fechar();
  });

  /** O site nasce no teste que o usa (V96), com os números e as buscas que o Google tem. */
  async function empresa(nome: string): Promise<EmpresaComLoja> {
    const e = await empresaComSiteDoSearchConsole(api, google, processador, nome);
    google.vistos.length = 0;
    google.diasDoSite.set('2026-06-01', { clicks: 1, impressions: 10, position: 3 });
    google.diasDoSite.set('2026-10-01', { clicks: 4, impressions: 120, ctr: 0.0333, position: 8.5 });
    google.diasDoSite.set('2026-10-02', { clicks: 9, impressions: 210, ctr: 0.0428, position: 6.123 });
    google.diasDoSite.set('2026-10-14', { clicks: 2, impressions: 30, position: 5 });
    google.buscasDaSemana.set('2026-10-05', [
      { keys: ['mister burgers'], clicks: 7, impressions: 40, position: 1.2 },
      { keys: ['hamburgueria perto de mim'], clicks: 4, impressions: 300, position: 6.8 },
      { keys: ['burger\u0000lapa'], clicks: 1, impressions: 20, position: 4 },
    ]);
    google.buscasDaSemana.set('2026-07-20', [{ keys: ['smash burger centro'], clicks: 1, impressions: 10, position: 3 }]);
    return e;
  }
  const rodar = (e: EmpresaComLoja, quando: Date, limite = 10) => loop.executarLote(limite, { tenantIds: [e.tenantId] }, quando);
  const situacoes = (lote: Awaited<ReturnType<typeof rodar>>) =>
    lote.map((r) => `${r.dataset}: ${r.status === 'ok' ? 'ok' : `${r.status} ${r.erro ?? ''}`.trim()}`).sort();
  const estado = async (e: EmpresaComLoja, dataset: string) =>
    (await ownerQuery<Estado>(`select last_success_at, last_attempt_at, last_error, cursor, expected_every_minutes from liame.sync_state where connected_account_id = $1 and dataset = $2`, [e.contaId, dataset]))[0]!;
  const conta = async (e: EmpresaComLoja) => (await ownerQuery<{ status: string; status_reason: string | null }>(`select status, status_reason from liame.connected_account where id = $1`, [e.contaId]))[0]!;
  const dias = (e: EmpresaComLoja) =>
    ownerQuery<{ day: string; clicks: string; impressions: string; position: string | null }>(
      `select to_char(day, 'YYYY-MM-DD') as day, clicks::text, impressions::text, position::text from liame.search_console_daily where connected_account_id = $1 order by day`,
      [e.contaId],
    );
  const buscas = (e: EmpresaComLoja) =>
    ownerQuery<{ week_start: string; query: string; clicks: string; impressions: string; position: string | null }>(
      `select to_char(week_start, 'YYYY-MM-DD') as week_start, query, clicks::text, impressions::text, position::text from liame.search_console_query_week
        where connected_account_id = $1 order by week_start, query collate "C"`,
      [e.contaId],
    );
  const porData = () => google.consultas().filter((c) => c.corpo.dimensions[0] === 'date');
  const porBusca = () => google.consultas().filter((c) => c.corpo.dimensions[0] === 'query');

  it('a primeira leitura: 90 dias até ontem e 12 semanas fechadas, no fuso do Pacífico; o pedido exato e o que fica guardado', async () => {
    const e = await empresa('Mister Burgers Buscas');
    expect(situacoes(await rodar(e, AGORA))).toEqual(['buscas_dias: ok', 'buscas_semanas: ok']);

    // Um pedido por dia, com a janela inteira; um por semana, de segunda a domingo, até 100 buscas. Todos no site ligado.
    expect(porData()).toEqual([{ site: SITE_DO_SEARCH_CONSOLE, corpo: { startDate: '2026-07-16', endDate: '2026-10-13', dimensions: ['date'], type: 'web', rowLimit: 25_000 } }]);
    const semanas = porBusca().map((c) => [c.corpo.startDate, c.corpo.endDate, c.corpo.rowLimit, c.site]);
    expect(semanas).toHaveLength(12);
    expect(semanas[0]).toEqual(['2026-07-20', '2026-07-26', 100, SITE_DO_SEARCH_CONSOLE]);
    expect(semanas.at(-1)).toEqual(['2026-10-05', '2026-10-11', 100, SITE_DO_SEARCH_CONSOLE]);
    expect(google.vistos.filter((v) => v.caminho.startsWith('/sc/')).every((v) => v.autorizacao?.startsWith('Bearer '))).toBe(true);

    // Os dias da janela (nem o de junho, de fora, nem o de hoje); a posição com duas casas.
    expect(await dias(e)).toEqual([
      { day: '2026-10-01', clicks: '4', impressions: '120', position: '8.50' },
      { day: '2026-10-02', clicks: '9', impressions: '210', position: '6.12' },
    ]);
    // As buscas de cada semana; a com caractere nulo ficou de fora.
    expect(await buscas(e)).toEqual([
      { week_start: '2026-07-20', query: 'smash burger centro', clicks: '1', impressions: '10', position: '3.00' },
      { week_start: '2026-10-05', query: 'hamburgueria perto de mim', clicks: '4', impressions: '300', position: '6.80' },
      { week_start: '2026-10-05', query: 'mister burgers', clicks: '7', impressions: '40', position: '1.20' },
    ]);
    // O frescor e a fila: lido agora, de novo amanhã; o cursor anota até onde leu.
    const d = await estado(e, DATASET_DIAS);
    expect(d).toMatchObject({ last_error: null, expected_every_minutes: 1440, cursor: { lido_ate: '2026-10-13', primeira_em: AGORA.toISOString(), proxima: em(1440).toISOString(), falhas_seguidas: 0 } });
    expect(new Date(d.last_success_at!).toISOString()).toBe(AGORA.toISOString());
    expect((await estado(e, DATASET_SEMANAS)).cursor).toMatchObject({ lido_ate: '2026-10-05', proxima: em(1440).toISOString() });
    const execucoes = await ownerQuery<{ dataset: string; kind: string; status: string; api_version: string; entities_written: number }>(
      `select dataset, kind, status, api_version, entities_written from liame.sync_run where connected_account_id = $1 order by dataset`,
      [e.contaId],
    );
    expect(execucoes).toEqual([
      { dataset: 'buscas_dias', kind: 'carga_inicial', status: 'ok', api_version: 'v3', entities_written: 2 },
      { dataset: 'buscas_semanas', kind: 'carga_inicial', status: 'ok', api_version: 'v3', entities_written: 3 },
    ]);
    expect(await conta(e)).toEqual({ status: 'ativa', status_reason: null });
  });

  it('a leitura seguinte, no dia seguinte: 10 dias e as 2 últimas semanas; e a lista do Google manda na semana relida', async () => {
    const e = await empresa('Mister Burgers Buscas Seguinte');
    await rodar(e, AGORA);
    // Antes de um dia, nada é devido.
    expect(await rodar(e, em(60))).toEqual([]);
    google.vistos.length = 0;
    google.buscasDaSemana.set('2026-10-05', [{ keys: ['mister burgers'], clicks: 8, impressions: 45, position: 1.1 }]);
    google.diasDoSite.set('2026-10-14', { clicks: 3, impressions: 33, position: 4.5 });
    expect(situacoes(await rodar(e, em(1441)))).toEqual(['buscas_dias: ok', 'buscas_semanas: ok']);
    expect(porData().map((c) => [c.corpo.startDate, c.corpo.endDate])).toEqual([['2026-10-05', '2026-10-14']]);
    expect(porBusca().map((c) => c.corpo.startDate)).toEqual(['2026-09-28', '2026-10-05']);
    expect((await dias(e)).map((d) => d.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-14']);
    // A busca que saiu das que mais trouxeram cliques sai da semana; a semana de julho, que não foi relida, fica.
    expect((await buscas(e)).map((b) => [b.week_start, b.query, b.clicks])).toEqual([
      ['2026-07-20', 'smash burger centro', '1'],
      ['2026-10-05', 'mister burgers', '8'],
    ]);
    const execucoes = await ownerQuery<{ kind: string }>(`select kind from liame.sync_run where connected_account_id = $1 order by started_at, dataset`, [e.contaId]);
    expect(execucoes.map((x) => x.kind)).toEqual(['carga_inicial', 'carga_inicial', 'incremental', 'incremental']);
  });

  it('com a função desligada para a empresa, nada é lido do Google, e o site é olhado de novo no dia seguinte', async () => {
    const e = await empresa('Mister Burgers Sem Função');
    await ligarFlagDaEmpresa(api, 'search_console', e.tenantId, false);
    expect(situacoes(await rodar(e, AGORA))).toEqual(['buscas_dias: desligada', 'buscas_semanas: desligada']);
    expect(google.consultas()).toEqual([]);
    expect((await estado(e, DATASET_DIAS)).cursor.proxima).toBe(em(24 * 60).toISOString());
    expect(await dias(e)).toEqual([]);
  });

  it('no limite de cota (o 403 com motivo de cota), a leitura para, guarda quando tentar de novo e não insiste; o limite não é defeito do site', async () => {
    const e = await empresa('Mister Burgers Limite');
    google.consulta = 'cota-antiga';
    expect(situacoes(await rodar(e, AGORA)).map((s) => s.split(' ')[0] + ' ' + s.split(' ')[1])).toEqual(['buscas_dias: falhou', 'buscas_semanas: falhou']);
    // Uma chamada para cada conjunto: nenhuma nova tentativa.
    expect(google.consultas()).toHaveLength(2);
    for (const dataset of [DATASET_DIAS, DATASET_SEMANAS]) {
      const s = await estado(e, dataset);
      expect(s.cursor).toMatchObject({ falha: 'limite', falhas_seguidas: 1, espera_ate: em(15).toISOString(), proxima: em(15).toISOString() });
      expect(s.last_error).toContain('limite');
    }
    expect(await conta(e)).toEqual({ status: 'ativa', status_reason: null });
    // Antes da espera, nada; depois dela, com o Google de volta, lê.
    expect(await rodar(e, em(10))).toEqual([]);
    google.consulta = 'ok';
    expect(situacoes(await rodar(e, em(16)))).toEqual(['buscas_dias: ok', 'buscas_semanas: ok']);
    expect((await estado(e, DATASET_DIAS)).cursor).not.toHaveProperty('falha');
  });

  it('a recusa do Google deixa o site "sem permissão" por um dia; a leitura boa seguinte devolve a situação', async () => {
    const e = await empresa('Mister Burgers Recusa');
    google.consulta = 'recusa';
    expect(situacoes(await rodar(e, AGORA)).map((s) => s.split(' ').slice(0, 2).join(' '))).toEqual(['buscas_dias: sem_permissao', 'buscas_semanas: sem_permissao']);
    expect(await conta(e)).toMatchObject({ status: 'sem_permissao' });
    expect((await conta(e)).status_reason).toContain('Search Console');
    expect((await estado(e, DATASET_SEMANAS)).cursor).toMatchObject({ falha: 'permissao', proxima: em(1440).toISOString() });
    google.consulta = 'ok';
    expect(situacoes(await rodar(e, em(1441)))).toEqual(['buscas_dias: ok', 'buscas_semanas: ok']);
    expect(await conta(e)).toEqual({ status: 'ativa', status_reason: null });
  });

  it('a semana que cai no meio: as anteriores ficam gravadas, o cursor anota até onde leu, e a leitura volta em meia hora', async () => {
    const e = await empresa('Mister Burgers Semana Que Cai');
    google.buscasDaSemana.set('2026-07-27', [{ keys: ['burger artesanal'], clicks: 2, impressions: 25, position: 5 }]);
    google.semanaQueCai = '2026-08-03';
    const lote = await rodar(e, AGORA);
    expect(situacoes(lote)[0]).toBe('buscas_dias: ok');
    expect(situacoes(lote)[1]).toMatch(/^buscas_semanas: falhou transitorio/);
    expect(porBusca().map((c) => c.corpo.startDate)).toEqual(['2026-07-20', '2026-07-27', '2026-08-03']);
    expect((await buscas(e)).map((b) => b.week_start)).toEqual(['2026-07-20', '2026-07-27']);
    expect((await estado(e, DATASET_SEMANAS)).cursor).toMatchObject({ lido_ate: '2026-07-27', falha: 'transitorio', proxima: em(30).toISOString() });
    // A primeira leitura não terminou: a próxima lê as 12 semanas de novo.
    google.semanaQueCai = null;
    google.vistos.length = 0;
    expect(situacoes(await rodar(e, em(31)))).toEqual(['buscas_semanas: ok']);
    expect(porBusca()).toHaveLength(12);
    expect((await estado(e, DATASET_SEMANAS)).cursor).toMatchObject({ lido_ate: '2026-10-05' });
  });

  it('a autorização revogada no Google desconecta o site, que sai da fila', async () => {
    const e = await empresa('Mister Burgers Revogada');
    google.renovacaoRecusada = true;
    expect(situacoes(await rodar(e, AGORA)).map((s) => s.split(' ').slice(0, 2).join(' '))).toEqual(['buscas_dias: falhou', 'buscas_semanas: falhou']);
    expect(await conta(e)).toMatchObject({ status: 'desconectada' });
    expect(google.consultas()).toEqual([]);
    google.renovacaoRecusada = false;
    expect(await rodar(e, em(2 * 1440))).toEqual([]);
  });

  it('quatro voltas da rotina ao mesmo tempo leem cada conjunto do site uma vez só', async () => {
    const e = await empresa('Mister Burgers Concorrência');
    const lotes = await Promise.all([1, 2, 3, 4].map(() => rodar(e, AGORA)));
    expect(lotes.flat().map((r) => r.dataset).sort()).toEqual(['buscas_dias', 'buscas_semanas']);
    expect(porData()).toHaveLength(1);
    expect(porBusca()).toHaveLength(12);
  });

  it('a gravação deixa de fora o que o banco não aceita, e a guarda de 12 meses das buscas: o expurgo apaga a semana vencida, e a retenção legal a segura', async () => {
    const e = await empresa('Mister Burgers Guarda');
    const alvo = { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.contaId };
    const gravados = await withTenant(database.db, e.tenantId, (tx) =>
      gravarDias(
        tx,
        alvo,
        [
          { dia: '2026-10-01', cliques: 5, vezes: 2, posicao: 3 },
          { dia: '2026-10-02', cliques: -1, vezes: 2, posicao: 3 },
          { dia: '2026-13-01', cliques: 1, vezes: 2, posicao: 3 },
          { dia: '2026-10-03', cliques: 0, vezes: 0, posicao: 4 },
          { dia: '2026-10-04', cliques: 1, vezes: 5, posicao: 0.5 },
        ],
        new Date(),
      ),
    );
    expect(gravados).toEqual({ gravados: 2 });
    expect((await dias(e)).map((d) => [d.day, d.position])).toEqual([
      ['2026-10-03', null],
      ['2026-10-04', null],
    ]);
    await expect(withTenant(database.db, e.tenantId, (tx) => gravarSemana(tx, alvo, '2026-10-06', [], new Date()))).rejects.toThrow('semana inválida');

    // Uma semana de 13 meses atrás e uma recente (as datas pelo relógio do banco, que é o do expurgo).
    const segunda = (diasAtras: number) => {
      const d = new Date(Date.now() - diasAtras * DIA_MS).toISOString().slice(0, 10);
      return somarDias(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    };
    const vencida = segunda(400);
    const recente = segunda(30);
    const busca = (texto: string) => [{ busca: texto, cliques: 1, vezes: 10, posicao: 2 }];
    await withTenant(database.db, e.tenantId, async (tx) => {
      await gravarSemana(tx, alvo, vencida, busca('busca antiga'), new Date());
      await gravarSemana(tx, alvo, recente, busca('busca recente'), new Date());
    });
    await ownerQuery(`update liame.organization set legal_hold_at = now(), legal_hold_reason = 'ofício judicial' where id = $1`, [e.tenantId]);
    await purge.purgeRetention({ tenantIds: [e.tenantId], userIds: [e.userId] });
    expect((await buscas(e)).map((b) => b.query)).toEqual(['busca antiga', 'busca recente']);
    await ownerQuery(`update liame.organization set legal_hold_at = null, legal_hold_reason = null where id = $1`, [e.tenantId]);
    const contagem = await purge.purgeRetention({ tenantIds: [e.tenantId], userIds: [e.userId] });
    expect(contagem.busca).toBe(1);
    expect((await buscas(e)).map((b) => b.query)).toEqual(['busca recente']);
    // Os números por dia ficam (são contagens, guardadas com o site).
    expect(await dias(e)).toHaveLength(2);
  });

  it('as regras do banco, pelo nome de cada restrição', async () => {
    const e = await empresa('Mister Burgers Regras');
    const dia = (campos: Record<string, unknown>) => {
      const l = { day: '2026-10-01', clicks: 1, impressions: 10, position: 2, ...campos };
      return ownerQuery(
        `insert into liame.search_console_daily (connected_account_id, tenant_id, brand_id, day, clicks, impressions, position) values ($1, $2, $3, $4, $5, $6, $7)`,
        [e.contaId, e.tenantId, e.brandId, l.day, l.clicks, l.impressions, l.position],
      );
    };
    await dia({});
    await expect(dia({ day: '2026-10-02', clicks: -1 })).rejects.toThrow(/search_console_daily_clicks_check/);
    await expect(dia({ day: '2026-10-02', clicks: 11 })).rejects.toThrow(/search_console_daily_cliques/);
    await expect(dia({ day: '2026-10-02', position: 0.5 })).rejects.toThrow(/search_console_daily_position_check/);
    await expect(dia({ day: '2026-10-02', clicks: 0, impressions: 0, position: 2 })).rejects.toThrow(/search_console_daily_posicao/);
    await expect(dia({})).rejects.toThrow(/search_console_daily_pkey/);

    const semana = (campos: Record<string, unknown>) => {
      const l = { week_start: '2026-10-05', query: 'mister burgers', clicks: 1, impressions: 10, position: 2, ...campos };
      return ownerQuery(
        `insert into liame.search_console_query_week (connected_account_id, tenant_id, brand_id, week_start, query, clicks, impressions, position) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [e.contaId, e.tenantId, e.brandId, l.week_start, l.query, l.clicks, l.impressions, l.position],
      );
    };
    await semana({});
    await semana({ query: 'x'.repeat(500) });
    await expect(semana({ week_start: '2026-10-06', query: 'outra' })).rejects.toThrow(/search_console_query_week_week_start_check/);
    await expect(semana({ query: '' })).rejects.toThrow(/search_console_query_week_query_check/);
    await expect(semana({ query: 'y'.repeat(501) })).rejects.toThrow(/search_console_query_week_query_check/);
    await expect(semana({ query: 'outra', clicks: 11 })).rejects.toThrow(/search_console_query_week_cliques/);
    await expect(semana({ query: 'outra', clicks: 0, impressions: 0 })).rejects.toThrow(/search_console_query_week_posicao/);
    await expect(semana({})).rejects.toThrow(/search_console_query_week_pkey/);
  });
});
