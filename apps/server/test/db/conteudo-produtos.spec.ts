import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diasAntes } from '../../src/regiao/demanda.js';
import { diaEmBrasilia } from '../../src/regiao/semana.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// Plano de conteúdo, PC4, parte 1 (migration 0171), contra Postgres: a rota `GET /v1/content/products` agrupa os itens
// dos pedidos do Regem pelo código do produto (o item sem código entra pelo nome quando o nome só aparece com um código),
// conta o pedido confirmado no dia do pedido do cliente, no fuso da loja, nas 4 semanas completas até ontem, compara com
// as 4 antes, procura o produto nas legendas do Instagram e em Fotos, e só responde com a função `plano_conteudo`
// ligada, o Regem ligado na marca e `vendas.ver`.

/** Hoje em Brasília, pelo relógio de verdade (a rota não recebe o relógio do teste; o setup segura a meia-noite, V89). */
const HOJE = diaEmBrasilia(new Date());
const DIA = diasAntes(HOJE, 3);
const ANTES = diasAntes(HOJE, 40);

describe.skipIf(!hasDb)('Plano de conteúdo: o ranking dos produtos pelo código do Regem (PC4, parte 1)', () => {
  let api: TestApi;
  let cookie: string;
  let tenantId: string;
  let brandId: string;
  const loja = randomUUID();
  const outraLoja = randomUUID();
  const contaRegem = randomUUID();
  const contaInstagram = randomUUID();

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Ranking dos produtos');
    cookie = s.cookie;
    await enableMfa(api, cookie);
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Tijuca'), ($4, $2, $3, 'Loja Penha')`, [loja, tenantId, brandId, outraLoja]);
  }, 120_000);

  afterAll(async () => {
    await ligarFlagDaEmpresa(api, 'plano_conteudo', tenantId, false);
    await api?.close();
  });

  const ranking = (unidade?: string) => api.call('GET', `/v1/content/products?brand_id=${brandId}${unidade ? `&unit_id=${unidade}` : ''}`, { cookie });

  /** Um pedido confirmado (ou não) com os itens: [código ou nulo, nome, quantidade, reais, custo em reais ou nulo]. */
  async function pedido(dia: string, itens: Array<[string | null, string, number, number, number | null]>, o: { status?: string; unidade?: string; canal?: string } = {}) {
    const id = randomUUID();
    const total = itens.reduce((t, i) => t + i[3], 0);
    await ownerQuery(
      `insert into liame.order_fact (id, tenant_id, brand_id, unit_id, connected_account_id, provider, external_id, channel, channel_group, status, currency, timezone,
                                     revenue_micros, placed_at, confirmed_at, cancelled_at, source_version, source_updated_at)
       values ($1, $2, $3, $4, $5, 'regem', $6, $7, $7, $8::text, 'BRL', 'America/Sao_Paulo', $9, $10::timestamptz, $10::timestamptz + interval '3 minutes',
               case when $8::text = 'cancelado' then $10::timestamptz + interval '10 minutes' end, 1, now())`,
      [id, tenantId, brandId, o.unidade ?? loja, contaRegem, `p-${id.slice(0, 12)}`, o.canal ?? 'cardapio', o.status ?? 'confirmado', total * 1_000_000, `${dia}T20:00:00-03:00`],
    );
    for (const [codigo, nome, qtd, reais, custo] of itens) {
      await ownerQuery(
        `insert into liame.order_item_fact (id, tenant_id, order_id, external_id, product_external_id, name, quantity, revenue_micros, cost_micros)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, id, `i-${randomUUID().slice(0, 12)}`, codigo, nome, qtd, reais * 1_000_000, custo === null ? null : custo * 1_000_000],
      );
    }
  }

  it('desligada, sem o Regem e sem pedidos: só a disponibilidade; a loja de outra marca é 404', async () => {
    const desligada = await ranking();
    expect(desligada.status, JSON.stringify(desligada.body)).toBe(200);
    expect(desligada.body).toMatchObject({ brand_id: brandId, unit_id: null, availability: { status: 'desligado_pela_liame' }, ranking: null });

    await ligarFlagDaEmpresa(api, 'plano_conteudo', tenantId, true);
    expect((await ranking()).body).toMatchObject({ availability: { status: 'sem_regem' }, ranking: null });

    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'regem', $4, 'Loja Tijuca', 'BRL', 'America/Sao_Paulo')`,
      [contaRegem, tenantId, brandId, `loja-${randomUUID().slice(0, 8)}`],
    );
    const vazio = await ranking();
    expect(vazio.body).toMatchObject({ availability: { status: 'disponivel' }, ranking: { status: 'sem_pedidos', orders: 0, products: [], from: diasAntes(HOJE, 28), to: diasAntes(HOJE, 1) } });

    expect((await ranking(randomUUID())).status).toBe(404);
  });

  it('agrupa pelo código, junta o item sem código pelo nome, compara as janelas e acha o produto no Instagram e em Fotos', async () => {
    // O TRIO 08 em três nomes: o do cardápio, o do iFood e um item sem código com o nome que só aparece com o código dele.
    for (let i = 0; i < 12; i++) await pedido(DIA, [['trio-08', 'TRIO 08', 1, 35, 20]]);
    for (let i = 0; i < 8; i++) await pedido(DIA, [['trio-08', 'Trio 08 - Burguer + Batata + Refri', 1, 38, 21]], { canal: 'marketplace' });
    for (let i = 0; i < 3; i++) await pedido(DIA, [[null, 'Trio 08 - Burguer + Batata + Refri', 1, 38, null]], { canal: 'marketplace' });
    // A batata, com custo em todas as linhas; e um pedido com dois itens (a batata conta um pedido, duas unidades).
    for (let i = 0; i < 5; i++) await pedido(DIA, [['batata-g', 'Batata Frita - Grande', 1, 15, 4]]);
    await pedido(DIA, [['batata-g', 'Batata Frita - Grande', 2, 30, 8], ['trio-08', 'TRIO 08', 1, 35, 20]]);
    // O "Numero 07" sem código nenhum: fica em "sem código".
    for (let i = 0; i < 2; i++) await pedido(DIA, [[null, 'Numero 07', 1, 30, null]], { canal: 'marketplace' });
    // Não contam: o cancelado, o de hoje e o item tirado do pedido.
    await pedido(DIA, [['trio-08', 'TRIO 08', 1, 35, 20]], { status: 'cancelado' });
    await pedido(HOJE, [['trio-08', 'TRIO 08', 1, 35, 20]]);
    // A janela anterior: o TRIO 08 vendia 10.
    for (let i = 0; i < 10; i++) await pedido(ANTES, [['trio-08', 'TRIO 08', 1, 35, 20]]);
    // Outra loja da marca: entra na marca inteira, não na loja.
    await pedido(DIA, [['batata-g', 'Batata Frita - Grande', 1, 15, 4]], { unidade: outraLoja });

    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'instagram', $4, 'misterburgers', 'BRL', 'America/Sao_Paulo')`,
      [contaInstagram, tenantId, brandId, `ig-${randomUUID().slice(0, 8)}`],
    );
    await ownerQuery(
      `insert into liame.instagram_media (connected_account_id, tenant_id, brand_id, media_id, kind, caption, published_at)
       values ($1, $2, $3, 'm1', 'foto', 'Hoje tem Trio 8! Peça pelo link', $4::timestamptz), ($1, $2, $3, 'm2', 'reels', 'Bastidor da cozinha', $5::timestamptz)`,
      [contaInstagram, tenantId, brandId, `${diasAntes(HOJE, 5)}T18:00:00-03:00`, `${diasAntes(HOJE, 2)}T18:00:00-03:00`],
    );
    await ownerQuery(
      `insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height, product, description)
       values (gen_random_uuid(), $1, $2, 'pronta', $3, $4, 1000, 800, 800, 'Batata frita grande', 'de perto')`,
      [tenantId, brandId, `t/${tenantId}/b/${brandId}/foto_produto/${randomUUID()}.jpg`, 'a'.repeat(64)],
    );

    const r = await ranking(loja);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const k = r.body.ranking;
    // 12 + 8 + 3 + 5 + 1 + 2 = 31 pedidos confirmados da loja na janela.
    expect(k).toMatchObject({ status: 'pronto', orders: 31, products_total: 2, without_code: { orders: 2, revenue_micros: '60000000', names: ['Numero 07'] } });
    const trio = k.products.find((p: { code: string }) => p.code === 'trio-08');
    expect(trio).toMatchObject({
      rank: 1,
      name: 'TRIO 08',
      other_names: ['Trio 08 - Burguer + Batata + Refri'],
      // 12 + 8 + 3 (pelo nome) + 1 (no pedido com a batata) = 24; antes, 10: +140%.
      orders: 24,
      quantity: '24',
      revenue_micros: String((12 * 35 + 8 * 38 + 3 * 38 + 35) * 1_000_000),
      previous: { orders: 10, quantity: '10', revenue_micros: '350000000' },
      trend: 'subindo',
      trend_percent: 140,
      // Os 3 itens sem código não têm custo: sem a margem.
      margin_micros: null,
      seen: { instagram_posts: 1, last_post_at: diasAntes(HOJE, 5), photos: 0 },
      highlights: ['subindo'],
    });
    const batata = k.products.find((p: { code: string }) => p.code === 'batata-g');
    expect(batata).toMatchObject({
      rank: 2,
      orders: 6,
      quantity: '7',
      revenue_micros: '105000000',
      // 105 − 28 = 77 reais de margem: 73,3%.
      margin_micros: '77000000',
      margin_percent: 73.3,
      trend: 'novo',
      seen: { instagram_posts: 0, last_post_at: null, photos: 1 },
      highlights: [],
    });

    // A marca inteira soma a outra loja.
    const marca = await ranking();
    expect(marca.body.ranking.orders).toBe(32);
    expect(marca.body.ranking.products.find((p: { code: string }) => p.code === 'batata-g').orders).toBe(7);
  });
});
