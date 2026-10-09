import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ActionOptionsResponse, ActionTargetsResponse } from '@liame/contracts';
import { runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { type EmpresaComMeta, empresaComMeta, ligarConectorNaMetaDeMentira, ligarEscritaNaMeta, MetaDeMentira } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A4 · X8 (parte 1): o que a tela do pedido de mudança lê antes de a pessoa pedir, pela API e contra uma Graph API
// local (`helpers/meta-de-mentira.ts`). `GET /v1/actions/targets` diz em quais campanhas da marca dá para pedir;
// `GET /v1/actions/options` lê o objeto na Meta na hora e devolve o que cabe pedir nele, os conjuntos e os anúncios
// da campanha e os pedidos em aberto. Nenhuma das duas cria pedido nem muda nada na Meta.

const REAL = 1_000_000;

describe.skipIf(!hasDb)('as opções do pedido de mudança (A4 · X8)', () => {
  let api: TestApi;
  const meta = new MetaDeMentira();
  let e: EmpresaComMeta;

  type Arvore = {
    campanha: { id: string; recurso: string; linha: string };
    ativo: { id: string; recurso: string; linha: string };
    pausado: { id: string; recurso: string; linha: string };
    anuncio: { id: string; recurso: string; linha: string };
    outroAnuncio: { id: string; recurso: string; linha: string };
  };
  /**
   * Uma campanha com a verba nela (R$ 30,00 por dia na leitura da manhã), dois conjuntos (um ativo, um em pausa) e
   * dois anúncios, na Meta de mentira e na lista que o Liame leu da conta.
   */
  async function arvore(emp: EmpresaComMeta, nome: string, opcoes: { conta?: string; situacao?: string } = {}): Promise<Arvore> {
    const conta = opcoes.conta ?? emp.conta;
    const c = meta.novo('campanha', { name: nome });
    const s1 = meta.novo('conjunto', { name: `${nome} · almoço`, daily_budget: '0' });
    const s2 = meta.novo('conjunto', { name: `${nome} · noite`, daily_budget: '0', status: 'PAUSED', effective_status: 'PAUSED' });
    const a1 = meta.novo('anuncio', { name: `${nome} · vídeo` });
    const a2 = meta.novo('anuncio', { name: `${nome} · foto`, effective_status: 'ADSET_PAUSED' });
    const [lc, ls1, ls2, la1, la2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros, last_seen_at)
       values ($1, $2, $3, 'meta_ads', $4, $5, $6, $7, now() - interval '6 hours')`,
      [lc, emp.tenantId, conta, c.id, c.name, opcoes.situacao ?? 'ativa', 30 * REAL],
    );
    await ownerQuery(
      `insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status, daily_budget_micros, last_seen_at)
       values ($1, $3, $4, $5, 'meta_ads', $6, $7, 'ativa', 0, now() - interval '6 hours'), ($2, $3, $4, $5, 'meta_ads', $8, $9, 'pausada', 0, now() - interval '7 hours')`,
      [ls1, ls2, emp.tenantId, conta, lc, s1.id, s1.name, s2.id, s2.name],
    );
    await ownerQuery(
      `insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status, last_seen_at)
       values ($1, $3, $4, $5, 'meta_ads', $7, $8, 'ativa', now() - interval '6 hours'), ($2, $3, $4, $6, 'meta_ads', $9, $10, 'ativa', now() - interval '6 hours')`,
      [la1, la2, emp.tenantId, conta, ls1, ls2, a1.id, a1.name, a2.id, a2.name],
    );
    const no = (tipo: string, o: { id: string }, linha: string) => ({ id: o.id, recurso: `${tipo}:${o.id}`, linha });
    return { campanha: no('campanha', c, lc), ativo: no('conjunto', s1, ls1), pausado: no('conjunto', s2, ls2), anuncio: no('anuncio', a1, la1), outroAnuncio: no('anuncio', a2, la2) };
  }

  /** A autorização da conta: por qual acesso ela foi feita (`escrita`, `leitura`, ou de antes da coluna). */
  async function autorizacao(emp: EmpresaComMeta, acesso: 'escrita' | 'leitura' | null, conta = emp.conta): Promise<void> {
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.oauth_connection (id, tenant_id, brand_id, provider, status, state_hash, redirect_uri, expires_at, completed_at, requested_access)
       values ($1, $2, $3, 'meta', 'ativa', $5, 'https://api.example/v1/oauth/callback', now() + interval '10 minutes', now(), $4)`,
      [id, emp.tenantId, emp.brandId, acesso, createHash('sha256').update(id).digest('hex')],
    );
    await ownerQuery(`update liame.connected_account set connection_id = $1 where id = $2`, [id, conta]);
  }

  const opcoes = (emp: EmpresaComMeta, campanha: string, alvo?: string) =>
    api.call('GET', `/v1/actions/options?campaign_id=${campanha}${alvo ? `&target=${encodeURIComponent(alvo)}` : ''}`, { cookie: emp.cookie });
  const alvos = async (emp: EmpresaComMeta) => {
    const r = await api.call('GET', `/v1/actions/targets?brand_id=${emp.brandId}`, { cookie: emp.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ActionTargetsResponse.parse(r.body).campaigns;
  };
  const pedir = (emp: EmpresaComMeta, tool: string, recurso: string, params: Record<string, unknown> = {}) =>
    api.call('POST', '/v1/actions', { cookie: emp.cookie, body: { tool, provider: 'meta_ads', account_id: emp.conta, resource_id: recurso, params } });
  const leituras = () => meta.chamadas.filter((c) => c.metodo === 'GET').length;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await meta.ligar();
    api = await startApi();
    await resetIpRateLimits();
    ligarConectorNaMetaDeMentira(api, meta);
    e = await empresaComMeta(api, meta, 'Mister Burgers Pedido de Mudança');
    await ligarEscritaNaMeta(api, e.tenantId, true);
    await autorizacao(e, 'escrita');
  }, 120_000);
  beforeEach(async () => {
    meta.normalizar();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    if (e) await ligarEscritaNaMeta(api, e.tenantId, false);
    await api?.close();
    await meta.desligar();
  });

  it('a campanha é lida na Meta na hora: vale o que está lá agora, e não a leitura da manhã; vêm o que cabe pedir e os conjuntos e anúncios dela', async () => {
    const t = await arvore(e, 'Combo sexta');
    // Alguém subiu a verba na Meta depois da leitura da manhã (a lista do Liame ainda diz R$ 30,00).
    meta.objetos.get(t.campanha.id)!.daily_budget = '4500';
    const antes = Date.now();
    const r = await opcoes(e, t.campanha.linha);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const o = ActionOptionsResponse.parse(r.body);
    expect(o.campaign).toEqual({ id: t.campanha.linha, name: 'Combo sexta', provider: 'meta_ads', brand_id: e.brandId, account_id: e.conta, account_name: 'CA - Mister Burgers' });
    // Na Meta a verba mora no objeto: não há verba dividida entre campanhas (`shared_budget` é do Google).
    expect(o.target).toEqual({ resource_id: t.campanha.recurso, kind: 'campanha', name: 'Combo sexta', status: 'ativo', effective_status: 'ACTIVE', daily_micros: 45 * REAL, shared_budget: null });
    expect(o.tools).toEqual(['orcamento_ajustar', 'campanha_pausar']);
    expect(new Date(o.read_at).getTime()).toBeGreaterThanOrEqual(antes);
    // A lista é a da leitura diária, em ordem de nome: a situação e a verba são as de quando o Liame leu.
    expect(o.ad_sets).toEqual([
      { resource_id: t.ativo.recurso, kind: 'conjunto', name: 'Combo sexta · almoço', status: 'ativo', daily_micros: null },
      { resource_id: t.pausado.recurso, kind: 'conjunto', name: 'Combo sexta · noite', status: 'pausado', daily_micros: null },
    ]);
    expect(o.ads).toEqual([
      { resource_id: t.outroAnuncio.recurso, kind: 'anuncio', name: 'Combo sexta · foto', status: 'ativo', daily_micros: null, ad_set: t.pausado.recurso },
      { resource_id: t.anuncio.recurso, kind: 'anuncio', name: 'Combo sexta · vídeo', status: 'ativo', daily_micros: null, ad_set: t.ativo.recurso },
    ]);
    // Até onde a lista vale: a leitura mais antiga entre os objetos dela (o conjunto lido há 7 horas).
    const horas = (Date.now() - new Date(o.listed_at!).getTime()) / 3_600_000;
    expect(horas).toBeGreaterThan(6.9);
    expect(horas).toBeLessThan(7.1);
    expect(o.open).toEqual([]);
    // Uma leitura na Meta, nenhuma escrita, e nenhum pedido criado.
    expect(meta.resumo(t.campanha.id)).toEqual(['ler']);
    expect(await ownerQuery(`select 1 from liame.action_request where tenant_id = $1 and resource_id = $2`, [e.tenantId, t.campanha.recurso])).toEqual([]);
    expect(meta.defeitos).toEqual([]);
  });

  it('o conjunto em pausa só dá para retomar; o anúncio não tem verba própria; cada escolha é lida na Meta', async () => {
    const t = await arvore(e, 'Delivery noite');
    const pausado = ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha, t.pausado.recurso)).body);
    expect(pausado.target).toMatchObject({ resource_id: t.pausado.recurso, kind: 'conjunto', status: 'pausado', daily_micros: null });
    expect(pausado.tools).toEqual(['conjunto_retomar']);
    const ativo = ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha, t.ativo.recurso)).body);
    // A verba mora na campanha: no conjunto ativo só cabe pausar.
    expect(ativo.tools).toEqual(['conjunto_pausar']);
    const anuncio = ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha, t.outroAnuncio.recurso)).body);
    expect(anuncio.target).toMatchObject({ kind: 'anuncio', status: 'ativo', effective_status: 'ADSET_PAUSED', daily_micros: null });
    expect(anuncio.tools).toEqual(['anuncio_pausar']);
    expect([meta.resumo(t.pausado.id), meta.resumo(t.ativo.id), meta.resumo(t.outroAnuncio.id), meta.resumo(t.campanha.id)]).toEqual([['ler'], ['ler'], ['ler'], []]);
  });

  it('o conjunto com a verba nele aceita mudar a verba; o objeto arquivado na Meta não aceita nada', async () => {
    const t = await arvore(e, 'Almoço executivo');
    meta.objetos.get(t.campanha.id)!.daily_budget = '0';
    meta.objetos.get(t.ativo.id)!.daily_budget = '2500';
    const conjunto = ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha, t.ativo.recurso)).body);
    expect(conjunto.target.daily_micros).toBe(25 * REAL);
    expect(conjunto.tools).toEqual(['orcamento_ajustar', 'conjunto_pausar']);
    // A campanha sem verba própria (ela fica nos conjuntos): só pausar.
    expect(ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha)).body).tools).toEqual(['campanha_pausar']);
    Object.assign(meta.objetos.get(t.campanha.id)!, { status: 'ARCHIVED', effective_status: 'ARCHIVED' });
    const arquivada = ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha)).body);
    expect([arquivada.target.status, arquivada.tools]).toEqual(['arquivado', []]);
  });

  it('o pedido em aberto aparece nas opções e em "onde dá para pedir", na campanha do objeto dele', async () => {
    const t = await arvore(e, 'Smash em dobro');
    const naCampanha = await pedir(e, 'orcamento_ajustar', t.campanha.recurso, { daily_budget_micros: 27 * REAL });
    expect([naCampanha.status, naCampanha.body.status], JSON.stringify(naCampanha.body)).toEqual([201, 'aguardando_aprovacao']);
    const noConjunto = await pedir(e, 'conjunto_pausar', t.ativo.recurso);
    const noAnuncio = await pedir(e, 'anuncio_pausar', t.anuncio.recurso);
    expect([noConjunto.status, noAnuncio.status]).toEqual([201, 201]);

    const o = ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha)).body);
    // Do mais novo para o mais antigo, com o valor pedido nos de verba.
    expect(o.open.map((p) => [p.id, p.tool, p.action, p.resource_id, p.status, p.value_micros])).toEqual([
      [noAnuncio.body.id, 'anuncio_pausar', 'anuncio.pausar', t.anuncio.recurso, 'aguardando_aprovacao', null],
      [noConjunto.body.id, 'conjunto_pausar', 'conjunto.pausar', t.ativo.recurso, 'aguardando_aprovacao', null],
      [naCampanha.body.id, 'orcamento_ajustar', 'orcamento.reduzir', t.campanha.recurso, 'aguardando_aprovacao', 27 * REAL],
    ]);
    const daCampanha = (await alvos(e)).find((c) => c.campaign_id === t.campanha.linha)!;
    expect(daCampanha.write).toBe('ligada');
    expect(daCampanha.open.map((p) => p.id)).toEqual([noAnuncio.body.id, noConjunto.body.id, naCampanha.body.id]);

    // O pedido cancelado sai das duas listas.
    expect((await api.call('POST', `/v1/actions/${noConjunto.body.id}/cancel`, { cookie: e.cookie })).body.status).toBe('cancelada');
    expect(ActionOptionsResponse.parse((await opcoes(e, t.campanha.linha)).body).open.map((p) => p.id)).toEqual([noAnuncio.body.id, naCampanha.body.id]);
    expect((await alvos(e)).find((c) => c.campaign_id === t.campanha.linha)!.open.map((p) => p.id)).toEqual([noAnuncio.body.id, naCampanha.body.id]);
  });

  it('onde dá para pedir: as campanhas ativas e em pausa das contas com a escrita ligada; a arquivada, a do Google e a de outra empresa ficam de fora', async () => {
    const t = await arvore(e, 'Rodízio de quinta');
    const pausada = await arvore(e, 'Festival de inverno', { situacao: 'pausada' });
    const arquivada = await arvore(e, 'Natal passado', { situacao: 'arquivada' });
    const google = randomUUID();
    const doGoogle = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'google_ads', $4, 'Google da loja', 'BRL', 'America/Sao_Paulo')`, [
      google,
      e.tenantId,
      e.brandId,
      `customers/${Date.now()}`,
    ]);
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'google_ads', $4, 'Busca hambúrguer perto', 'ativa')`, [doGoogle, e.tenantId, google, `g${Date.now()}`]);
    const outra = await empresaComMeta(api, meta, 'Outra Empresa Com Meta');
    const daOutra = await arvore(outra, 'Campanha da outra');

    const lista = await alvos(e);
    const ids = lista.map((c) => c.campaign_id);
    expect(ids).toEqual(expect.arrayContaining([t.campanha.linha, pausada.campanha.linha]));
    for (const fora of [arquivada.campanha.linha, doGoogle, daOutra.campanha.linha]) expect(ids).not.toContain(fora);
    expect(lista.every((c) => c.write === 'ligada')).toBe(true);
    // A outra empresa não ligou a escrita: para ela, nenhuma campanha aceita pedido.
    expect(await alvos(outra)).toEqual([]);

    // E as opções: no Google a escrita existe desde a Y3 da A5 e está desligada para esta conta (a flag é `google_write`,
    // e a da Meta não vale para ele); a campanha de outra empresa não existe para esta.
    const g = await opcoes(e, doGoogle);
    expect([g.status, g.body.code]).toEqual([403, 'escrita-desligada']);
    const o = await opcoes(e, daOutra.campanha.linha);
    expect([o.status, o.body.code]).toEqual([404, 'nao-encontrado']);
    // O conjunto de outra campanha não entra como alvo desta.
    const cruzado = await opcoes(e, t.campanha.linha, pausada.ativo.recurso);
    expect([cruzado.status, cruzado.body.code]).toEqual([422, 'alvo-nao-e-da-campanha']);
  });

  it('a conexão que só pediu leitura: a campanha aparece como "só leitura", e as opções dizem para conectar de novo, sem gastar a leitura na Meta', async () => {
    const leitura = await empresaComMeta(api, meta, 'Empresa Com a Conexão de Leitura');
    await ligarEscritaNaMeta(api, leitura.tenantId, true);
    try {
      const t = await arvore(leitura, 'Campanha de leitura');
      const ver = async () => {
        const antes = leituras();
        const r = await opcoes(leitura, t.campanha.linha);
        expect([r.status, r.body.code], JSON.stringify(r.body)).toEqual([409, 'conexao-so-leitura']);
        expect(r.body.detail).toBe(
          'A conexão com a Meta ainda não deixa o Liame mudar anúncios: hoje ela só deixa ler. Conecte de novo em Contas conectadas: a plataforma vai pedir a permissão de gerenciar anúncios, e as contas que já estão ligadas continuam as mesmas.',
        );
        expect(leituras()).toBe(antes);
        expect((await alvos(leitura)).map((c) => [c.campaign_id, c.write])).toEqual([[t.campanha.linha, 'so_leitura']]);
      };
      // A conta sem autorização registrada, a de antes da coluna e a que autorizou pela configuração de leitura.
      await ver();
      await autorizacao(leitura, null);
      await ver();
      await autorizacao(leitura, 'leitura');
      await ver();
      // Conectou de novo pela configuração de escrita: passa a ler e a oferecer o pedido.
      await autorizacao(leitura, 'escrita');
      expect((await opcoes(leitura, t.campanha.linha)).status).toBe(200);
      expect((await alvos(leitura))[0]!.write).toBe('ligada');
    } finally {
      await ligarEscritaNaMeta(api, leitura.tenantId, false);
    }
  });

  it('com a escrita desligada ou com a trava acionada, as opções recusam como o pedido recusaria, sem ler a Meta', async () => {
    const t = await arvore(e, 'Promoção relâmpago');
    const antes = leituras();
    await ligarEscritaNaMeta(api, e.tenantId, false);
    try {
      const r = await opcoes(e, t.campanha.linha);
      expect([r.status, r.body.code]).toEqual([403, 'escrita-desligada']);
      expect(await alvos(e)).toEqual([]);
    } finally {
      await ligarEscritaNaMeta(api, e.tenantId, true);
    }
    const trava = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'pausa de segurança' } });
    expect(trava.status, JSON.stringify(trava.body)).toBe(201);
    try {
      const r = await opcoes(e, t.campanha.linha);
      expect([r.status, r.body.code]).toEqual([423, 'parada-acionada']);
    } finally {
      await api.call('DELETE', `/v1/kill-switches/${trava.body.id}`, { cookie: e.cookie });
    }
    expect(leituras()).toBe(antes);
    expect((await opcoes(e, t.campanha.linha)).status).toBe(200);
  });

  it('a Meta fora do ar, a autorização revogada e o objeto apagado na Meta: cada um com o problema que a pessoa entende', async () => {
    const t = await arvore(e, 'Happy hour');
    meta.falhasDaLeitura = [{ status: 500, corpo: meta.erro(2, 'An unexpected error has occurred. Please retry your request later.') }];
    const fora = await opcoes(e, t.campanha.linha);
    expect([fora.status, fora.body.code, fora.body.detail], JSON.stringify(fora.body)).toEqual([502, 'plataforma-indisponivel', 'A Meta não respondeu agora, ou pediu para esperar. Nada foi pedido: tente de novo em alguns minutos.']);

    // A conta sem a autorização guardada (revogada): nem chega a chamar a Meta.
    await autorizacao(e, 'escrita', e.contaSemToken);
    const semToken = await arvore(e, 'Campanha da conta revogada', { conta: e.contaSemToken });
    const antes = leituras();
    const revogada = await opcoes(e, semToken.campanha.linha);
    expect([revogada.status, revogada.body.code]).toEqual([409, 'conta-desconectada']);
    expect(leituras()).toBe(antes);

    // O objeto que a Meta não tem mais.
    meta.objetos.delete(t.pausado.id);
    const sumiu = await opcoes(e, t.campanha.linha, t.pausado.recurso);
    expect([sumiu.status, sumiu.body.code]).toEqual([404, 'recurso-nao-encontrado']);
    // E a campanha segue abrindo.
    expect((await opcoes(e, t.campanha.linha)).status).toBe(200);
  });

  it('quem só acompanha as campanhas vê onde há pedido em aberto, mas não abre as opções do pedido', async () => {
    const t = await arvore(e, 'Só para olhar');
    // O acesso à cobrança é só do Dono e do Administrador (regra do banco): sai junto com o papel, e volta com ele.
    await ownerQuery(`update liame.membership set role_key = 'somente_leitura', billing_access = false where tenant_id = $1 and user_id = $2`, [e.tenantId, e.userId]);
    try {
      const lista = await api.call('GET', `/v1/actions/targets?brand_id=${e.brandId}`, { cookie: e.cookie });
      expect(lista.status, JSON.stringify(lista.body)).toBe(200);
      const r = await opcoes(e, t.campanha.linha);
      expect(r.status).toBe(403);
    } finally {
      await ownerQuery(`update liame.membership set role_key = 'dono', billing_access = true where tenant_id = $1 and user_id = $2`, [e.tenantId, e.userId]);
    }
  });

  it('pedido malformado: sem a campanha, com id que não é id e com alvo fora do formato', async () => {
    expect((await api.call('GET', '/v1/actions/options', { cookie: e.cookie })).status).toBe(400);
    expect((await api.call('GET', '/v1/actions/options?campaign_id=abc', { cookie: e.cookie })).status).toBe(400);
    expect((await api.call('GET', '/v1/actions/targets', { cookie: e.cookie })).status).toBe(400);
    const t = await arvore(e, 'Alvo torto');
    const torto = await opcoes(e, t.campanha.linha, 'campanha:1 or 1=1');
    expect([torto.status, torto.body.code]).toEqual([422, 'alvo-nao-e-da-campanha']);
    // "targets" e "options" não são lidos como o id de uma ação.
    expect((await api.call('GET', `/v1/actions/${randomUUID()}`, { cookie: e.cookie })).status).toBe(404);
  });
});
