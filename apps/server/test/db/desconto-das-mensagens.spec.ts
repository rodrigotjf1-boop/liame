import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { MessageDiscountResponse } from '@liame/contracts';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlagService } from '../../src/flags/flag.service.js';
import { FLAG_MENSAGERIA } from '../../src/mensageria/mensageria.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// A5 · Y6, parte 5 pela API: o desconto padrão do cupom das mensagens (decisão do dono em 10/10/2026; protótipo P15,
// parte D; migration 0063). `GET /v1/messaging/discount` (quem vê as campanhas) e `PUT /v1/messaging/discount` (quem
// define os limites da Verba do mês), atrás da flag `mensageria`. A loja do Regem entra direto no banco: a conexão de
// verdade, com a chave "criar cupom de campanha", está provada em `regem-conexao.spec.ts` e `cupons-criar.spec.ts`.

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string; nome: string };

describe.skipIf(!hasDb)('o desconto padrão do cupom das mensagens (A5 · Y6, parte 5)', () => {
  let api: TestApi;
  let flags: FlagService;

  async function empresa(opcoes: { flag?: boolean } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do Desconto');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    if (opcoes.flag !== false) {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [FLAG_MENSAGERIA, tenantId]);
      flags.invalidate();
    }
    return { cookie: s.cookie, tenantId, brandId, userId: s.me.user.id as string, nome: s.me.user.name as string };
  }
  /** Uma loja do Regem conectada à marca; `criaCupom`: a loja liberou "criar cupom de campanha" na autorização. */
  async function loja(e: Empresa, nome: string, criaCupom: boolean, brandId = e.brandId): Promise<string> {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, provider_attributes)
       values ($1, $2, $3, 'regem', $4, $5, 'BRL', 'America/Sao_Paulo', $6::jsonb)`,
      [id, e.tenantId, brandId, randomUUID(), nome, JSON.stringify({ escopos: criaCupom ? ['pedidos.ler', 'cupons.ler', 'cupons.criar'] : ['pedidos.ler', 'cupons.ler'] })],
    );
    return id;
  }
  async function membro(e: Empresa, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role } })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    return { cookie: s.cookie };
  }
  const ver = (e: Empresa, cookie = e.cookie, brandId = e.brandId) => api.call('GET', `/v1/messaging/discount?brand_id=${brandId}`, { cookie });
  const definir = (e: Empresa, corpo: Record<string, unknown>, cookie = e.cookie) => api.call('PUT', '/v1/messaging/discount', { cookie, body: { brand_id: e.brandId, ...corpo } });
  const lido = async (e: Empresa): Promise<MessageDiscountResponse> => {
    const r = await ver(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return MessageDiscountResponse.parse(r.body);
  };
  const guardados = async (e: Empresa) => (await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.message_discount where tenant_id = $1`, [e.tenantId]))[0]!.n;
  const campoDoErro = (r: { body: { errors?: { path: string; message: string }[] } }) => r.body.errors?.map((x) => x.path) ?? [];
  const DEZ_POR_CENTO = { kind: 'percentual', percent: 10, valid_days: 2 };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    flags = api.app.get(FlagService);
  }, 120_000);
  afterAll(async () => {
    await api?.close();
  });

  it('com a função das mensagens desligada, nada é lido e nada é gravado', async () => {
    const e = await empresa({ flag: false });
    await loja(e, 'Loja Centro', true);
    const corpo = await lido(e);
    expect(corpo).toMatchObject({ brand_id: e.brandId, enabled: false, discount: null, stores: [], can_edit: false });
    const r = await definir(e, DEZ_POR_CENTO);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('mensageria-desligada');
    expect(await guardados(e)).toBe(0);
  });

  it('sem loja do Regem que crie cupom, o desconto não é gravado, e a resposta diz o que falta', async () => {
    const e = await empresa();
    expect(await lido(e)).toMatchObject({ enabled: true, discount: null, stores: [], can_edit: true, limits: { percent_max: 50, value_cents_max: 10_000, min_order_cents_max: 100_000, valid_days_max: 14 } });
    const semLoja = await definir(e, DEZ_POR_CENTO);
    expect(semLoja.status, JSON.stringify(semLoja.body)).toBe(409);
    expect(semLoja.body).toMatchObject({ code: 'loja-sem-cupom' });
    expect(semLoja.body.detail).toContain('não tem loja do Regem conectada');

    // A loja está conectada, mas não liberou "criar cupom de campanha".
    const semChave = await loja(e, 'Loja Centro', false);
    expect((await lido(e)).stores).toEqual([{ connected_account_id: semChave, name: 'Loja Centro', can_create: false }]);
    const recusa = await definir(e, DEZ_POR_CENTO);
    expect(recusa.status).toBe(409);
    expect(recusa.body.detail).toContain('Nenhuma loja do Regem desta marca liberou "criar cupom de campanha"');
    // Pedir essa loja pelo id dá a mesma recusa.
    const pedida = await definir(e, { ...DEZ_POR_CENTO, connected_account_id: semChave });
    expect(pedida.status).toBe(409);
    expect(pedida.body.code).toBe('loja-sem-cupom');
    expect(await guardados(e)).toBe(0);
  });

  it('com uma loja só, o dono define e muda o desconto; fica uma linha por marca, com quem definiu, e a auditoria leva o antes e o depois', async () => {
    const e = await empresa();
    const centro = await loja(e, 'Loja Centro', true);
    const r = await definir(e, DEZ_POR_CENTO);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const corpo = MessageDiscountResponse.parse(r.body);
    expect(corpo.discount).toMatchObject({
      kind: 'percentual',
      percent: 10,
      value_cents: null,
      min_order_cents: null,
      valid_days: 2,
      store: { connected_account_id: centro, name: 'Loja Centro', can_create: true, connected: true },
      set_by: { id: e.userId, name: e.nome },
    });
    expect(Date.now() - Date.parse(corpo.discount!.set_at)).toBeLessThan(60_000);
    // Ler devolve o mesmo que a gravação devolveu.
    expect((await lido(e)).discount).toEqual(corpo.discount);

    // Mudar: valor fixo com pedido mínimo, por 7 dias. O percentual de antes sai.
    const mudou = await definir(e, { kind: 'valor', value_cents: 1000, min_order_cents: 5000, valid_days: 7 });
    expect(mudou.status, JSON.stringify(mudou.body)).toBe(200);
    expect(mudou.body.discount).toMatchObject({ kind: 'valor', percent: null, value_cents: 1000, min_order_cents: 5000, valid_days: 7 });
    // E entrega grátis, sem valor nenhum.
    const entrega = await definir(e, { kind: 'frete_gratis', valid_days: 3 });
    expect(entrega.body.discount).toMatchObject({ kind: 'frete_gratis', percent: null, value_cents: null, min_order_cents: null, valid_days: 3 });
    expect(await guardados(e)).toBe(1);

    const auditoria = await ownerQuery<{ action: string; resource_type: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      `select action, resource_type, "before", "after" from liame.audit_event where tenant_id = $1 and action = 'mensageria.desconto' order by chain_seq`,
      [e.tenantId],
    );
    expect(auditoria).toHaveLength(3);
    expect(auditoria[0]).toMatchObject({ resource_type: 'message_discount', before: null, after: { kind: 'percentual', percent: 10, valid_days: 2, coupon_account_id: centro } });
    expect(auditoria[1]).toMatchObject({ before: { kind: 'percentual', percent: 10, valid_days: 2 }, after: { kind: 'valor', value_cents: 1000, min_order_cents: 5000, valid_days: 7 } });
    expect(auditoria[2]).toMatchObject({ before: { kind: 'valor', value_cents: 1000 }, after: { kind: 'frete_gratis', percent: null, value_cents: null } });
  });

  it('o que passa do que o Liame aceita volta com o campo; e nada é gravado', async () => {
    const e = await empresa();
    await loja(e, 'Loja Centro', true);
    const casos: [Record<string, unknown>, string[]][] = [
      [{ kind: 'percentual', percent: 51, valid_days: 2 }, ['percent']],
      [{ kind: 'percentual', valid_days: 2 }, ['percent']],
      [{ kind: 'valor', value_cents: 1000, valid_days: 2 }, ['min_order_cents']],
      [{ kind: 'valor', value_cents: 1000, min_order_cents: 1000, valid_days: 2 }, ['min_order_cents']],
      [{ kind: 'valor', value_cents: 10_001, min_order_cents: 20_000, valid_days: 2 }, ['value_cents']],
      [{ kind: 'percentual', percent: 10, valid_days: 15 }, ['valid_days']],
      [{ kind: 'frete_gratis', percent: 10, valid_days: 2 }, ['percent']],
    ];
    for (const [corpo, campos] of casos) {
      const r = await definir(e, corpo);
      expect(r.status, JSON.stringify([corpo, r.body])).toBe(400);
      expect(campoDoErro(r), JSON.stringify(corpo)).toEqual(campos);
    }
    // O formato é do contrato: tipo que não existe, zero dias e campo a mais não passam.
    for (const corpo of [{ kind: 'brinde', valid_days: 2 }, { kind: 'percentual', percent: 10, valid_days: 0 }, { kind: 'percentual', percent: 10, valid_days: 2, codigo: 'X' }]) {
      expect((await definir(e, corpo)).status, JSON.stringify(corpo)).toBe(400);
    }
    expect(await guardados(e)).toBe(0);
  });

  it('com mais de uma loja que cria cupom, a pessoa escolhe; loja de fora da marca não serve', async () => {
    const e = await empresa();
    const centro = await loja(e, 'Loja Centro', true);
    const lapa = await loja(e, 'Loja Lapa', true);
    expect((await lido(e)).stores.map((s) => s.name)).toEqual(['Loja Centro', 'Loja Lapa']);
    const semEscolher = await definir(e, DEZ_POR_CENTO);
    expect(semEscolher.status, JSON.stringify(semEscolher.body)).toBe(400);
    expect(semEscolher.body.errors).toEqual([{ path: 'connected_account_id', message: 'Escolha em qual loja o cupom vale.' }]);

    const naLapa = await definir(e, { ...DEZ_POR_CENTO, connected_account_id: lapa });
    expect(naLapa.status, JSON.stringify(naLapa.body)).toBe(200);
    expect(naLapa.body.discount.store).toEqual({ connected_account_id: lapa, name: 'Loja Lapa', can_create: true, connected: true });
    // Trocar de loja é mudar o desconto.
    expect((await definir(e, { ...DEZ_POR_CENTO, connected_account_id: centro })).body.discount.store.name).toBe('Loja Centro');

    // A loja de outra empresa, e um id que não existe: não são desta marca.
    const vizinha = await empresa();
    const deFora = await loja(vizinha, 'Loja da Vizinha', true);
    for (const id of [deFora, randomUUID()]) {
      const r = await definir(e, { ...DEZ_POR_CENTO, connected_account_id: id });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.errors).toEqual([{ path: 'connected_account_id', message: 'Loja do Regem não encontrada nesta marca.' }]);
    }
    expect((await lido(e)).discount!.store.name).toBe('Loja Centro');
  });

  it('a loja do desconto desconectada aparece como desconectada, e some da lista das lojas', async () => {
    const e = await empresa();
    const centro = await loja(e, 'Loja Centro', true);
    expect((await definir(e, DEZ_POR_CENTO)).status).toBe(200);
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [centro]);
    const corpo = await lido(e);
    expect(corpo.discount!.store).toEqual({ connected_account_id: centro, name: 'Loja Centro', can_create: false, connected: false });
    expect(corpo.stores).toEqual([]);
  });

  it('quem só lê vê o desconto e não muda; quem não vê as campanhas não lê; outra empresa não lê nem grava', async () => {
    const e = await empresa();
    await loja(e, 'Loja Centro', true);
    expect((await definir(e, DEZ_POR_CENTO)).status).toBe(200);

    const leitor = await membro(e, 'somente_leitura');
    const visto = await ver(e, leitor.cookie);
    expect(visto.status, JSON.stringify(visto.body)).toBe(200);
    expect(visto.body).toMatchObject({ enabled: true, can_edit: false, discount: { kind: 'percentual', percent: 10 } });
    expect((await definir(e, { kind: 'percentual', percent: 40, valid_days: 2 }, leitor.cookie)).status).toBe(403);
    const relatorios = await membro(e, 'so_relatorios');
    expect((await ver(e, relatorios.cookie)).status).toBe(403);
    expect((await definir(e, DEZ_POR_CENTO, relatorios.cookie)).status).toBe(403);

    const vizinha = await empresa();
    await loja(vizinha, 'Loja da Vizinha', true);
    expect((await ver(vizinha, vizinha.cookie, e.brandId)).status).toBe(404);
    expect((await api.call('PUT', '/v1/messaging/discount', { cookie: vizinha.cookie, body: { brand_id: e.brandId, ...DEZ_POR_CENTO } })).status).toBe(404);
    // O desconto de antes segue como estava.
    expect((await lido(e)).discount).toMatchObject({ kind: 'percentual', percent: 10, valid_days: 2 });
    expect((await lido(vizinha)).discount).toBeNull();
  });

  it('o banco recusa o que a tabela não aceita, cada regra pelo nome dela', async () => {
    const e = await empresa();
    const centro = await loja(e, 'Loja Centro', true);
    const inserir = (colunas: string, valores: string, marca = e.brandId) =>
      ownerQuery(`insert into liame.message_discount (id, tenant_id, brand_id, coupon_account_id, ${colunas}) values (gen_random_uuid(), $1, $2, $3, ${valores})`, [e.tenantId, marca, centro]);
    // O tipo e o campo dele andam juntos.
    await expect(inserir('kind, valid_days', `'percentual', 2`)).rejects.toThrow(/message_discount_tipo/);
    await expect(inserir('kind, percent, value_cents, min_order_cents, valid_days', `'valor', 10, 1000, 5000, 2`)).rejects.toThrow(/message_discount_tipo/);
    await expect(inserir('kind, percent, valid_days', `'frete_gratis', 10, 2`)).rejects.toThrow(/message_discount_tipo/);
    // Valor fixo pede o pedido mínimo, maior que o desconto.
    await expect(inserir('kind, value_cents, valid_days', `'valor', 1000, 2`)).rejects.toThrow(/message_discount_valor_com_minimo/);
    await expect(inserir('kind, value_cents, min_order_cents, valid_days', `'valor', 1000, 1000, 2`)).rejects.toThrow(/message_discount_valor_com_minimo/);
    // Os limites de cada coluna.
    await expect(inserir('kind, percent, valid_days', `'percentual', 101, 2`)).rejects.toThrow(/message_discount_percent_check/);
    await expect(inserir('kind, percent, valid_days', `'percentual', 0, 2`)).rejects.toThrow(/message_discount_percent_check/);
    await expect(inserir('kind, percent, valid_days', `'percentual', 10, 0`)).rejects.toThrow(/message_discount_valid_days_check/);
    await expect(inserir('kind, percent, valid_days', `'percentual', 10, 91`)).rejects.toThrow(/message_discount_valid_days_check/);
    await expect(inserir('kind, percent, min_order_cents, valid_days', `'percentual', 10, 0, 2`)).rejects.toThrow(/message_discount_min_order_cents_check/);
    await expect(inserir('kind, valid_days', `'brinde', 2`)).rejects.toThrow(/message_discount_kind_check/);
    // O que a tabela aceita: cada tipo com o que é dele. E uma linha só por marca.
    await inserir('kind, percent, valid_days', `'percentual', 100, 90`);
    await expect(inserir('kind, valid_days', `'frete_gratis', 2`)).rejects.toThrow(/message_discount_uma_por_marca/);
    await ownerQuery(`delete from liame.message_discount where brand_id = $1`, [e.brandId]);
    await inserir('kind, value_cents, min_order_cents, valid_days', `'valor', 1000, 1001, 1`);
    await ownerQuery(`delete from liame.message_discount where brand_id = $1`, [e.brandId]);
    await inserir('kind, min_order_cents, valid_days', `'frete_gratis', 4000, 14`);
    expect(await guardados(e)).toBe(1);
  });
});
