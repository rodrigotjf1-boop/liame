import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gerarChave } from '../../src/connectors/dms/integracao-dms.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { hasDb } from './env.js';

// Plano de conteúdo, PC4, parte 2, contra Postgres, com o DMS ID e o Pulso de mentira num servidor local: a rota
// `GET /v1/content/dates` junta o calendário comercial do Liame com os eventos do Pulso do município da loja e o "Em
// alta"; o Pulso recebe só o código do município (nada da loja, da marca ou de pessoa), com o token do aplicativo do
// Liame e a ligação; sem município, desligada ou com o Pulso fora do ar, as datas do Liame valem e a resposta diz por quê.

const APLICATIVO = 'aplicativo-do-liame';
const VALOR_DO_APLICATIVO = 'valor-de-teste-do-aplicativo-liame';
const RIO = '3304557';

describe.skipIf(!hasDb)('Plano de conteúdo: as datas e as tendências pelo Pulso (PC4, parte 2)', () => {
  let api: TestApi;
  let cookie: string;
  let tenantId: string;
  let brandId: string;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const ligacao = gerarChave('lg', 'pulso').chave;
  const lojaNoMapa = randomUUID();
  /** Os pedidos que o Pulso recebeu: o caminho com a consulta e os cabeçalhos de autorização. */
  let pedidos: Array<{ url: string; autorizacao: string; ligacao: string }> = [];
  let foraDoAr = false;

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      const json = (status: number, corpo: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(corpo));
      };
      const url = req.url ?? '';
      if (url === '/dmsid/oidc/token') return json(200, { access_token: 'token-do-dms-id', expires_in: 3600 });
      pedidos.push({ url, autorizacao: String(req.headers.authorization ?? ''), ligacao: String(req.headers['dms-ligacao'] ?? '') });
      if (foraDoAr) return json(503, { type: 'https://dev.dmstecnologias.com/erros/fora-do-ar', title: 'fora', status: 503 });
      const u = new URL(url, base);
      if (u.pathname === '/v1/eventos') {
        return json(200, {
          eventos: [
            { id: 'e1', chave: 'k1', tipo: 'feriado', nome: 'Dia de São Sebastião', dia_inteiro: true, inicio: u.searchParams.get('de'), fim: u.searchParams.get('de'), fuso: 'America/Sao_Paulo', abrangencia: [{ nivel: 'municipio', valor: RIO }], situacao: 'confirmado', detalhes: null, fonte: { nome: 'Lei municipal', endereco: 'https://leis.rio/x' } },
            { id: 'e2', chave: 'k2', tipo: 'comemorativa', nome: 'Dia do Hambúrguer', dia_inteiro: true, inicio: u.searchParams.get('de'), fim: u.searchParams.get('de'), fuso: 'America/Sao_Paulo', abrangencia: [{ nivel: 'nacional', valor: 'BR' }], situacao: 'confirmado', detalhes: { grupo: 'comida', tema: 'hamburguer' }, fonte: { nome: 'Curadoria da DMS', endereco: null } },
            // Torto: sem nome. Fica de fora sem derrubar a resposta.
            { id: 'e3', tipo: 'jogo', dia_inteiro: true, inicio: '2026-12-01', fim: null, fuso: 'America/Sao_Paulo', abrangencia: [], fonte: { nome: 'x' } },
          ],
        });
      }
      if (u.pathname === '/v1/em-alta') {
        return json(200, { assuntos: [{ id: '1', titulo: 'Calor no Rio', nota: 75, faixa: 'alta', monte: 'em_alta', temas: [], onde: { nivel: 'uf', valor: 'RJ' }, manchetes: [{ titulo: 'Rio tem o dia mais quente', link: 'https://g1.globo.com/rj/x', fonte: 'g1' }] }] });
      }
      return json(404, { detail: 'rota inesperada' });
    });
    await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', pronto));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    for (const [nome, valor] of [
      ['PULSO_URL', `${base}/v1`],
      ['PULSO_LIGACAO', ligacao],
      ['DMS_ID_EMISSOR', `${base}/dmsid/oidc`],
      ['DMS_ID_APLICATIVO', APLICATIVO],
      ['DMS_ID_SEGREDO', VALOR_DO_APLICATIVO],
    ] as const) {
      anterior[nome] = process.env[nome];
      process.env[nome] = valor;
    }
    api = await startApi();
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Datas do plano');
    cookie = s.cookie;
    await enableMfa(api, cookie);
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_district, address_city, address_state, ibge_city_code, location_source, delivery_radius_km)
       values ($1, $2, $3, 'Loja Tijuca', '20520054', 'Tijuca', 'Rio de Janeiro', 'RJ', $4, 'cep', 3)`,
      [lojaNoMapa, tenantId, brandId, RIO],
    );
  }, 120_000);

  beforeEach(() => {
    pedidos = [];
    foraDoAr = false;
  });

  afterAll(async () => {
    await ligarFlagDaEmpresa(api, 'plano_conteudo', tenantId, false);
    await api?.close();
    await new Promise((pronto) => servidor?.close(pronto));
    for (const [nome, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  });

  const datas = (consulta: string) => api.call('GET', `/v1/content/dates?brand_id=${brandId}${consulta}`, { cookie });

  it('desligada, só a disponibilidade e nenhum pedido ao Pulso; o período torto é 400 ou 422', async () => {
    const r = await datas('&from=2026-12-20&to=2026-12-31');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ availability: { status: 'desligado_pela_liame' }, pulse_status: 'desligado', dates: [], trends: [] });
    expect(pedidos).toEqual([]);
    await ligarFlagDaEmpresa(api, 'plano_conteudo', tenantId, true);
    expect([400, 422]).toContain((await datas('&from=2026-12-31&to=2026-12-20')).status);
    expect([400, 422]).toContain((await datas('&from=2026-12-01&to=2027-03-01')).status);
  });

  it('com o Pulso: as datas do Liame e as do município, o dia de comida que combina e o "Em alta"; o Pulso recebe só o município', async () => {
    await ligarFlagDaEmpresa(api, 'plano_conteudo', tenantId, true);
    // Um pedido com "Burger" no nome: o Dia do Hambúrguer combina com o cardápio.
    const conta = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'regem', $4, 'Loja', 'BRL', 'America/Sao_Paulo')`,
      [conta, tenantId, brandId, `loja-${randomUUID().slice(0, 8)}`],
    );
    const pedido = randomUUID();
    await ownerQuery(
      `insert into liame.order_fact (id, tenant_id, brand_id, unit_id, connected_account_id, provider, external_id, channel, channel_group, status, currency, timezone,
                                     revenue_micros, placed_at, confirmed_at, source_version, source_updated_at)
       values ($1, $2, $3, $4, $5, 'regem', $6, 'cardapio', 'cardapio', 'confirmado', 'BRL', 'America/Sao_Paulo', 35000000, now() - interval '2 days', now() - interval '2 days', 1, now())`,
      [pedido, tenantId, brandId, lojaNoMapa, conta, `p-${pedido.slice(0, 8)}`],
    );
    await ownerQuery(
      `insert into liame.order_item_fact (id, tenant_id, order_id, external_id, product_external_id, name, quantity, revenue_micros) values (gen_random_uuid(), $1, $2, 'i1', 'trio-08', 'Burger 08 Trio', 1, 35000000)`,
      [tenantId, pedido],
    );

    const r = await datas('&from=2026-12-20&to=2026-12-31');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      availability: { status: 'disponivel' },
      pulse_status: 'em_dia',
      from: '2026-12-20',
      to: '2026-12-31',
      municipality: { ibge_code: RIO, name: 'Rio de Janeiro', state: 'RJ' },
    });
    const nomes = r.body.dates.map((d: { name: string; origin: string }) => `${d.name}|${d.origin}`);
    expect(nomes).toEqual(expect.arrayContaining(['Dia de São Sebastião|pulso', 'Dia do Hambúrguer|pulso', 'Natal|liame', 'Véspera de Natal|liame', 'Réveillon|liame']));
    expect(r.body.dates.find((d: { name: string }) => d.name === 'Dia do Hambúrguer')).toMatchObject({ kind: 'comida', food_theme: 'hamburguer', menu_match: true });
    expect(r.body.dates.find((d: { name: string }) => d.name === 'Dia de São Sebastião')).toMatchObject({ kind: 'feriado', scope: 'municipio', source: { name: 'Lei municipal', url: 'https://leis.rio/x' } });
    expect(r.body.trends).toEqual([{ title: 'Calor no Rio', score: 75, band: 'alta', pile: 'em_alta', scope: 'uf', headlines: [{ title: 'Rio tem o dia mais quente', url: 'https://g1.globo.com/rj/x', source: 'g1' }] }]);

    // O Pulso recebeu só o município e o período, com o token e a ligação; nada da loja, da marca ou da empresa.
    expect(pedidos.map((p) => p.url).sort()).toEqual([`/v1/em-alta?municipio=${RIO}`, `/v1/eventos?municipio=${RIO}&de=2026-12-20&ate=2026-12-31`]);
    for (const p of pedidos) {
      expect(p.autorizacao).toBe('Bearer token-do-dms-id');
      expect(p.ligacao).toBe(ligacao);
      expect(p.url).not.toContain(brandId);
      expect(p.url).not.toContain(tenantId);
    }

    // A mesma pergunta de novo vem da memória (uma hora): o Pulso não é chamado outra vez.
    pedidos = [];
    expect((await datas('&from=2026-12-20&to=2026-12-31')).status).toBe(200);
    expect(pedidos).toEqual([]);
  });

  it('com o Pulso fora do ar, as datas do Liame valem e a resposta diz "falhou"', async () => {
    await ligarFlagDaEmpresa(api, 'plano_conteudo', tenantId, true);
    foraDoAr = true;
    const r = await datas('&from=2027-02-01&to=2027-02-28');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ pulse_status: 'falhou', trends: [] });
    expect(r.body.dates.map((d: { name: string }) => d.name)).toEqual(['Carnaval']);
  });
});
