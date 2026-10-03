import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DATABASE } from '../../src/database/database.module.js';
import { gravarPedidos, type PedidoLido } from '../../src/orders/order-store.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// A3 · I8 de ponta a ponta: o dossiê da marca pela API. Salvar cria versões (e sem mudança, nada); duas pessoas
// a partir da mesma versão: a segunda recebe 409 e mescla; voltar a uma versão é salvar outra; dado pessoal é
// recusado; o banco não deixa a aplicação alterar nem apagar versão; o teste de frase; as sugestões do sistema
// pelas vendas e cupons (usar e descartar, sem voltar a sugerir o recusado); permissão e isolamento.

const FUSO = 'America/Sao_Paulo';
const HORA = 3_600_000;

describe.skipIf(!hasDb)('dossiê da marca (A3 · I8)', () => {
  let api: TestApi;
  let database: Database;
  let cookie = '';
  let tenantId = '';
  let brandId = '';

  const ler = (c = cookie, marca = brandId) => api.call('GET', `/v1/brand-dossier?brand_id=${marca}`, { cookie: c });
  const salvar = (base: number, content: Record<string, unknown>, extra: Record<string, unknown> = {}, c = cookie) =>
    api.call('PUT', '/v1/brand-dossier', { cookie: c, body: { brand_id: brandId, base_version: base, content, ...extra } });
  const voltar = (version: number, base: number, c = cookie) => api.call('POST', '/v1/brand-dossier/restore', { cookie: c, body: { brand_id: brandId, version, base_version: base } });
  const sugestoes = (c = cookie) => api.call('GET', `/v1/brand-dossier/suggestions?brand_id=${brandId}`, { cookie: c });

  const BASE = {
    identity: { summary: 'Hamburgueria de bairro no Centro, com smash e combos para dividir.', audience: 'Famílias e jovens do bairro.', differentiator: '', since: '2019' },
    products: { items: ['Smash duplo', 'Hambúrguer vegano'] },
    forbidden: { items: [{ text: 'gourmet', why: 'não combina com a casa' }] },
  };

  /** 60 pedidos confirmados entre 1,5 e 5 dias atrás, com itens: dá a prova de volume e as sugestões de produto. */
  async function pedidos(contaId: string, unitId: string) {
    const lista: PedidoLido[] = Array.from({ length: 60 }, (_, i) => {
      const quando = new Date(Date.now() - 36 * HORA - i * HORA).toISOString();
      const itens = [['Smash Duplo', true], ['Onion rings', i % 2 === 0], ['Batata rústica G', i % 3 === 0], ['Milk-shake de doce de leite', i % 5 === 0]] as const;
      return {
        externalId: `marca-${i}`,
        channel: 'cardapio',
        channelGroup: 'cardapio',
        status: 'confirmado',
        currency: 'BRL',
        timezone: FUSO,
        revenueMicros: 50_000_000n,
        discountMicros: 0n,
        refundedMicros: 0n,
        couponCode: null,
        customer: null,
        isNewCustomer: null,
        placedAt: null,
        confirmedAt: quando,
        cancelledAt: null,
        version: 1n,
        sourceUpdatedAt: quando,
        items: itens.filter(([, tem]) => tem).map(([nome], j) => ({ externalId: `${i}-${j}`, name: nome, quantity: '1', revenueMicros: 20_000_000n, costMicros: null })),
      };
    });
    await withTenant(database.db, tenantId, (tx) => gravarPedidos(tx, { tenantId, brandId, unitId, connectedAccountId: contaId, provider: 'regem' }, lista));
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Marca');
    await enableMfa(api, s.cookie);
    cookie = s.cookie;
    tenantId = s.me.active_organization_id as string;
    brandId = (await api.call('GET', '/v1/brands', { cookie })).body.items[0].id as string;
    const [unidade, regem, meta, campanha, cupom] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro')`, [unidade, tenantId, brandId]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone)
       values ($1, $2, $3, $4, 'regem', $5, 'Centro (Regem)', 'BRL', $6), ($7, $2, $3, null, 'meta_ads', $8, 'CA - Mister', 'BRL', $6)`,
      [regem, tenantId, brandId, unidade, randomUUID(), FUSO, meta, `act_${Math.floor(Math.random() * 1e12)}`],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, 'Delivery noite', 'ativa')`, [
      campanha,
      tenantId,
      meta,
      String(Math.floor(Math.random() * 1e12)),
    ]);
    await ownerQuery(
      `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, active, uses_count, source_version, source_updated_at, origin, platform)
       values ($1, $2, $3, $4, 'externo:NOITE10', 'NOITE10', 'outro', true, 0, 0, now(), 'externo', 'anotaai')`,
      [cupom, tenantId, brandId, regem],
    );
    await ownerQuery(`insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at) values (gen_random_uuid(), $1, $2, $3, $4, true, now() - interval '1 day')`, [
      tenantId,
      brandId,
      cupom,
      campanha,
    ]);
    await pedidos(regem, unidade);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('o dossiê vazio: sem versão, partes vazias, a prova do sistema e o texto da IA só com o que existe', async () => {
    const r = await ler();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ brand_id: brandId, brand_name: expect.any(String), version: null, can_edit: true });
    expect(r.body.system_proof).toEqual([{ text: 'Mais de 50 pedidos por semana', source: expect.stringMatching(/^Regem · 60 pedidos de \d{2}\/\d{2} a \d{2}\/\d{2} · muda sozinha com o caixa$/) }]);
    expect(r.body.model_text).toBe(`MARCA: ${r.body.brand_name}\nPROVAS (só estas podem ser citadas): Mais de 50 pedidos por semana`);
    expect(r.body.model_text_hash).toMatch(/^[0-9a-f]{64}$/);
    const status = Object.fromEntries((r.body.sections as Array<{ section: string; status: string }>).map((s) => [s.section, s.status]));
    expect(status).toMatchObject({ identidade: 'vazia', proibido: 'confirmada', produtos: 'sugestao', ofertas: 'sugestao' });
  });

  it('salvar cria a versão seguinte com o que mudou; sem mudança, nada nasce', async () => {
    const v1 = await salvar(0, BASE);
    expect(v1.status).toBe(200);
    expect(v1.body.version).toMatchObject({ version: 1, source: 'pessoa', restored_from: null, created_by: { name: 'Pessoa de Teste' } });
    expect(v1.body.version.changes).toContain('Produtos: + Smash duplo');
    const v2 = await salvar(1, { ...BASE, products: { items: ['Smash duplo', 'Combo sexta: smash, batata e refrigerante'] } });
    expect(v2.body.version).toMatchObject({ version: 2, changes: ['Produtos: + Combo sexta: smash, batata e refrigerante', 'Produtos: − Hambúrguer vegano'] });
    const igual = await salvar(2, { ...BASE, products: { items: ['Smash duplo', 'Combo sexta: smash, batata e refrigerante'] } });
    expect(igual.status).toBe(200);
    expect(igual.body.version.version).toBe(2);
    expect((await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.brand_dossier_version where brand_id = $1`, [brandId]))[0]!.n).toBe(2);
    // Cada gravação deixa o evento de auditoria na mesma transação.
    const eventos = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and action = 'marca.dossie_salvar'`, [tenantId]);
    expect(eventos.length).toBe(3);
  });

  it('duas pessoas a partir da mesma versão: a segunda recebe 409 e salva a mescla em cima da nova', async () => {
    const atual = (await ler()).body.version.version as number;
    expect((await salvar(atual, { ...BASE, seasonality: { items: ['Sexta à noite é o dia forte'] } })).status).toBe(200);
    const atrasada = await salvar(atual, { ...BASE, region: { area: 'Centro', pickup: true } });
    expect(atrasada.status).toBe(409);
    expect(atrasada.body.code).toBe('versao-mudou');
    const mescla = await salvar(atual + 1, { ...BASE, seasonality: { items: ['Sexta à noite é o dia forte'] }, region: { area: 'Centro', pickup: true } }, { merged: true });
    expect(mescla.body.version).toMatchObject({ version: atual + 2, source: 'mesclada' });
  });

  it('dado pessoal em qualquer campo é recusado, com o campo', async () => {
    const atual = (await ler()).body.version.version as number;
    const r = await salvar(atual, { ...BASE, competitors: { items: [{ text: 'Brasa Burger', why: 'o dono atende no (21) 99876-5432' }] } });
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: { path: string }) => e.path)).toEqual(['content.competitors.items[0].why']);
  });

  it('as versões, uma versão e voltar a uma anterior (que vira a versão seguinte)', async () => {
    const lista = (await api.call('GET', `/v1/brand-dossier/versions?brand_id=${brandId}`, { cookie })).body.items as Array<{ version: number }>;
    const atual = lista[0]!.version;
    expect(lista.map((v) => v.version)).toEqual(Array.from({ length: atual }, (_, i) => atual - i));
    const v1 = await api.call('GET', `/v1/brand-dossier/versions/1?brand_id=${brandId}`, { cookie });
    expect(v1.body.content.products.items).toEqual(['Smash duplo', 'Hambúrguer vegano']);
    const r = await voltar(1, atual);
    expect(r.body.version).toMatchObject({ version: atual + 1, source: 'restaurada', restored_from: 1 });
    expect(r.body.content.products.items).toEqual(['Smash duplo', 'Hambúrguer vegano']);
    expect((await voltar(atual + 1, atual + 1)).status).toBe(422);
    expect((await voltar(1, atual)).status).toBe(409);
    expect((await api.call('GET', `/v1/brand-dossier/versions/999?brand_id=${brandId}`, { cookie })).status).toBe(404);
  });

  it('o banco não deixa a aplicação alterar nem apagar uma versão', async () => {
    const tentar = (comando: ReturnType<typeof sql>) => withTenant(database.db, tenantId, (tx) => tx.execute(comando));
    // 42501: sem privilégio (a aplicação só tem SELECT e INSERT nesta tabela).
    const negado = { cause: expect.objectContaining({ code: '42501' }) };
    await expect(tentar(sql`update liame.brand_dossier_version set changes = '[]'::jsonb where brand_id = ${brandId}`)).rejects.toMatchObject(negado);
    await expect(tentar(sql`delete from liame.brand_dossier_version where brand_id = ${brandId}`)).rejects.toMatchObject(negado);
  });

  it('testar uma frase: as regras da Liame e as da marca, salvas ou em edição', async () => {
    const testar = (body: Record<string, unknown>, c = cookie) => api.call('POST', '/v1/brand-dossier/check', { cookie: c, body: { brand_id: brandId, ...body } });
    expect((await testar({ text: 'Sexta é dia de combo. Já escolheu o seu?' })).body).toEqual({ ok: true, hits: [] });
    expect((await testar({ text: 'O smash GOURMET da casa, com resultado garantido!' })).body).toEqual({
      ok: false,
      hits: [
        { owner: 'liame', rule: 'promessa_de_resultado', text: 'Promessa de resultado', why: 'ninguém garante venda nem lucro (CDC e CONAR)' },
        { owner: 'marca', rule: 'regra_da_marca', text: 'gourmet', why: 'não combina com a casa' },
      ],
    });
    expect((await testar({ text: 'Entrega em 20 minutos no Centro.', forbidden: ['entrega em 20 minutos'] })).body.hits).toEqual([
      { owner: 'marca', rule: 'regra_da_marca', text: 'entrega em 20 minutos', why: null },
    ]);
  });

  it('as sugestões do sistema: usar os itens marcados cria a versão; o desmarcado e o descartado não voltam', async () => {
    const lista = (await sugestoes()).body.items as Array<{ id: string; section: string; source: string; items: Array<{ op: string; text: string; why: string }> }>;
    const produtos = lista.find((s) => s.section === 'produtos')!;
    const ofertas = lista.find((s) => s.section === 'ofertas')!;
    expect(produtos.source).toBe('sistema');
    expect(produtos.items).toEqual([
      { op: 'incluir', text: 'Onion rings', before: null, why: '30 pedidos em 30 dias, o 2º mais vendido' },
      { op: 'incluir', text: 'Batata rústica G', before: null, why: '20 pedidos em 30 dias, o 3º mais vendido' },
      { op: 'incluir', text: 'Milk-shake de doce de leite', before: null, why: '12 pedidos em 30 dias, o 4º mais vendido' },
      { op: 'tirar', text: 'Hambúrguer vegano', before: null, why: 'nenhum pedido em 30 dias' },
    ]);
    expect(ofertas.items).toEqual([{ op: 'incluir', text: 'Delivery noite, com o cupom NOITE10, exclusivo da campanha', before: null, why: 'cupom exclusivo ligado à campanha no Liame' }]);
    // Ler de novo não cria outra sugestão igual.
    expect(((await sugestoes()).body.items as Array<{ id: string }>).map((s) => s.id).sort()).toEqual(lista.map((s) => s.id).sort());

    const atual = (await ler()).body.version.version as number;
    const usou = await api.call('POST', `/v1/brand-dossier/suggestions/${produtos.id}/use`, { cookie, body: { base_version: atual, items: [0, 3] } });
    expect(usou.status).toBe(200);
    expect(usou.body.version).toMatchObject({ version: atual + 1, source: 'sugestao', changes: ['Produtos: + Onion rings', 'Produtos: − Hambúrguer vegano'] });
    expect(usou.body.content.products.items).toEqual(['Smash duplo', 'Onion rings']);
    expect((await api.call('POST', `/v1/brand-dossier/suggestions/${produtos.id}/use`, { cookie, body: { base_version: atual + 1, items: [0] } })).status).toBe(409);
    expect((await api.call('POST', `/v1/brand-dossier/suggestions/${ofertas.id}/discard`, { cookie })).status).toBe(204);

    // Os itens deixados desmarcados (batata e milk-shake) e a oferta descartada não voltam.
    const depois = (await sugestoes()).body.items as Array<{ section: string }>;
    expect(depois).toEqual([]);
    expect((await ler()).body.sections.find((s: { section: string }) => s.section === 'produtos').status).toBe('confirmada');
  });

  it('usar uma sugestão que passaria do limite da parte é 422, e nada muda', async () => {
    const atual = (await ler()).body.version.version as number;
    const vinte = Array.from({ length: 20 }, (_, i) => `Produto antigo ${i + 1}`);
    expect((await salvar(atual, { ...BASE, products: { items: vinte } })).status).toBe(200);
    const produtos = ((await sugestoes()).body.items as Array<{ id: string; section: string; items: Array<{ op: string }> }>).find((s) => s.section === 'produtos')!;
    const incluir = produtos.items.findIndex((i) => i.op === 'incluir');
    expect(incluir).toBeGreaterThanOrEqual(0);
    const r = await api.call('POST', `/v1/brand-dossier/suggestions/${produtos.id}/use`, { cookie, body: { base_version: atual + 1, items: [incluir] } });
    expect([r.status, r.body.code]).toEqual([422, 'parte-cheia']);
    expect((await ler()).body.version.version).toBe(atual + 1);
  });

  it('permissão: Somente leitura vê o dossiê e testa frase, mas não salva, não volta e não decide sugestão', async () => {
    const email = uniqueEmail('leitura-marca');
    expect((await api.call('POST', '/v1/invitations', { cookie, body: { email, role: 'somente_leitura' } })).status).toBe(201);
    const leitor = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Leitor', password: PASSWORD, terms_version: TERMOS } });
    expect(leitor.status).toBe(200);
    const c = leitor.cookie!;
    const visto = await ler(c);
    expect(visto.status).toBe(200);
    expect(visto.body.can_edit).toBe(false);
    expect((await api.call('POST', '/v1/brand-dossier/check', { cookie: c, body: { brand_id: brandId, text: 'Combo de sexta' } })).status).toBe(200);
    const atual = visto.body.version.version as number;
    const negados = await Promise.all([
      salvar(atual, BASE, {}, c),
      voltar(1, atual, c),
      api.call('POST', `/v1/brand-dossier/suggestions/${randomUUID()}/discard`, { cookie: c }),
    ]);
    expect(negados.map((r) => [r.status, r.body?.code])).toEqual([
      [403, 'sem-permissao'],
      [403, 'sem-permissao'],
      [403, 'sem-permissao'],
    ]);
  });

  it('isolamento: a marca de outra empresa não existe, e as versões dela não aparecem', async () => {
    const outra = await signupAndLogin(api, undefined, 'Outra Hamburgueria');
    await enableMfa(api, outra.cookie);
    expect((await ler(outra.cookie)).status).toBe(404);
    expect((await salvar(0, BASE, {}, outra.cookie)).status).toBe(404);
    expect((await api.call('GET', `/v1/brand-dossier/versions?brand_id=${brandId}`, { cookie: outra.cookie })).status).toBe(404);
    const outraTenant = outra.me.active_organization_id as string;
    const visiveis = await withTenant(database.db, outraTenant, (tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from liame.brand_dossier_version`));
    expect(visiveis.rows[0]!.n).toBe('0');
  });
});
