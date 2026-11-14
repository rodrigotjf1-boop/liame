import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { conjuntosNaMeta } from '../../src/campanhas/conjuntos-na-meta.js';
import { impressaoDoPublico } from '../../src/campanhas/teste-regiao-plano.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComMeta, empresaComMeta, ligarFlagDaEmpresa, MetaDeMentira, SEGREDO_DO_APP_DA_META } from '../helpers/meta-de-mentira.js';
import { lojaComCardapio } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// Plano da região, R8: o pedido do teste de região (D-RG-81 e D-RG-82; migration 0159), contra Postgres e uma Graph de
// mentira que devolve os conjuntos ativos da conta com o público. O que se prova:
//   - só com a função; o bairro com menos de 15 pedidos por semana não é pedido, com o motivo;
//   - a campanha criada fora do Liame que mostra anúncio no bairro segura o pedido, com o motivo; a campanha ativa do
//     Google que não é a do Liame com um raio conhecido também (o lado seguro); a falha da leitura na Meta sai na frase
//     de sempre;
//   - o pedido certo guarda o teste com cada conjunto do Liame que alcança o bairro (o público de antes, inteiro, e a
//     impressão dos campos que o Liame controla), mostra os pedidos por bairro das 4 semanas, e espera o código do app em
//     Aprovações; o conjunto do Liame longe do bairro fica de fora; um teste por vez na marca;
//   - aprovar só marca o teste como pronto: nada é escrito na Meta.

const CARDAPIO = 'https://cardapio.exemplo.com.br/mister-centro';
// A Loja Centro e a Lapa: o centro do bairro a uns 1,2 km da loja.
const LOJA = { latitude: -22.906847, longitude: -43.172897 };
const LAPA = { latitude: -22.9133, longitude: -43.1825 };
const circulo = (p: { latitude: number; longitude: number }, radius: number) => ({ geo_locations: { custom_locations: [{ ...p, radius, distance_unit: 'kilometer' }], location_types: ['home', 'recent'] }, age_min: 18 });

/** Uma Graph de mentira: os conjuntos ativos da conta, com o público; e quantas escritas chegaram (nenhuma, aqui). */
class GraphDosConjuntos {
  base = '';
  conjuntos: Array<Record<string, unknown>> = [];
  falha: { status: number; corpo: unknown } | null = null;
  escritas = 0;
  private servidor: Server | null = null;

  async ligar(): Promise<void> {
    this.servidor = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.base);
      if (req.method !== 'GET') this.escritas += 1;
      const responder = (status: number, corpo: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      if (this.falha) return responder(this.falha.status, this.falha.corpo);
      if (/^\/graph\/v\d+\.\d+\/act_\d+\/adsets$/.test(url.pathname) && (url.searchParams.get('fields') ?? '').includes('targeting')) return responder(200, { data: this.conjuntos });
      return responder(404, { error: { code: 100, message: 'Unknown path' } });
    });
    await new Promise<void>((ok) => this.servidor!.listen(0, '127.0.0.1', () => ok()));
    this.base = `http://127.0.0.1:${(this.servidor!.address() as AddressInfo).port}`;
  }

  async desligar(): Promise<void> {
    await new Promise<void>((ok) => (this.servidor ? this.servidor.close(() => ok()) : ok()));
  }
}

