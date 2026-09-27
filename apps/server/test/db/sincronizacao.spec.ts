import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { esperaDepoisDaFalha, hojeNoFuso, janelaDaVez } from '../../src/media/sincronizador.js';
import { metricasEm } from '../../src/media/metric-store.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { SincronizacaoLoop } from '../../src/worker/sincronizacao-loop.js';
import { ErroConector } from '../../src/connectors/cliente-http.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// A2 · G7: sincronização de ponta a ponta contra uma Graph API local com as respostas gravadas da v26.0.
// Carga inicial (relatório assíncrono), entidades com os pais, passado reescrito (observação nova e
// chave que sumiu vira zero), falhas classificadas, reserva sem duplicar e leitura com frescor.

const FIX = resolve(import.meta.dirname, '../fixtures/meta/v26.0');
type Linha = { ad_id: string; date_start: string; [k: string]: unknown };

describe.skipIf(!hasDb)('sincronização das contas conectadas', () => {
  let api: TestApi;
  let database: Database;
  let loop: SincronizacaoLoop;
  let plataforma: Server;
  let base = '';
  let tenantId = '';
  let brandId = '';
  let cookie = '';
  const contas: Record<'boa' | 'limite' | 'vencida', string> = { boa: '', limite: '', vencida: '' };
  let insights: Linha[] = [];
  const relatorios = new Map<string, { since: string; until: string }>();

  const fixture = (nome: string) => JSON.parse(readFileSync(resolve(FIX, `${nome}.json`), 'utf8').replaceAll('{{BASE}}', `${base}/graph`));
  const naFaixa = (f: { since: string; until: string }) => ({ data: insights.filter((l) => l.date_start >= f.since && l.date_start <= f.until), paging: {} });

  function responder(req: IncomingMessage): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (token === 'token-vencido') return { status: 400, corpo: { error: { code: 190, message: 'Error validating access token: Session has expired' } } };
    if (token === 'token-limite') return { status: 400, corpo: { error: { code: 17, message: 'User request limit reached' } } };
    const m = url.pathname.match(/^\/graph\/v26\.0\/(.+)$/);
    const [no, aresta] = (m?.[1] ?? '').split('/') as [string, string | undefined];
    if (no === 'act_1234567890') {
      if (aresta === 'campaigns') return { status: 200, corpo: fixture(url.searchParams.get('after') === 'b' ? 'campaigns-2' : 'campaigns-1') };
      if (aresta && ['adsets', 'ads', 'adcreatives'].includes(aresta)) return { status: 200, corpo: fixture(aresta) };
      if (aresta === 'insights' && req.method === 'POST') {
        const id = String(900_000_000 + relatorios.size + 1);
        relatorios.set(id, JSON.parse(url.searchParams.get('time_range')!));
        return { status: 200, corpo: { report_run_id: id } };
      }
      if (aresta === 'insights') return { status: 200, corpo: naFaixa(JSON.parse(url.searchParams.get('time_range')!)) };
    }
    if (relatorios.has(no) && !aresta) return { status: 200, corpo: { id: no, async_status: 'Job Completed', async_percent_completion: 100 } };
    if (relatorios.has(no) && aresta === 'insights') return { status: 200, corpo: naFaixa(relatorios.get(no)!) };
    return { status: 404, corpo: { error: { code: 100, message: 'Unknown path' } } };
  }

  async function contaCom(externalId: string, token: string): Promise<string> {
    const vault = api.app.get(VaultService);
    const segredo = await withTenant(database.db, tenantId, (tx) =>
      vault.putSecret(tx, { tenantId, purpose: 'oauth_meta', plaintext: JSON.stringify({ tipo: 'meta', access_token: token, obtido_em: new Date().toISOString(), expira_em: null }) }),
    );
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id)
       values ($1, $2, $3, 'meta_ads', $4, 'Casa Brasa', 'BRL', 'America/Sao_Paulo', $5)`,
      [id, tenantId, brandId, externalId, segredo],
    );
    return id;
  }

  const devidaAgora = (id: string) => ownerQuery(`update liame.sync_state set cursor = cursor || '{"proxima": "2000-01-01T00:00:00Z"}'::jsonb where connected_account_id = $1 and dataset = 'metricas'`, [id]);

  beforeAll(async () => {
    plataforma = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const r = responder(req);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => plataforma.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(plataforma.address() as AddressInfo).port}`;
    insights = (fixture('insights') as { data: Linha[] }).data;
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    const config = loadConfig({ ...process.env, NODE_ENV: 'test', META_GRAPH_URL: `${base}/graph` });
    loop = new SincronizacaoLoop(database, config, api.app.get(VaultService));
    const s = await signupAndLogin(api, undefined, 'Casa Brasa Sincronização');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    brandId = marca!.id;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => plataforma?.close(ok));
  });

  it('regras da janela: carga inicial de 90 dias, revisão longa semanal e incremental por plataforma; dia no fuso da conta', () => {
    const agora = new Date('2026-09-21T02:00:00Z');
    expect(hojeNoFuso(agora, 'America/Sao_Paulo')).toBe('2026-09-20');
    expect(hojeNoFuso(agora, 'Fuso/Inexistente')).toBe('2026-09-21');
    expect(janelaDaVez('meta_ads', {}, agora, 'America/Sao_Paulo')).toEqual({ tipo: 'carga_inicial', inicio: '2026-06-23', fim: '2026-09-20' });
    const recente = { carga_inicial_em: '2026-09-18T00:00:00Z', revisao_longa_em: '2026-09-18T00:00:00Z' };
    expect(janelaDaVez('meta_ads', recente, agora, 'America/Sao_Paulo')).toEqual({ tipo: 'incremental', inicio: '2026-09-14', fim: '2026-09-20' });
    expect(janelaDaVez('google_ads', recente, agora, 'America/Sao_Paulo').inicio).toBe('2026-09-07');
    expect(janelaDaVez('ga4', recente, agora, 'America/Sao_Paulo').inicio).toBe('2026-09-18');
    expect(janelaDaVez('google_ads', { ...recente, revisao_longa_em: '2026-09-10T00:00:00Z' }, agora, 'America/Sao_Paulo')).toEqual({ tipo: 'revisao', inicio: '2026-06-23', fim: '2026-09-20' });
    expect(esperaDepoisDaFalha(new ErroConector('limite', 'meta_ads', 'x', 400, 300_000), 1)).toBe(300_000);
    expect(esperaDepoisDaFalha(new Error('x'), 1)).toBe(30 * 60_000);
    expect(esperaDepoisDaFalha(new Error('x'), 3)).toBe(120 * 60_000);
    expect(esperaDepoisDaFalha(new Error('x'), 10)).toBe(12 * 3_600_000);
  });

  it('carga inicial: entidades com os pais, métricas pelo relatório assíncrono, execução registrada e frescor', async () => {
    contas.boa = await contaCom('act_1234567890', 'token-sistema-meta');
    const r = await loop.executarLote(3, { tenantIds: [tenantId] }, new Date('2026-09-21T15:00:00Z'));
    expect(r).toEqual([expect.objectContaining({ status: 'ok', tipo: 'carga_inicial', janela: { inicio: '2026-06-24', fim: '2026-09-21' }, observacoesNovas: 29, zeradas: 0 })]);
    expect(relatorios.size).toBe(3);

    const [anuncio] = await ownerQuery<{ grupo: string; campanha: string; criativo: string }>(
      `select g.external_id as grupo, c.external_id as campanha, cr.external_id as criativo
         from liame.ad a join liame.ad_group g on g.id = a.ad_group_id join liame.campaign c on c.id = g.campaign_id
         join liame.creative cr on cr.id = a.creative_id
        where a.connected_account_id = $1 and a.external_id = '120210000000001001'`,
      [contas.boa],
    );
    expect(anuncio).toEqual({ grupo: '120210000000000101', campanha: '120210000000000001', criativo: '120210000000009001' });
    const [ligadas] = await ownerQuery<{ n: string }>(`select count(*) as n from liame.metric_latest where connected_account_id = $1 and level = 'ad' and entity_id is not null`, [contas.boa]);
    expect(Number(ligadas!.n)).toBe(29);

    const execucoes = await ownerQuery<{ dataset: string; kind: string; status: string; calls: number; observations_new: number }>(
      `select dataset, kind, status, calls, observations_new from liame.sync_run where connected_account_id = $1 order by started_at`,
      [contas.boa],
    );
    expect(execucoes).toEqual([
      { dataset: 'entidades', kind: 'incremental', status: 'ok', calls: 5, observations_new: 0 },
      { dataset: 'metricas', kind: 'carga_inicial', status: 'ok', calls: 9, observations_new: 29 },
    ]);
    const [estado] = await ownerQuery<{ cursor: Record<string, string>; last_success_at: Date | null }>(
      `select cursor, last_success_at from liame.sync_state where connected_account_id = $1 and dataset = 'metricas'`,
      [contas.boa],
    );
    expect(estado!.last_success_at).not.toBeNull();
    expect(estado!.cursor).toMatchObject({ carga_inicial_em: '2026-09-21T15:00:00.000Z', revisao_longa_em: '2026-09-21T15:00:00.000Z', proxima: '2026-09-22T15:00:00.000Z', falhas_seguidas: 0 });

    // Já sincronizada: não é devida de novo agora.
    expect(await loop.executarLote(3, { tenantIds: [tenantId] }, new Date('2026-09-21T15:30:00Z'))).toEqual([]);

    const frescor = await api.call('GET', '/v1/media/freshness', { cookie });
    expect(frescor.status).toBe(200);
    const item = frescor.body.items.find((i: { connected_account_id: string }) => i.connected_account_id === contas.boa);
    expect(item.datasets.map((d: { dataset: string; freshness: string }) => [d.dataset, d.freshness])).toEqual([
      ['entidades', 'fresh'],
      ['metricas', 'fresh'],
    ]);
    const metricas = await api.call('GET', `/v1/media/metrics?from=2026-09-19&to=2026-09-19&connected_account_id=${contas.boa}&metric=spend`, { cookie });
    expect(metricas.body).toEqual({
      items: [expect.objectContaining({ level: 'ad', external_entity_id: '120210000000001001', value: '48.37', currency: 'BRL', quality: 'ok', freshness: 'fresh' })],
      has_more: false,
    });
    expect((await api.call('GET', '/v1/media/metrics?from=2026-01-01&to=2026-09-19', { cookie })).status).toBe(422);
  });

  it('dia seguinte: o passado reescrito vira observação nova e a chave que a plataforma deixou de mandar vira zero', async () => {
    const antes = new Date();
    insights = insights.map((l) => (l.date_start === '2026-09-19' ? { ...l, spend: '50.00', actions: (l.actions as { action_type: string }[]).filter((a) => !a.action_type.includes('messaging')) } : l));
    await devidaAgora(contas.boa);
    const [r] = await loop.executarLote(3, { tenantIds: [tenantId] }, new Date('2026-09-22T15:00:00Z'));
    expect(r).toMatchObject({ status: 'ok', tipo: 'incremental', janela: { inicio: '2026-09-16', fim: '2026-09-22' }, observacoesNovas: 1, zeradas: 6 });

    await withTenant(database.db, tenantId, async (tx) => {
      const ontem = await metricasEm(tx, contas.boa, '2026-09-19', antes);
      const hoje = await metricasEm(tx, contas.boa, '2026-09-19', new Date());
      const valor = (linhas: typeof ontem, nome: string, janela = '') => linhas.find((l) => l.metric_name === nome && l.attribution_window === janela)?.metric_value;
      expect([valor(ontem, 'spend'), valor(hoje, 'spend')]).toEqual(['48.37', '50.00']);
      expect([valor(ontem, 'conversations_started', '7d_click'), valor(hoje, 'conversations_started', '7d_click')]).toEqual(['10', '0']);
    });
  });

  it('token recusado desliga a leitura (vira alerta); limite da plataforma só reagenda', async () => {
    contas.vencida = await contaCom('act_5550000002', 'token-vencido');
    contas.limite = await contaCom('act_5550000001', 'token-limite');
    const agora = new Date('2026-09-22T16:00:00Z');
    const r = await loop.executarLote(5, { tenantIds: [tenantId] }, agora);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.status === 'falhou')).toBe(true);

    const situacao = await ownerQuery<{ id: string; status: string; status_reason: string | null }>(
      `select id, status, status_reason from liame.connected_account where id in ($1, $2)`,
      [contas.vencida, contas.limite],
    );
    expect(situacao.find((s) => s.id === contas.vencida)).toMatchObject({ status: 'desconectada', status_reason: 'A plataforma recusou a autorização: conecte de novo.' });
    expect(situacao.find((s) => s.id === contas.limite)).toMatchObject({ status: 'ativa' });
    const [limite] = await ownerQuery<{ cursor: Record<string, unknown>; last_error: string }>(
      `select cursor, last_error from liame.sync_state where connected_account_id = $1 and dataset = 'metricas'`,
      [contas.limite],
    );
    // Sem o cabeçalho de uso, a Meta não diz quanto esperar: vale a espera padrão do cliente (1 min).
    expect(limite!.cursor).toMatchObject({ proxima: '2026-09-22T16:01:00.000Z', falhas_seguidas: 1 });
    expect(limite!.last_error).toMatch(/^limite: /);
    expect(limite!.last_error).not.toContain('token');
    const [falha] = await ownerQuery<{ status: string; error: string }>(`select status, error from liame.sync_run where connected_account_id = $1`, [contas.vencida]);
    expect(falha).toMatchObject({ status: 'falhou', error: expect.stringMatching(/^autenticacao: /) });

    // Desconectada não volta para a fila sozinha: espera a pessoa conectar de novo.
    await devidaAgora(contas.vencida);
    await devidaAgora(contas.limite);
    await ownerQuery(`update liame.sync_state set cursor = cursor || '{"proxima": "2999-01-01T00:00:00Z"}'::jsonb where connected_account_id = $1 and dataset = 'metricas'`, [contas.boa]);
    const [a, b] = await Promise.all([loop.executarLote(5, { tenantIds: [tenantId] }), loop.executarLote(5, { tenantIds: [tenantId] })]);
    // Duas execuções ao mesmo tempo: a conta devida (a do limite) vai para uma só.
    expect(a!.length + b!.length).toBe(1);
  });

  it('outra empresa não vê o frescor nem as métricas desta', async () => {
    const outra = await signupAndLogin(api, undefined, 'Outra Casa Sincronização');
    await enableMfa(api, outra.cookie);
    const frescor = await api.call('GET', '/v1/media/freshness', { cookie: outra.cookie });
    expect(frescor.body.items).toEqual([]);
    const metricas = await api.call('GET', '/v1/media/metrics?from=2026-09-19&to=2026-09-19', { cookie: outra.cookie });
    expect(metricas.body).toEqual({ items: [], has_more: false });
  });
});
