import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { campanhaParou, gastoForaDoNormal, type ItemAtencao, ordenar } from '../../src/media/atencao.js';
import { hojeNoFuso } from '../../src/media/sincronizador.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb } from './env.js';

// A2 · G9 (API): "Atenção de mídia" — regras explicáveis sobre os dados da própria empresa, mais grave
// primeiro, sem nada de outra empresa.

const dia = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('regras da atenção de mídia', () => {
  const conta = { id: randomUUID(), name: 'Casa Brasa', provider: 'meta_ads', currency: 'BRL' };
  const ontem = '2026-09-26';
  const historico = (valor: number, dias = 14) => new Map(Array.from({ length: dias }, (_, i) => [dia(ontem, -(i + 1)), valor] as const));

  it('gasto fora do normal: acima de 2× ou abaixo de 30% da mediana; sem histórico, nada', () => {
    const alto = historico(50).set(ontem, 150);
    expect(gastoForaDoNormal(conta, alto, ontem)).toMatchObject({ kind: 'gasto_fora_do_normal', severity: 'critica', detail: expect.stringMatching(/R\$\s?150,00 ontem; o normal dos últimos 14 dias é R\$\s?50,00/) });
    expect(gastoForaDoNormal(conta, historico(50).set(ontem, 10), ontem)).toMatchObject({ severity: 'atencao', title: 'Gasto baixo ontem em Casa Brasa' });
    expect(gastoForaDoNormal(conta, historico(50).set(ontem, 80), ontem)).toBeNull();
    expect(gastoForaDoNormal(conta, historico(50, 5).set(ontem, 500), ontem)).toBeNull();
    // Dia sem linha é zero (a leitura grava o zero): gasto zerado ontem é "baixo".
    expect(gastoForaDoNormal(conta, historico(50), ontem)).toMatchObject({ severity: 'atencao' });
  });

  it('campanha que parou: entregava 100+ por dia na semana e ontem não entregou', () => {
    const campanha = { id: randomUUID(), name: 'Delivery noite', connectedAccountId: conta.id, provider: 'meta_ads' };
    const semana = new Map(Array.from({ length: 7 }, (_, i) => [dia(ontem, -(i + 1)), 500] as const));
    expect(campanhaParou(campanha, semana, ontem)).toMatchObject({ kind: 'campanha_parou', severity: 'critica', detail: expect.stringContaining('500 por dia') });
    expect(campanhaParou(campanha, new Map<string, number>(semana).set(ontem, 12), ontem)).toBeNull();
    expect(campanhaParou(campanha, new Map(Array.from({ length: 7 }, (_, i) => [dia(ontem, -(i + 1)), 20] as const)), ontem)).toBeNull();
  });

  it('ordem: crítica, atenção, informação; na mesma gravidade, pela prioridade do tipo', () => {
    const item = (kind: ItemAtencao['kind'], severity: ItemAtencao['severity']): ItemAtencao => ({ kind, severity, title: kind, detail: '', action: '', connected_account_id: null, campaign_id: null, provider: null });
    expect(ordenar([item('versao_api', 'info'), item('dado_atrasado', 'atencao'), item('campanha_parou', 'critica'), item('conta_desconectada', 'critica')]).map((i) => i.kind)).toEqual([
      'conta_desconectada',
      'campanha_parou',
      'dado_atrasado',
      'versao_api',
    ]);
  });
});