describe.skipIf(!hasDb)('o pedido do teste de região (plano da região, R8)', () => {
  let api: TestApi;
  let executor: ActionExecutor;
  const meta = new MetaDeMentira();
  const graph = new GraphDosConjuntos();

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    await graph.ligar();
    const database: Database = api.app.get(DATABASE);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), api.app.get(FlagService));
    const vault = api.app.get(VaultService);
    conjuntosNaMeta.ligar({
      lerSegredo: (tx, id) => vault.readSecret(tx, id),
      cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [`${graph.base}/graph`] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
      graphUrl: `${graph.base}/graph`,
      appSecret: SEGREDO_DO_APP_DA_META,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    });
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    graph.falha = null;
  });
  afterAll(async () => {
    await meta.desligar();
    await graph.desligar();
    await api?.close();
  });

  /** Liga a função do teste de região para a empresa (ela ainda não está na lista do ajudante comum). */
  async function ligarFuncao(tenantId: string): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'teste_de_regiao' and scope_type = 'tenant' and scope_id = $1`, [tenantId]);
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
       values (gen_random_uuid(), 'teste_de_regiao', 'tenant', $1, 'true'::jsonb, null, 'testes')`,
      [tenantId],
    );
    api.app.get(FlagService).invalidate();
  }

  type Cenario = EmpresaComMeta & { unitId: string; regem: string; cidade: string; codigos: Record<string, string> };

  /** A empresa com a Meta, a loja com o Regem, um município de mentira com os bairros e os pedidos por bairro das 4 semanas. */
  async function cenario(nome: string): Promise<Cenario> {
    const e = await empresaComMeta(api, meta, nome);
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.contaSemToken]);
    const { unitId, contaId: regem } = await lojaComCardapio(e, 'Loja Centro', CARDAPIO);
    // O código começa com 9: o teste da R2 não apaga.
    const cidade = String(randomInt(9_100_000, 9_999_999));
    const nomes = ['Centro Teste', 'Lapa Teste', 'Glória Teste', 'Saúde Teste', 'Pouco Teste'];
    const codigos = Object.fromEntries(nomes.map((n, i) => [n, `${cidade}00${i + 1}`]));
    for (const [n, codigo] of Object.entries(codigos)) {
      await ownerQuery(`insert into liame.region_district (district_code, city_code, name, name_key, area_km2, population) values ($1, $2, $3, lower($3), 2.5, 10000)`, [codigo, cidade, n]);
    }
    // O centro da Lapa no mapa (sem a chave da Meta: vai o círculo), e o do bairro com poucos pedidos.
    await ownerQuery(`insert into liame.region_district_point (district_code, located, latitude, longitude) values ($1, 'achado', $2, $3), ($4, 'achado', -22.95, -43.2)`, [
      codigos['Lapa Teste'],
      LAPA.latitude,
      LAPA.longitude,
      codigos['Pouco Teste'],
    ]);
    await ownerQuery(
      `update liame.unit set address_postal_code = '20040002', address_street = 'Rua da Assembleia', address_number = '10', address_district = 'Centro',
              address_city = 'Rio de Janeiro', address_state = 'RJ', ibge_city_code = $2, timezone = 'America/Sao_Paulo', location_source = 'cep',
              latitude = $3, longitude = $4, location_precision = 'endereco' where id = $1`,
      [unitId, cidade, LOJA.latitude, LOJA.longitude],
    );
    // As 4 semanas completas até ontem, como a leitura do Regem guarda: a Lapa com 30 por semana; o "Pouco" com 5.
    const pedidos: Array<[string, number]> = [['Centro Teste', 292], ['Lapa Teste', 120], ['Glória Teste', 60], ['Saúde Teste', 40], ['Pouco Teste', 20]];
    for (const [i, [n, total]] of pedidos.entries()) {
      await ownerQuery(
        `insert into liame.region_order_district (connected_account_id, tenant_id, brand_id, unit_id, position, kind, district, city, uf, orders, day_from, day_to, minimum)
         values ($1, $2, $3, $4, $5, 'bairro', $6, 'Rio de Janeiro', 'RJ', $7, current_date - 28, current_date - 1, 5)`,
        [regem, e.tenantId, e.brandId, unitId, i, n, total],
      );
    }
    await ligarFlagDaEmpresa(api, 'meta_write', e.tenantId, true);
    return { ...e, unitId, regem, cidade, codigos };
  }

  /** Uma campanha que o Liame criou nesta conta (a de um teste de criativo que já terminou e ficou no ar). */
  async function campanhaDoLiame(e: Cenario, metaCampaignId: string): Promise<void> {
    const pagina = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, provider_attributes) values ($1, $2, $3, 'facebook_page', $4, 'Página', '{}'::jsonb)`, [
      pagina,
      e.tenantId,
      e.brandId,
      `10${randomInt(100_000_000, 999_999_999)}`,
    ]);
    await ownerQuery(
      `insert into liame.campaign_test (id, tenant_id, brand_id, unit_id, ad_account_id, page_account_id, kind, status, name, daily_budget_micros, min_days, max_days, plan, meta_campaign_id, active, started_on, ended_on)
       values ($1, $2, $3, $4, $5, $6, 'criativo', 'terminado', 'Combo sexta: a foto ou a outra', 40000000, 7, 28, '{}'::jsonb, $7, true, current_date - 30, current_date - 2)`,
      [randomUUID(), e.tenantId, e.brandId, e.unitId, e.conta, pagina, metaCampaignId],
    );
  }

  const pedir = (e: Cenario, bairro: string) => api.call('POST', '/v1/region-tests', { cookie: e.cookie, body: { brand_id: e.brandId, unit_id: e.unitId, district_code: e.codigos[bairro] } });
  const pedidoDe = async (id: string) => (await ownerQuery<{ status: string; plan_hash: string; tool: string; mode: string }>(`select status, plan_hash, tool, mode from liame.action_request where id = $1`, [id]))[0]!;

  it('pedir: só com a função; o bairro com poucos pedidos, a campanha de fora no bairro e a falha da Meta seguram o pedido, com o motivo', async () => {
    const e = await cenario('Brasa Teste Região Recusas');
    await campanhaDoLiame(e, '120210000000000001');
    graph.conjuntos = [{ id: '120210000000000101', name: 'Raio de 3 km', campaign_id: '120210000000000001', effective_status: 'ACTIVE', targeting: circulo(LOJA, 3) }];

    const desligada = await pedir(e, 'Lapa Teste');
    expect([desligada.status, desligada.body.code]).toEqual([409, 'funcao-desligada']);
    await ligarFuncao(e.tenantId);

    const pouco = await pedir(e, 'Pouco Teste');
    expect([pouco.status, pouco.body.code]).toEqual([409, 'bairro-nao-testavel']);
    expect(pouco.body.detail).toContain('5 pedidos por semana');

    // Uma campanha criada direto na Meta, com um círculo que encosta na Lapa.
    graph.conjuntos.push({ id: '120210000000000901', name: 'Promo da semana', campaign_id: '120210000000000009', effective_status: 'ACTIVE', targeting: circulo(LAPA, 1) });
    const deFora = await pedir(e, 'Lapa Teste');
    expect([deFora.status, deFora.body.code]).toEqual([409, 'campanha-de-fora-no-bairro']);
    expect(deFora.body.detail).toContain('“Promo da semana”');

    // Uma campanha do Google ativa que o Liame não criou com um raio: o Liame não lê os lugares dela, então ela conta como
    // "alcança" (o lado seguro), com o nome dela. Pausada, deixa de contar.
    graph.conjuntos = graph.conjuntos.filter((c) => c.name !== 'Promo da semana');
    const contaDoGoogle = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name) values ($1, $2, $3, 'google_ads', $4, 'Google Ads da marca')`, [
      contaDoGoogle,
      e.tenantId,
      e.brandId,
      String(randomInt(1_000_000_000, 9_999_999_999)),
    ]);
    const campanhaDoGoogle = randomUUID();
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'google_ads', '20000000001', 'Busca da marca', 'ativa')`, [
      campanhaDoGoogle,
      e.tenantId,
      contaDoGoogle,
    ]);
    const doGoogle = await pedir(e, 'Lapa Teste');
    expect([doGoogle.status, doGoogle.body.code]).toEqual([409, 'google-no-bairro']);
    expect(doGoogle.body.detail).toContain('“Busca da marca”');
    await ownerQuery(`update liame.campaign set status = 'pausada' where id = $1`, [campanhaDoGoogle]);

    // A Meta recusa a autorização da conta: a frase de sempre (conectar de novo).
    graph.falha = { status: 400, corpo: { error: { code: 190, type: 'OAuthException', message: 'Error validating access token' } } };
    const semAcesso = await pedir(e, 'Lapa Teste');
    expect([semAcesso.status, semAcesso.body.code]).toEqual([409, 'conta-desconectada']);
    expect(await ownerQuery(`select 1 from liame.campaign_test where tenant_id = $1 and kind = 'regiao'`, [e.tenantId])).toHaveLength(0);
  }, 120_000);

  it('o pedido certo: o teste com cada conjunto do Liame no bairro e o público de antes; um teste por vez; aprovar só marca como pronto', async () => {
    const e = await cenario('Brasa Teste Região');
    await ligarFuncao(e.tenantId);
    await campanhaDoLiame(e, '120210000000000001');
    const raio = circulo(LOJA, 3);
    graph.conjuntos = [
      { id: '120210000000000101', name: 'Raio de 3 km', campaign_id: '120210000000000001', effective_status: 'ACTIVE', targeting: raio },
      // Do Liame, mas longe da Lapa: fica de fora do teste.
      { id: '120210000000000102', name: 'Raio da Barra', campaign_id: '120210000000000001', effective_status: 'ACTIVE', targeting: circulo({ latitude: -23.0, longitude: -43.4 }, 2) },
      // De fora do Liame, longe da Lapa: não segura o pedido.
      { id: '120210000000000901', name: 'Promo da Barra', campaign_id: '120210000000000009', effective_status: 'ACTIVE', targeting: circulo({ latitude: -23.0, longitude: -43.4 }, 2) },
    ];
    const r = await pedir(e, 'Lapa Teste');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      name: 'Lapa Teste sem anúncio por 14 dias',
      status: 'pedido',
      district: { code: e.codigos['Lapa Teste'], name: 'Lapa Teste', meta: false, radius_km: 1 },
      days: 14,
      ad_sets: [{ campaign_id: '120210000000000001', ad_set_id: '120210000000000101', name: 'Raio de 3 km', status: 'a_tirar' }],
      started_on: null,
    });
    const semanas = r.body.weeks as { districts: Array<{ name: string; orders: number; target: boolean }> };
    expect(semanas.districts.map((d) => [d.name, d.orders, d.target])).toEqual([
      ['Centro Teste', 292, false],
      ['Lapa Teste', 120, true],
      ['Glória Teste', 60, false],
      ['Saúde Teste', 40, false],
      ['Pouco Teste', 20, false],
    ]);
    // O público de antes fica guardado inteiro, com a impressão dos campos que o Liame controla.
    const [alvo] = await ownerQuery<{ targeting_before: unknown; fingerprint_before: string; status: string }>(
      `select targeting_before, fingerprint_before, status from liame.campaign_test_target where test_id = $1`,
      [r.body.id],
    );
    expect(alvo).toEqual({ targeting_before: raio, fingerprint_before: impressaoDoPublico(raio), status: 'a_tirar' });
    const pedido = await pedidoDe(r.body.action_id as string);
    expect([pedido.tool, pedido.status, pedido.mode]).toEqual(['teste_de_regiao', 'aguardando_aprovacao', 'APPROVAL']);

    // Um teste por vez na marca.
    const outro = await pedir(e, 'Lapa Teste');
    expect([outro.status, outro.body.code]).toEqual([409, 'outro-teste']);

    // Aprovar com o código do app só marca o teste como pronto: nada é escrito na Meta.
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    const aprovar = await api.call('POST', `/v1/actions/${r.body.action_id}/approve`, { cookie: e.cookie, body: { plan_hash: pedido.plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect(aprovar.status, JSON.stringify(aprovar.body)).toBe(200);
    await executor.executeBatch(20, { tenantIds: [e.tenantId] });
    expect((await pedidoDe(r.body.action_id as string)).status).toBe('executada');
    const lido = await api.call('GET', `/v1/region-tests/${r.body.id}`, { cookie: e.cookie });
    expect(lido.status, JSON.stringify(lido.body)).toBe(200);
    expect(lido.body).toMatchObject({ status: 'pronto', action_id: r.body.action_id });
    expect(graph.escritas).toBe(0);
  }, 120_000);
});
