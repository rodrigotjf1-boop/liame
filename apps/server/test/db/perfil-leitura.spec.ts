import { createDatabase, type Database, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gravarAvaliacoes, gravarNumeros } from '../../src/avaliacoes/perfil-store.js';
import { DATASET_AVALIACOES, DATASET_NUMEROS, type CursorDoPerfil } from '../../src/avaliacoes/sincronizador-do-perfil.js';
import { loadConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { PerfilLoop } from '../../src/worker/perfil-loop.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { ACESSO_RENOVADO, type AvaliacaoNoGoogle, CONTA_DO_PERFIL, type EmpresaComLoja, empresaComLojaDoPerfil, GoogleComPerfil, LOJA_DO_PERFIL } from '../helpers/perfil-google-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z1 (parte c): a leitura das lojas do Perfil da Empresa no Google, de ponta a ponta, contra um Google local. A
// loja nasce pelo caminho do produto (a pessoa autoriza o Google e escolhe a loja). O que se prova aqui:
//   - o que é guardado das avaliações e dos números, e que o nome e a foto de quem avaliou NÃO são guardados em lugar
//     nenhum (critério A6-1), inspecionando o que foi gravado;
//   - no limite de cota, a leitura para, guarda quando tentar de novo e não insiste (critério A6-2), e o limite não
//     vira defeito da loja;
//   - a função desligada para a empresa para a leitura; a falha de um conjunto não para o outro;
//   - a guarda de 12 meses das avaliações.

const MIN_MS = 60_000;
const DIA_MS = 86_400_000;

type Avaliacao = { external_id: string; stars: number; comment: string | null; reviewed_at: Date; changed_at: Date; reply_text: string | null; reply_state: string | null; reply_violation: string | null };
type Estado = { last_success_at: Date | null; last_attempt_at: Date | null; last_error: string | null; cursor: CursorDoPerfil; expected_every_minutes: number };

describe.skipIf(!hasDb)('ler o Perfil da Empresa no Google (A6 · Z1)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let loop: PerfilLoop;
  let purge: LifecyclePurgeService;
  const google = new GoogleComPerfil();
  /** O relógio do teste: o mesmo instante vai para a rotina e para as expectativas (V89). */
  const AGORA = new Date();
  const em = (minutos: number) => new Date(AGORA.getTime() + minutos * MIN_MS);
  const ha = (dias: number, base = AGORA) => new Date(base.getTime() - dias * DIA_MS).toISOString();
  const dia = (d: Date) => d.toISOString().slice(0, 10);

  beforeAll(async () => {
    await google.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 6, applicationName: 'liame-test' });
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    processador = new ConexaoProcessor(database, loadConfig(), vault, flags);
    loop = new PerfilLoop(database, loadConfig(), vault, flags);
    purge = new LifecyclePurgeService(database, vault, api.app.get(Mailer));
  }, 120_000);
  beforeEach(async () => {
    google.limpar();
    // Cada teste cadastra a empresa dele: o limite de cadastros por IP é zerado entre um e outro.
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google.fechar();
  });

  /** A loja nasce no teste que a usa (V96). */
  const empresa = (nome: string) => empresaComLojaDoPerfil(api, google, processador, nome);
  const rodar = (e: EmpresaComLoja, quando: Date, limite = 10) => loop.executarLote(limite, { tenantIds: [e.tenantId] }, quando);
  /** A situação de cada leitura do lote; a que falhou leva o motivo, para a falha do teste dizer por quê. */
  const situacoes = (lote: Awaited<ReturnType<typeof rodar>>) => lote.map((r) => (r.status === 'ok' ? 'ok' : `${r.status}: ${r.erro ?? ''}`));
  const avaliacoes = (e: EmpresaComLoja) =>
    ownerQuery<Avaliacao>(
      `select external_id, stars, comment, reviewed_at, changed_at, reply_text, reply_state, reply_violation from liame.profile_review where connected_account_id = $1 order by external_id`,
      [e.contaId],
    );
  const estado = async (e: EmpresaComLoja, dataset: string) =>
    (await ownerQuery<Estado>(`select last_success_at, last_attempt_at, last_error, cursor, expected_every_minutes from liame.sync_state where connected_account_id = $1 and dataset = $2`, [e.contaId, dataset]))[0]!;
  const conta = async (e: EmpresaComLoja) => (await ownerQuery<{ status: string; status_reason: string | null }>(`select status, status_reason from liame.connected_account where id = $1`, [e.contaId]))[0]!;
  const execucoes = (e: EmpresaComLoja, dataset: string) =>
    ownerQuery<{ kind: string; status: string; api_version: string; calls: number; entities_written: number; error: string | null }>(
      `select kind, status, api_version, calls, entities_written, error from liame.sync_run where connected_account_id = $1 and dataset = $2 order by started_at, id`,
      [e.contaId, dataset],
    );
  const avaliacao = (id: string, estrelas: AvaliacaoNoGoogle['starRating'], mudouHaDias: number, extra: Partial<AvaliacaoNoGoogle> = {}): AvaliacaoNoGoogle => ({
    reviewId: id,
    starRating: estrelas,
    comment: `Comentário da avaliação ${id}`,
    createTime: ha(mudouHaDias + 1),
    updateTime: ha(mudouHaDias),
    ...extra,
  });
  const serie = (metrica: string, valores: Array<[Date, string | undefined]>) => ({
    dailyMetric: metrica,
    timeSeries: { datedValues: valores.map(([d, value]) => ({ date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }, ...(value === undefined ? {} : { value }) })) },
  });

  it('a primeira leitura guarda as avaliações dos últimos 12 meses, o resumo da loja e 90 dias de números; nada de quem avaliou é guardado (A6-1)', async () => {
    const e = await empresa('Mister Burgers Leitura');
    google.lista = [
      avaliacao('rev-a', 'FIVE', 1, { reviewReply: { comment: 'Obrigado pela visita!', updateTime: ha(1), reviewReplyState: 'APPROVED' } }),
      avaliacao('rev-b', 'ONE', 3, { comment: `Demorou duas horas${String.fromCharCode(0)} e chegou frio.` }),
      avaliacao('rev-c', 'FOUR', 40, { comment: undefined }),
      // Mudou há mais de 12 meses: fica fora da leitura e da guarda.
      avaliacao('rev-velha', 'TWO', 400),
    ];
    const ontem = new Date(AGORA.getTime() - DIA_MS), anteontem = new Date(AGORA.getTime() - 2 * DIA_MS);
    google.series = [
      serie('WEBSITE_CLICKS', [[anteontem, '12'], [ontem, undefined]]),
      serie('BUSINESS_IMPRESSIONS_MOBILE_SEARCH', [[anteontem, '340']]),
      serie('CALL_CLICKS', [[ontem, '3']]),
    ];
    google.vistos.length = 0;

    const lote = await rodar(e, AGORA);
    expect(lote.map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'ok'], [DATASET_NUMEROS, 'ok']]);
    const lidas = lote.find((r) => r.dataset === DATASET_AVALIACOES)!;
    expect(lidas.avaliacoes).toBe(3);
    expect(lidas.novas!.map((n) => [n.externalId, n.estrelas]).sort()).toEqual([['rev-a', 5], ['rev-b', 1], ['rev-c', 4]]);

    // As avaliações: a nota, o texto (sem o caractere nulo), as datas e a resposta com a situação dela.
    const guardadas = await avaliacoes(e);
    expect(guardadas.map((a) => [a.external_id, a.stars, a.comment, a.reply_text, a.reply_state])).toEqual([
      ['rev-a', 5, 'Comentário da avaliação rev-a', 'Obrigado pela visita!', 'aprovada'],
      ['rev-b', 1, 'Demorou duas horas e chegou frio.', null, null],
      ['rev-c', 4, null, null, null],
    ]);
    expect(guardadas[0]!.changed_at.toISOString()).toBe(ha(1));
    expect(guardadas[0]!.reviewed_at.toISOString()).toBe(ha(2));
    const [resumo] = await ownerQuery<{ rating: string; review_count: number; read_at: Date }>(`select rating, review_count, read_at from liame.profile_summary where connected_account_id = $1`, [e.contaId]);
    expect([Number(resumo!.rating), resumo!.review_count, resumo!.read_at.toISOString()]).toEqual([4.6, 128, AGORA.toISOString()]);

    // A6-1, no que foi gravado: nenhuma coluna para quem avaliou, e o nome e a foto que o Google mandou não estão em
    // lugar nenhum do que o Liame guardou desta loja.
    const colunas = await ownerQuery<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'liame' and table_name = 'profile_review' order by column_name`);
    expect(colunas.map((c) => c.column_name)).toEqual([
      'brand_id', 'changed_at', 'comment', 'connected_account_id', 'created_at', 'external_id', 'first_seen_at', 'id', 'last_seen_at',
      'reply_changed_at', 'reply_state', 'reply_text', 'reply_violation', 'reviewed_at', 'stars', 'tenant_id', 'updated_at',
    ]);
    const [tudo] = await ownerQuery<{ texto: string }>(
      `select coalesce((select string_agg(to_jsonb(r)::text, ' ') from liame.profile_review r where r.connected_account_id = $1), '')
           || coalesce((select string_agg(to_jsonb(s)::text, ' ') from liame.sync_state s where s.connected_account_id = $1), '')
           || coalesce((select string_agg(to_jsonb(x)::text, ' ') from liame.sync_run x where x.connected_account_id = $1), '')
           || coalesce((select string_agg(to_jsonb(p)::text, ' ') from liame.profile_summary p where p.connected_account_id = $1), '')
           || coalesce((select to_jsonb(a)::text from liame.connected_account a where a.id = $1), '') as texto`,
      [e.contaId],
    );
    expect(tudo!.texto).toContain('rev-b');
    expect(tudo!.texto).not.toContain('Pessoa Número');
    expect(tudo!.texto).not.toContain('googleusercontent');
    expect(tudo!.texto).not.toContain('reviewer');

    // O frescor e a fila das avaliações: de hora em hora; a próxima parte do começo desta.
    const av = await estado(e, DATASET_AVALIACOES);
    expect([av.last_success_at!.toISOString(), av.last_error, av.expected_every_minutes]).toEqual([AGORA.toISOString(), null, 60]);
    expect(av.cursor).toMatchObject({ primeira_em: AGORA.toISOString(), lido_ate: AGORA.toISOString(), proxima: em(60).toISOString(), parou_no_teto: false, falhas_seguidas: 0 });
    expect(await execucoes(e, DATASET_AVALIACOES)).toEqual([{ kind: 'carga_inicial', status: 'ok', api_version: 'v4', calls: 1, entities_written: 3, error: null }]);
    const chamada = google.de('avaliacoes');
    expect(chamada).toHaveLength(1);
    expect([chamada[0]!.autorizacao, chamada[0]!.busca.get('orderBy'), chamada[0]!.busca.get('pageSize')]).toEqual([`Bearer ${ACESSO_RENOVADO}`, 'updateTime desc', '50']);

    // Os números: só os dias que o Google mandou (o dia sem valor é zero), na janela de 90 dias até ontem.
    const numeros = await ownerQuery<{ day: string; metric: string; value: string }>(
      `select day::text, metric, value::text from liame.profile_metric_daily where connected_account_id = $1 order by day, metric`,
      [e.contaId],
    );
    expect(numeros).toEqual([
      { day: dia(anteontem), metric: 'profile_views_search_mobile', value: '340' },
      { day: dia(anteontem), metric: 'website_clicks', value: '12' },
      { day: dia(ontem), metric: 'call_clicks', value: '3' },
      { day: dia(ontem), metric: 'website_clicks', value: '0' },
    ]);
    const pedido = google.de('numeros')[0]!.busca;
    const pedida = (p: string) => `${pedido.get(`dailyRange.${p}.year`)}-${pedido.get(`dailyRange.${p}.month`)!.padStart(2, '0')}-${pedido.get(`dailyRange.${p}.day`)!.padStart(2, '0')}`;
    expect([pedida('start_date'), pedida('end_date')]).toEqual([dia(new Date(AGORA.getTime() - 90 * DIA_MS)), dia(ontem)]);
    const nu = await estado(e, DATASET_NUMEROS);
    expect([nu.expected_every_minutes, nu.cursor.proxima, nu.cursor.primeira_em]).toEqual([1440, em(1440).toISOString(), AGORA.toISOString()]);
    expect(await execucoes(e, DATASET_NUMEROS)).toEqual([{ kind: 'carga_inicial', status: 'ok', api_version: 'v1', calls: 1, entities_written: 4, error: null }]);
    expect(await conta(e)).toEqual({ status: 'ativa', status_reason: null });

    // Outra empresa não vê nada disto (RLS).
    const outra = await empresa('Casa Brasa Vizinha');
    const vistas = await withTenant(database.db, outra.tenantId, async (tx) => (await tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.profile_review`)).rows[0]!.n);
    expect(vistas).toBe('0');
  });

  it('a leitura seguinte traz só o que mudou: a avaliação nova entra, a que ganhou resposta é atualizada, e os números releem 10 dias', async () => {
    const e = await empresa('Mister Burgers Seguinte');
    google.lista = [avaliacao('rev-1', 'FIVE', 2), avaliacao('rev-2', 'THREE', 5)];
    expect((await rodar(e, AGORA)).map((r) => r.status)).toEqual(['ok', 'ok']);

    // Antes da hora, nada é devido.
    google.vistos.length = 0;
    expect(await rodar(e, em(30))).toEqual([]);
    expect(google.vistos).toEqual([]);

    // Uma hora depois: a rev-2 ganhou resposta (o Google ainda confere) e chegou a rev-3, de 2 estrelas.
    const depois = em(61);
    const naHora = new Date(AGORA.getTime() + 10 * MIN_MS).toISOString();
    google.lista = [
      avaliacao('rev-1', 'FIVE', 2),
      { ...avaliacao('rev-2', 'THREE', 5), updateTime: naHora, reviewReply: { comment: 'Vamos melhorar a batata.', reviewReplyState: 'PENDING' } },
      { reviewId: 'rev-3', starRating: 'TWO', comment: 'Pedido errado.', createTime: naHora, updateTime: naHora },
    ];
    const lote = await rodar(e, depois);
    expect(lote.map((r) => [r.dataset, r.status])).toEqual([[DATASET_AVALIACOES, 'ok']]);
    // A rev-1 não mudou desde o corte (o começo da leitura anterior menos uma hora): a leitura para nela.
    expect(lote[0]!.avaliacoes).toBe(2);
    expect(lote[0]!.novas).toEqual([{ externalId: 'rev-3', estrelas: 2 }]);
    expect((await avaliacoes(e)).map((a) => [a.external_id, a.stars, a.reply_text, a.reply_state])).toEqual([
      ['rev-1', 5, null, null],
      ['rev-2', 3, 'Vamos melhorar a batata.', 'pendente'],
      ['rev-3', 2, null, null],
    ]);
    expect((await execucoes(e, DATASET_AVALIACOES)).map((x) => [x.kind, x.status, x.entities_written])).toEqual([['carga_inicial', 'ok', 2], ['incremental', 'ok', 2]]);
    expect((await estado(e, DATASET_AVALIACOES)).cursor).toMatchObject({ primeira_em: AGORA.toISOString(), lido_ate: depois.toISOString(), proxima: new Date(depois.getTime() + 60 * MIN_MS).toISOString() });

    // No dia seguinte, os números releem os últimos 10 dias, até a véspera.
    const amanha = em(1441);
    google.vistos.length = 0;
    const doDia = await rodar(e, amanha);
    expect(doDia.map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'ok'], [DATASET_NUMEROS, 'ok']]);
    const pedido = google.de('numeros')[0]!.busca;
    const pedida = (p: string) => `${pedido.get(`dailyRange.${p}.year`)}-${pedido.get(`dailyRange.${p}.month`)!.padStart(2, '0')}-${pedido.get(`dailyRange.${p}.day`)!.padStart(2, '0')}`;
    expect([pedida('start_date'), pedida('end_date')]).toEqual([dia(new Date(amanha.getTime() - 10 * DIA_MS)), dia(new Date(amanha.getTime() - DIA_MS))]);
    expect((await execucoes(e, DATASET_NUMEROS)).map((x) => x.kind)).toEqual(['carga_inicial', 'incremental']);
  });

  it('com a função desligada para a empresa, nada é lido do Google, e a loja é olhada de novo no dia seguinte', async () => {
    const e = await empresa('Casa Brasa Desligou');
    google.lista = [avaliacao('rev-1', 'FIVE', 2)];
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, false);
    google.vistos.length = 0;

    const lote = await rodar(e, AGORA);
    expect(lote.map((r) => r.status)).toEqual(['desligada', 'desligada']);
    expect(google.vistos).toEqual([]);
    expect(await avaliacoes(e)).toEqual([]);
    const av = await estado(e, DATASET_AVALIACOES);
    expect([av.last_success_at, av.last_error, av.cursor.proxima]).toEqual([null, null, em(24 * 60).toISOString()]);
    expect(await rodar(e, em(60))).toEqual([]);
    expect(await execucoes(e, DATASET_AVALIACOES)).toEqual([]);

    // Ligada de novo, a leitura acontece quando a loja volta para a fila.
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, true);
    expect((await rodar(e, em(24 * 60 + 1))).map((r) => r.status)).toEqual(['ok', 'ok']);
    expect((await avaliacoes(e)).map((a) => a.external_id)).toEqual(['rev-1']);
  });

  it('A6-2: no limite de cota, a leitura para, guarda quando tentar de novo e não insiste; o limite não é defeito da loja, e os números seguem', async () => {
    const e = await empresa('Mister Burgers Sem Cota');
    google.lista = [avaliacao('rev-1', 'FIVE', 2)];
    google.avaliacoes = 'sem-cota';
    google.vistos.length = 0;

    const lote = await rodar(e, AGORA);
    expect(lote.map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'falhou'], [DATASET_NUMEROS, 'ok']]);
    // Uma chamada só às avaliações.
    expect(google.de('avaliacoes')).toHaveLength(1);
    const av = await estado(e, DATASET_AVALIACOES);
    expect(av.last_success_at).toBeNull();
    expect(av.last_error).toMatch(/^limite: /);
    // Sem o Google dizer quanto esperar, meia hora; a fila só a traz de volta depois disso.
    expect(av.cursor).toMatchObject({ falha: 'limite', falhas_seguidas: 1, espera_ate: em(30).toISOString(), proxima: em(30).toISOString() });
    expect(await execucoes(e, DATASET_AVALIACOES)).toEqual([{ kind: 'carga_inicial', status: 'falhou', api_version: 'v4', calls: 1, entities_written: 0, error: expect.stringMatching(/^limite: /) }]);
    expect(await conta(e)).toEqual({ status: 'ativa', status_reason: null });

    google.vistos.length = 0;
    expect(await rodar(e, em(29))).toEqual([]);
    expect(google.vistos).toEqual([]);

    // Na segunda falha seguida, a espera dobra; e quando o Google diz quanto esperar, vale o maior dos dois.
    google.esperar = '7200';
    expect((await rodar(e, em(31))).map((r) => r.status)).toEqual(['falhou']);
    expect((await estado(e, DATASET_AVALIACOES)).cursor).toMatchObject({ falha: 'limite', falhas_seguidas: 2, espera_ate: em(31 + 120).toISOString() });

    // O Google liberou: a leitura acontece, e o estado fica limpo.
    google.avaliacoes = 'ok';
    google.esperar = null;
    expect((await rodar(e, em(31 + 121))).map((r) => [r.dataset, r.status])).toEqual([[DATASET_AVALIACOES, 'ok']]);
    const limpo = await estado(e, DATASET_AVALIACOES);
    expect(limpo.last_error).toBeNull();
    expect(limpo.cursor).not.toHaveProperty('falha');
    expect(limpo.cursor).not.toHaveProperty('espera_ate');
    expect(limpo.cursor.falhas_seguidas).toBe(0);
    expect((await avaliacoes(e)).map((a) => a.external_id)).toEqual(['rev-1']);
  });

  it('a recusa do Google deixa a loja "sem permissão" por um dia; a queda passageira não muda a situação; e o defeito de um conjunto não é apagado pela leitura boa do outro', async () => {
    const e = await empresa('Mister Burgers Falhas');
    google.lista = [avaliacao('rev-1', 'FOUR', 2)];

    // O Google recusa as avaliações: a loja fica sem permissão, e a nova tentativa é no dia seguinte. Os números leem.
    google.avaliacoes = 'recusa';
    expect((await rodar(e, AGORA)).map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'sem_permissao'], [DATASET_NUMEROS, 'ok']]);
    expect((await conta(e)).status).toBe('sem_permissao');
    expect((await conta(e)).status_reason).toContain('O Google recusou a leitura do perfil desta loja');
    expect((await estado(e, DATASET_AVALIACOES)).cursor).toMatchObject({ falha: 'permissao', espera_ate: em(24 * 60).toISOString() });

    // No dia seguinte o Google aceita: a loja volta a "ativa".
    google.avaliacoes = 'ok';
    const d1 = em(24 * 60 + 1);
    expect((await rodar(e, d1)).map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'ok'], [DATASET_NUMEROS, 'ok']]);
    expect(await conta(e)).toEqual({ status: 'ativa', status_reason: null });

    // O Perfil fora do ar: falha passageira, nova tentativa em meia hora, e a loja segue "ativa".
    google.avaliacoes = 'fora';
    const d2 = new Date(d1.getTime() + 61 * MIN_MS);
    expect((await rodar(e, d2)).map((r) => [r.dataset, r.status])).toEqual([[DATASET_AVALIACOES, 'falhou']]);
    expect((await estado(e, DATASET_AVALIACOES)).cursor).toMatchObject({ falha: 'transitorio', espera_ate: new Date(d2.getTime() + 30 * MIN_MS).toISOString() });
    expect((await conta(e)).status).toBe('ativa');

    // Os números com um pedido que o Google não aceita (defeito nosso): a loja mostra "erro", e a leitura boa das
    // avaliações, logo depois, NÃO apaga esse defeito.
    google.avaliacoes = 'ok';
    google.numeros = 'invalido';
    const d3 = new Date(d1.getTime() + 24 * 60 * MIN_MS + MIN_MS);
    expect((await rodar(e, d3)).map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'ok'], [DATASET_NUMEROS, 'falhou']]);
    expect((await conta(e)).status).toBe('erro');
    expect((await conta(e)).status_reason).toContain('A leitura do perfil no Google falhou');
    const d4 = new Date(d3.getTime() + 61 * MIN_MS);
    expect((await rodar(e, d4)).map((r) => [r.dataset, r.status])).toEqual([[DATASET_AVALIACOES, 'ok']]);
    expect((await conta(e)).status).toBe('erro');
    // O defeito espera 6 horas no mínimo; quando os números voltam a ler, a loja volta a "ativa".
    expect((await estado(e, DATASET_NUMEROS)).cursor).toMatchObject({ falha: 'definitivo', espera_ate: new Date(d3.getTime() + 6 * 60 * MIN_MS).toISOString() });
    google.numeros = 'ok';
    const d5 = new Date(d3.getTime() + 6 * 60 * MIN_MS + MIN_MS);
    expect((await rodar(e, d5)).map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'ok'], [DATASET_NUMEROS, 'ok']]);
    expect(await conta(e)).toEqual({ status: 'ativa', status_reason: null });
  });

  it('a autorização revogada no Google desconecta a loja, que sai da fila; e a loja desligada pela pessoa também não é mais lida', async () => {
    const e = await empresa('Mister Burgers Revogou');
    google.lista = [avaliacao('rev-1', 'FIVE', 2)];
    expect(situacoes(await rodar(e, AGORA))).toEqual(['ok', 'ok']);

    google.renovacaoRecusada = true;
    const lote = await rodar(e, em(61));
    expect(lote.map((r) => [r.dataset, r.status])).toEqual([[DATASET_AVALIACOES, 'falhou']]);
    expect(await conta(e)).toEqual({ status: 'desconectada', status_reason: 'O Google recusou a autorização desta loja: conecte de novo.' });
    expect(google.de('avaliacoes')).toHaveLength(1); // só a leitura boa de antes
    // Desconectada, a loja não volta para a fila (nem no dia seguinte, com os números devidos).
    expect(await rodar(e, em(3 * 24 * 60))).toEqual([]);
    // O que já foi lido fica.
    expect((await avaliacoes(e)).map((a) => a.external_id)).toEqual(['rev-1']);

    // Outra empresa, com a autorização valendo: a pessoa desliga a loja.
    google.renovacaoRecusada = false;
    const outra = await empresa('Mister Burgers Desligou a Loja');
    expect(situacoes(await rodar(outra, AGORA))).toEqual(['ok', 'ok']);
    expect((await api.call('DELETE', `/v1/connected-accounts/${outra.contaId}`, { cookie: outra.cookie })).status).toBe(204);
    expect(await rodar(outra, em(3 * 24 * 60))).toEqual([]);
    expect((await avaliacoes(outra)).map((a) => a.external_id)).toEqual(['rev-1']);
  });

  it('quatro voltas da rotina ao mesmo tempo leem cada conjunto de cada loja uma vez só', async () => {
    const e = await empresa('Mister Burgers Concorrência');
    google.lista = [avaliacao('rev-1', 'FIVE', 2)];
    google.vistos.length = 0;
    const voltas = await Promise.all([rodar(e, AGORA), rodar(e, AGORA), rodar(e, AGORA), rodar(e, AGORA)]);
    expect(voltas.flat().map((r) => [r.dataset, r.status]).sort()).toEqual([[DATASET_AVALIACOES, 'ok'], [DATASET_NUMEROS, 'ok']]);
    expect([google.de('avaliacoes').length, google.de('numeros').length]).toEqual([1, 1]);
    expect((await execucoes(e, DATASET_AVALIACOES)).length + (await execucoes(e, DATASET_NUMEROS)).length).toBe(2);
  });

  it('a gravação acerta o que o banco não aceita: a mesma avaliação duas vezes, o caractere nulo, a resposta sem texto, a métrica desconhecida e o valor negativo', async () => {
    const e = await empresa('Mister Burgers Gravação');
    const alvo = { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.contaId };
    const base = { estrelas: 5 as const, criadaEm: ha(10), resposta: null };
    const r = await withTenant(database.db, e.tenantId, (tx) =>
      gravarAvaliacoes(
        tx,
        alvo,
        [
          { ...base, id: 'dupla', texto: 'a versão antiga', atualizadaEm: ha(5) },
          { ...base, id: 'dupla', texto: 'a versão nova', atualizadaEm: ha(4) },
          { ...base, id: `nulo${String.fromCharCode(0)}`, texto: String.fromCharCode(0), atualizadaEm: ha(3), resposta: { texto: `  ${String.fromCharCode(0)} `, atualizadaEm: null, situacao: 'aprovada', violacao: 'SPAM' } },
          { ...base, id: String.fromCharCode(0), texto: 'sem id depois da limpeza', atualizadaEm: ha(2) },
          { ...base, id: 'comprida', texto: 'x'.repeat(6000), atualizadaEm: ha(1), resposta: { texto: 'y'.repeat(6000), atualizadaEm: 'ontem', situacao: 'recusada', violacao: 'OFF_TOPIC' } },
        ],
        AGORA,
      ),
    );
    expect([r.gravadas, r.novas.map((n) => n.externalId).sort()]).toEqual([3, ['comprida', 'dupla', 'nulo']]);
    const guardadas = await avaliacoes(e);
    expect(guardadas.map((a) => [a.external_id, a.comment?.length ?? null, a.reply_text?.length ?? null, a.reply_state, a.reply_violation])).toEqual([
      ['comprida', 5000, 5000, 'recusada', 'OFF_TOPIC'],
      ['dupla', 'a versão nova'.length, null, null, null],
      ['nulo', null, null, null, null],
    ]);
    // Gravar de novo a mesma avaliação não a duplica nem a conta como nova.
    const de_novo = await withTenant(database.db, e.tenantId, (tx) => gravarAvaliacoes(tx, alvo, [{ ...base, id: 'dupla', texto: 'mudou de novo', atualizadaEm: ha(1) }], em(5)));
    expect([de_novo.gravadas, de_novo.novas]).toEqual([1, []]);
    expect((await avaliacoes(e)).find((a) => a.external_id === 'dupla')!.comment).toBe('mudou de novo');

    const n = await withTenant(database.db, e.tenantId, (tx) =>
      gravarNumeros(
        tx,
        alvo,
        [
          { dia: '2026-10-01', metrica: 'website_clicks', valor: 7 },
          { dia: '2026-10-01', metrica: 'website_clicks', valor: 9 },
          { dia: '2026-10-01', metrica: 'metrica_que_nao_existe', valor: 1 },
          { dia: '2026-10-01', metrica: 'call_clicks', valor: -1 },
          { dia: '2026-10-01', metrica: 'bookings', valor: 1.5 },
        ],
        AGORA,
      ),
    );
    expect(n.gravados).toBe(1);
    expect(await ownerQuery(`select day::text, metric, value::text from liame.profile_metric_daily where connected_account_id = $1`, [e.contaId])).toEqual([{ day: '2026-10-01', metric: 'website_clicks', value: '9' }]);
  });

  it('a guarda de 12 meses: a avaliação que não muda no Google há mais de um ano é apagada pelo expurgo, e a retenção legal a segura', async () => {
    const e = await empresa('Mister Burgers Guarda');
    const alvo = { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.contaId };
    const base = { estrelas: 3 as const, texto: 'texto', resposta: null };
    await withTenant(database.db, e.tenantId, (tx) =>
      gravarAvaliacoes(tx, alvo, [{ ...base, id: 'recente', criadaEm: ha(500, new Date()), atualizadaEm: ha(364, new Date()) }, { ...base, id: 'vencida', criadaEm: ha(500, new Date()), atualizadaEm: ha(366, new Date()) }], AGORA),
    );
    // Com a retenção legal, nada sai.
    await ownerQuery(`update liame.organization set legal_hold_at = now(), legal_hold_reason = 'ofício judicial' where id = $1`, [e.tenantId]);
    await purge.purgeRetention({ tenantIds: [e.tenantId], userIds: [e.userId] });
    expect((await avaliacoes(e)).map((a) => a.external_id)).toEqual(['recente', 'vencida']);
    await ownerQuery(`update liame.organization set legal_hold_at = null, legal_hold_reason = null where id = $1`, [e.tenantId]);
    const contagem = await purge.purgeRetention({ tenantIds: [e.tenantId], userIds: [e.userId] });
    expect(contagem.avaliacao).toBe(1);
    expect((await avaliacoes(e)).map((a) => a.external_id)).toEqual(['recente']);
    // A empresa não apaga avaliação pelo Liame: só o expurgo (a política do banco recusa).
    const apagadas = await withTenant(database.db, e.tenantId, async (tx) => (await tx.execute(sql`delete from liame.profile_review where connected_account_id = ${e.contaId} returning id`)).rows.length);
    expect(apagadas).toBe(0);
  });

  it('as regras do banco, pelo nome de cada restrição', async () => {
    const e = await empresa('Mister Burgers Regras');
    const id = () => ownerQuery<{ id: string }>(`select gen_random_uuid() as id`).then((r) => r[0]!.id);
    const avaliacaoCom = async (campos: Record<string, unknown>) => {
      const linha = { external_id: `regra-${await id()}`, stars: 5, comment: null, reply_text: null, reply_state: null, reply_violation: null, ...campos };
      return ownerQuery(
        `insert into liame.profile_review (id, tenant_id, brand_id, connected_account_id, external_id, stars, comment, reviewed_at, changed_at, reply_text, reply_state, reply_violation)
         values ($1, $2, $3, $4, $5, $6, $7, now(), now(), $8, $9, $10)`,
        [await id(), e.tenantId, e.brandId, e.contaId, linha.external_id, linha.stars, linha.comment, linha.reply_text, linha.reply_state, linha.reply_violation],
      );
    };
    // O que passa.
    await avaliacaoCom({ external_id: 'regra-ok', comment: 'x'.repeat(5000), reply_text: 'ok', reply_state: 'recusada', reply_violation: 'SPAM' });
    // O que não passa, uma regra de cada vez.
    await expect(avaliacaoCom({ external_id: '' })).rejects.toThrow(/profile_review_external_id_check/);
    await expect(avaliacaoCom({ stars: 0 })).rejects.toThrow(/profile_review_stars_check/);
    await expect(avaliacaoCom({ stars: 6 })).rejects.toThrow(/profile_review_stars_check/);
    await expect(avaliacaoCom({ comment: '' })).rejects.toThrow(/profile_review_comment_check/);
    await expect(avaliacaoCom({ comment: 'x'.repeat(5001) })).rejects.toThrow(/profile_review_comment_check/);
    await expect(avaliacaoCom({ reply_text: 'y'.repeat(5001), reply_state: 'aprovada' })).rejects.toThrow(/profile_review_reply_text_check/);
    await expect(avaliacaoCom({ reply_text: 'ok', reply_state: 'publicada' })).rejects.toThrow(/profile_review_reply_state_check/);
    await expect(avaliacaoCom({ reply_text: 'ok', reply_state: 'recusada', reply_violation: 'X' })).rejects.toThrow(/profile_review_reply_violation_check/);
    await expect(avaliacaoCom({ reply_text: 'ok' })).rejects.toThrow(/profile_review_resposta/);
    await expect(avaliacaoCom({ reply_state: 'aprovada' })).rejects.toThrow(/profile_review_resposta/);
    await expect(avaliacaoCom({ reply_violation: 'SPAM' })).rejects.toThrow(/profile_review_violacao/);
    await expect(avaliacaoCom({ external_id: 'regra-ok' })).rejects.toThrow(/profile_review_connected_account_id_external_id_key/);

    const resumoCom = (rating: number | null, total: number | null) =>
      ownerQuery(
        `insert into liame.profile_summary (connected_account_id, tenant_id, brand_id, rating, review_count, read_at) values ($1, $2, $3, $4, $5, now())
         on conflict (connected_account_id) do update set rating = excluded.rating, review_count = excluded.review_count`,
        [e.contaId, e.tenantId, e.brandId, rating, total],
      );
    await resumoCom(4.56, 0);
    await resumoCom(null, null);
    await expect(resumoCom(0.9, 1)).rejects.toThrow(/profile_summary_rating_check/);
    await expect(resumoCom(5.1, 1)).rejects.toThrow(/profile_summary_rating_check/);
    await expect(resumoCom(4, -1)).rejects.toThrow(/profile_summary_review_count_check/);

    const numeroCom = (metrica: string, valor: number) =>
      ownerQuery(`insert into liame.profile_metric_daily (connected_account_id, tenant_id, brand_id, day, metric, value) values ($1, $2, $3, '2026-10-02', $4, $5)`, [e.contaId, e.tenantId, e.brandId, metrica, valor]);
    await numeroCom('menu_clicks', 0);
    await expect(numeroCom('conversations', 1)).rejects.toThrow(/profile_metric_daily_metric_check/);
    await expect(numeroCom('bookings', -1)).rejects.toThrow(/profile_metric_daily_value_check/);
    await expect(numeroCom('menu_clicks', 2)).rejects.toThrow(/profile_metric_daily_pkey/);
  });
});