describe.skipIf(!hasDb)('atenção de mídia pela API', () => {
  let api: TestApi;
  const versaoTeste = `vteste${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await ownerQuery(`delete from liame.watch_alert where api_version = $1`, [versaoTeste]);
    await api?.close();
  });

  it('junta as regras sobre os dados da empresa, mais grave primeiro; outra empresa não vê nada', async () => {
    const s = await signupAndLogin(api, undefined, 'Casa Brasa Atenção');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const brandId = marca!.id;
    const conta = async (nome: string, provider: string, status = 'ativa', connectionId: string | null = null) => {
      const id = randomUUID();
      await ownerQuery(
        `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, status, status_reason, connection_id)
         values ($1, $2, $3, $4, $5, $6, 'BRL', 'America/Sao_Paulo', $7, $8, $9)`,
        [id, tenantId, brandId, provider, `ext_${id.slice(0, 8)}`, nome, status, status === 'desconectada' ? 'A plataforma recusou a autorização: conecte de novo.' : null, connectionId],
      );
      return id;
    };
    const sincronizada = (id: string, horasAtras: number) =>
      ownerQuery(
        `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at)
         values ($1, 'metricas', $2, 1440, now() - make_interval(hours => $3))`,
        [id, tenantId, horasAtras],
      );

    // Conta Meta em dia: gasto alto ontem e uma campanha que parou.
    const meta = await conta('Casa Brasa Meta', 'meta_ads');
    await sincronizada(meta, 2);
    const campanha = randomUUID();
    const grupo = randomUUID();
    const anuncio = randomUUID();
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', 'c1', 'Delivery noite', 'ativa')`, [campanha, tenantId, meta]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'g1', 'Bairros', 'ativa')`, [grupo, tenantId, meta, campanha]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'a1', 'Combo', 'ativa')`, [anuncio, tenantId, meta, grupo]);
    const ontem = dia(hojeNoFuso(new Date(), 'America/Sao_Paulo'), -1);
    const pontos: [string, string, number][] = [];
    for (let i = 1; i <= 14; i++) pontos.push([dia(ontem, -i), 'spend', 50]);
    pontos.push([ontem, 'spend', 150]);
    for (let i = 1; i <= 7; i++) pontos.push([dia(ontem, -i), 'impressions', 500]);
    pontos.push([ontem, 'impressions', 0]);
    for (const [d, nome, valor] of pontos) {
      await ownerQuery(
        `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, observed_at, changed_at)
         values ($1, 'ad', 'a1', $2, $3, '', $4, $5, 'meta_ads', $6, $7, 'BRL', now(), now())`,
        [meta, d, nome, tenantId, brandId, anuncio, valor],
      );
    }

    // Conta desconectada e conta Google atrasada com a autorização vencendo amanhã.
    await conta('Casa Brasa Loja 2', 'meta_ads', 'desconectada');
    const conexao = randomUUID();
    await ownerQuery(
      `insert into liame.oauth_connection (id, tenant_id, brand_id, provider, status, state_hash, redirect_uri, expires_at, refresh_expires_at)
       values ($1, $2, $3, 'google', 'ativa', $4, 'http://api/v1/oauth/callback', now(), now() + interval '1 day')`,
      [conexao, tenantId, brandId, randomUUID().replaceAll('-', '').padEnd(64, '0')],
    );
    const google = await conta('Casa Brasa Google', 'google_ads', 'ativa', conexao);
    await sincronizada(google, 96);

    // Vigia: a Meta vai desligar uma versão.
    await ownerQuery(
      `insert into liame.watch_alert (id, kind, provider, api_version, stage, due_date, message) values ($1, 'versao_expirando', 'meta_ads', $2, '30d', '2026-10-20', 'teste')`,
      [randomUUID(), versaoTeste],
    );

    const r = await api.call('GET', '/v1/media/attention', { cookie: s.cookie });
    expect(r.status).toBe(200);
    // O banco de teste é compartilhado: versões de API de outros testes podem aparecer; conta só a deste.
    const itens = r.body.items.filter((i: { kind: string; title: string }) => i.kind !== 'versao_api' || i.title.includes(versaoTeste));
    expect(itens.map((i: { kind: string; severity: string }) => `${i.severity}:${i.kind}`)).toEqual([
      'critica:conta_desconectada',
      'critica:campanha_parou',
      'critica:gasto_fora_do_normal',
      'critica:dado_atrasado',
      'atencao:reconectar_em_breve',
      'info:versao_api',
    ]);
    expect(r.body.items.find((i: { kind: string }) => i.kind === 'campanha_parou')).toMatchObject({ campaign_id: campanha, connected_account_id: meta, title: 'A campanha "Delivery noite" parou de entregar' });
    expect(itens.find((i: { kind: string }) => i.kind === 'versao_api')).toMatchObject({ title: `A Meta Ads vai desligar a versão ${versaoTeste} da API`, detail: 'Data de fim: 20/10/2026.', action: 'Nada a fazer: o Liame atualiza a integração antes.' });

    const outra = await signupAndLogin(api, undefined, 'Outra Casa Atenção');
    await enableMfa(api, outra.cookie);
    expect((await api.call('GET', '/v1/media/attention', { cookie: outra.cookie })).body.items).toEqual([]);
  });
});
