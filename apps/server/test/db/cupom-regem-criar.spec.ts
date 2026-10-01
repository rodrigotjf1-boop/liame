import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { CupomRegem } from '../../src/connectors/regem/contrato-regem.js';
import { diaNoFuso } from '../../src/coupons/plataforma.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { gravarCupons } from '../../src/orders/regem-leitura.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// A2.5 · F6 parte 2: criar cupom de campanha no Regem pelo Action Service (ADR-019 item 6), contra um "Regem"
// local que segue o contrato de cupons §3.3 (`POST {base}/cupons`, com Idempotency-Key, 409 codigo-em-uso e
// 422 regra-invalida). O caminho inteiro: flag `regem_write` (nasce desligada) → pedido na aba Cupons →
// política (aprovação) → aprovação com o código do app → worker cria no Regem → cupom na lista, ligado à campanha.

const FUSO = 'America/Sao_Paulo';
const TOKEN_CENTRO = `rgm_it_${'c'.repeat(32)}`;
const TOKEN_PRAIA = `rgm_it_${'p'.repeat(32)}`;
const LEITURA = ['pedidos.ler', 'cupons.ler', 'cupons.uso.ler'];
const PROBLEMA = 'https://api.dmsregem.com/problemas/';

type Chamada = { token: string; chave: string; corpo: Record<string, unknown> };
type Pedido = { action_id: string; code: string; status: string; status_reason: string | null };
type Item = { code: string; origin: string; kind: string; percent: number | null; value_micros: string | null; min_order_micros: string | null; link: { campaign: { id: string }; exclusive: boolean } | null };

describe.skipIf(!hasDb)('criar cupom no Regem com aprovação (A2.5 · F6 parte 2)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let flags: FlagService;
  let regem: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};

  // ---- o "Regem" de mentira
  const lojas: Record<string, { loja_id: string; loja_nome: string; escopos: string[] }> = {
    [TOKEN_CENTRO]: { loja_id: `loja-centro-${randomUUID().slice(0, 8)}`, loja_nome: 'Mister Burgers — Loja Centro', escopos: [...LEITURA, 'cupons.criar'] },
    [TOKEN_PRAIA]: { loja_id: `loja-praia-${randomUUID().slice(0, 8)}`, loja_nome: 'Mister Burgers — Loja Praia', escopos: LEITURA },
  };
  const chamadas: Chamada[] = [];
  /** Respostas guardadas por chave de idempotência (a repetição devolve a mesma). */
  const porChave = new Map<string, { status: number; corpo: unknown }>();
  const criados = new Map<string, Record<string, unknown>>();
  /** Códigos que já existem no Regem (criados lá, fora do Liame). */
  const existentes = new Set<string>(['JAEXISTE']);
  /** Quantas vezes o próximo `POST /cupons` cai com 503 antes de funcionar. */
  let quedas = 0;
  /** Código cuja primeira criação dá certo no Regem, mas a resposta se perde (503). */
  let respostaPerdida: string | null = null;

  function responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const loja = lojas[token];
    if (!loja) return { status: 401, corpo: { type: `${PROBLEMA}token-invalido`, title: 'Token inválido', status: 401 } };
    if (url.pathname === '/regem/loja') return { status: 200, corpo: { ...loja, empresa_nome: 'Mister Burgers', fuso: FUSO, moeda: 'BRL' } };
    if (url.pathname === '/regem/cupons' && req.method === 'POST') {
      const chave = String(req.headers['idempotency-key'] ?? '');
      const corpo = JSON.parse(texto) as Record<string, unknown>;
      chamadas.push({ token, chave, corpo });
      if (!chave) return { status: 400, corpo: { type: `${PROBLEMA}requisicao-invalida`, title: 'Falta Idempotency-Key', status: 400 } };
      if (!loja.escopos.includes('cupons.criar')) return { status: 403, corpo: { type: `${PROBLEMA}escopo-insuficiente`, title: 'Escopo insuficiente', status: 403, detail: 'falta cupons.criar' } };
      if (quedas > 0) {
        quedas -= 1;
        return { status: 503, corpo: { type: 'about:blank', title: 'Indisponível', status: 503 } };
      }
      const guardada = porChave.get(chave);
      if (guardada) return guardada;
      const codigo = String(corpo.codigo);
      let resposta: { status: number; corpo: unknown };
      if (codigo === 'REGRA422') {
        resposta = { status: 422, corpo: { type: `${PROBLEMA}regra-invalida`, title: 'Regra inválida', status: 422, detail: 'Regra inválida — valido_ate: já passou.' } };
      } else if (existentes.has(codigo) || criados.has(codigo)) {
        resposta = { status: 409, corpo: { type: `${PROBLEMA}codigo-em-uso`, title: 'Código em uso', status: 409, detail: `O código ${codigo} já existe` } };
      } else {
        const cupom = {
          id: `cp-${criados.size + 1}-${randomUUID().slice(0, 8)}`,
          versao: 1,
          atualizado_em: new Date().toISOString(),
          codigo,
          nome: corpo.nome ?? null,
          tipo: corpo.tipo,
          percentual: corpo.percentual ?? null,
          valor_centavos: corpo.valor_centavos ?? null,
          pedido_minimo_centavos: corpo.pedido_minimo_centavos ?? null,
          valido_de: corpo.valido_de ?? null,
          valido_ate: corpo.valido_ate ?? null,
          fuso: FUSO,
          ativo: true,
          usos: 0,
        };
        criados.set(codigo, cupom);
        resposta = { status: 201, corpo: cupom };
      }
      porChave.set(chave, resposta);
      if (respostaPerdida === codigo) {
        respostaPerdida = null;
        return { status: 503, corpo: { type: 'about:blank', title: 'Indisponível', status: 503 } };
      }
      return resposta;
    }
    return { status: 404, corpo: { type: 'about:blank', title: 'Não encontrado', status: 404 } };
  }
  const chamadasDe = (codigo: string) => chamadas.filter((c) => c.corpo.codigo === codigo);

  // ---- a empresa do teste
  type Empresa = { cookie: string; userId: string; secret: string; tenantId: string; brandId: string; centro: string; praia: string; semRegem: string; contaCentro: string; C1: string; C2: string; encerrada: string };
  let e: Empresa;
  const hoje = diaNoFuso(new Date(), FUSO);
  const somarDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const fim = somarDias(hoje, 30);

  const listar = (cookie = e.cookie, marca = e.brandId) => api.call('GET', `/v1/coupons?brand_id=${marca}`, { cookie });
  const pedir = (over: Record<string, unknown> = {}, cookie = e.cookie) =>
    api.call('POST', '/v1/coupons/regem', {
      cookie,
      body: { unit_id: e.centro, code: 'SEXTA15', kind: 'percentual', percent: 15, valid_from: hoje, valid_until: fim, campaign_id: e.C1, exclusive: true, ...over },
    });
  const cancelar = (id: string, cookie = e.cookie) => api.call('POST', `/v1/coupons/regem/${id}/cancel`, { cookie });
  const acao = async (id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: e.cookie })).body as { status: string; status_reason: string | null; plan_hash: string; mode: string };
  const ciclo = () => executor.runCycle(20, { tenantIds: [e.tenantId] });
  const pedidosDaLista = async () => (await listar()).body.requests as Pedido[];
  const itemDe = async (codigo: string) => ((await listar()).body.items as Item[]).find((i) => i.code === codigo);

  async function aprovar(id: string) {
    const a = await acao(id);
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    const ok = await api.call('POST', `/v1/actions/${id}/approve`, { cookie: e.cookie, body: { plan_hash: a.plan_hash, code: totpCode(e.secret, currentStep()) } });
    expect([ok.status, ok.body.status]).toEqual([200, 'aprovada']);
  }
  /** Pede, aprova e roda o worker; devolve o id da ação. */
  async function pedirAprovarExecutar(over: Record<string, unknown>) {
    const r = await pedir(over);
    expect(r.status).toBe(201);
    const id = r.body.request.action_id as string;
    await aprovar(id);
    await ciclo();
    return id;
  }
  async function ligarFlag(valor: boolean) {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'regem_write' and scope_type = 'tenant' and scope_id = $1`, [e.tenantId]);
    if (valor) {
      await ownerQuery(
        `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
         values (gen_random_uuid(), 'regem_write', 'tenant', $1, 'true'::jsonb, null, 'testes')`,
        [e.tenantId],
      );
    }
    flags.invalidate();
  }
  async function campanha(contaId: string, externo: string, nome: string, status = 'ativa') {
    const id = randomUUID();
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, $5, $6)`, [
      id,
      e.tenantId,
      contaId,
      externo,
      nome,
      status,
    ]);
    return id;
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    regem = createServer((req, res) => {
      let texto = '';
      req.on('data', (c: Buffer) => {
        texto += c.toString('utf8');
      });
      req.on('end', () => {
        const r = responder(req, texto);
        res.writeHead(r.status, { 'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => regem.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regem.address() as AddressInfo).port}`;
    anterior.REGEM_API_URL = process.env.REGEM_API_URL;
    process.env.REGEM_API_URL = `${base}/regem`;
    api = await startApi();
    await resetIpRateLimits();
    database = api.app.get(DATABASE);
    flags = api.app.get(FlagService);
    executor = new ActionExecutor(database, api.app.get(BudgetService), api.app.get(KillSwitchService), flags);

    const s = await signupAndLogin(api, undefined, 'Mister Burgers Cria Cupom');
    const { secret } = await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const [centro, praia, semRegem] = [randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $4, $5, 'Loja Centro'), ($2, $4, $5, 'Loja Praia'), ($3, $4, $5, 'Loja Barra')`, [centro, praia, semRegem, tenantId, brandId]);

    // O Regem das duas lojas: a Centro liberou "criar cupom de campanha"; a Praia, só a leitura.
    const r = await registrarConexaoDaDistribuicao(
      { db: database!.db, vault: api.app.get(VaultService), config: loadConfig() },
      { tenantId, brandId, produto: 'regem', tokens: [TOKEN_CENTRO, TOKEN_PRAIA] },
    );
    const ligar = await api.call('POST', `/v1/connections/${r.connectionId}/accounts`, {
      cookie: s.cookie,
      body: {
        accounts: [
          { provider: 'regem', external_id: lojas[TOKEN_CENTRO]!.loja_id, unit_id: centro },
          { provider: 'regem', external_id: lojas[TOKEN_PRAIA]!.loja_id, unit_id: praia },
        ],
      },
    });
    expect(ligar.status).toBe(200);
    const contaCentro = (await ownerQuery<{ id: string }>(`select id from liame.connected_account where tenant_id = $1 and unit_id = $2 and provider = 'regem'`, [tenantId, centro]))[0]!.id;

    const meta = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Mister', 'BRL', $5)`,
      [meta, tenantId, brandId, randomUUID(), FUSO],
    );
    e = { cookie: s.cookie, userId: s.me.user.id as string, secret, tenantId, brandId, centro, praia, semRegem, contaCentro, C1: '', C2: '', encerrada: '' };
    e.C1 = await campanha(meta, '1201', 'Combo sexta');
    e.C2 = await campanha(meta, '1202', 'Smash em dobro');
    e.encerrada = await campanha(meta, '1203', 'Inauguração', 'removida');
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    if (e) await ligarFlag(false);
    await api?.close();
    await new Promise((ok) => regem?.close(ok));
    if (anterior.REGEM_API_URL === undefined) delete process.env.REGEM_API_URL;
    else process.env.REGEM_API_URL = anterior.REGEM_API_URL;
  });

  it('nasce desligado: a lista diz que a criação está desligada, mostra a loja que liberou a criação, e o pedido volta 403 sem chamar o Regem', async () => {
    const lista = await listar();
    expect(lista.status).toBe(200);
    expect(lista.body.create_in_regem).toBe(false);
    expect((await api.call('GET', '/v1/connections', { cookie: e.cookie })).body.regem_write).toBe(false);
    expect(lista.body.requests).toEqual([]);
    expect((lista.body.stores as { unit: { name: string }; can_create: boolean }[]).map((l) => [l.unit.name, l.can_create])).toEqual([
      ['Loja Centro', true],
      ['Loja Praia', false],
    ]);
    const r = await pedir();
    expect([r.status, r.body.code]).toEqual([403, 'escrita-desligada']);
    expect(chamadas).toEqual([]);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]);
    expect(n!.n).toBe('0');
  });

  it('pedir → aguardando aprovação na lista (nada no Regem) → aprovar com o código do app → o worker cria no Regem e o cupom aparece ligado à campanha', async () => {
    await ligarFlag(true);
    expect((await listar()).body.create_in_regem).toBe(true);
    // Contas conectadas sabe pela mesma flag que a permissão "criar cupom" liberada pela loja já vale.
    expect((await api.call('GET', `/v1/connections?brand_id=${e.brandId}`, { cookie: e.cookie })).body.regem_write).toBe(true);

    const r = await pedir({ code: ' sexta15 ', min_order_micros: '50000000' });
    expect(r.status).toBe(201);
    expect(r.body.request).toMatchObject({
      code: 'SEXTA15',
      connected_account_id: e.contaCentro,
      kind: 'percentual',
      percent: 15,
      value_micros: null,
      min_order_micros: '50000000',
      valid_from: hoje,
      valid_until: fim,
      campaign: { id: e.C1, name: 'Combo sexta', provider: 'meta_ads', status: 'ativa' },
      exclusive: true,
      status: 'aguardando_aprovacao',
      status_reason: null,
      requested_by: { id: e.userId, name: 'Pessoa de Teste' },
    });
    const id = r.body.request.action_id as string;
    // A política da plataforma manda a criação de cupom para aprovação (sem regra da empresa).
    expect((await acao(id)).mode).toBe('APPROVAL');
    expect(chamadas).toEqual([]);
    expect((await pedidosDaLista()).map((p) => [p.action_id, p.status])).toEqual([[id, 'aguardando_aprovacao']]);
    expect(await itemDe('SEXTA15')).toBeUndefined();

    // O mesmo código enquanto o pedido está de pé: um pedido por vez.
    const repetido = await pedir();
    expect([repetido.status, repetido.body.code]).toEqual([409, 'acao-duplicada']);
    // Sem aprovação, o worker não cria nada.
    await ciclo();
    expect(chamadas).toEqual([]);

    await aprovar(id);
    expect((await pedidosDaLista()).map((p) => p.status)).toEqual(['aprovada']);
    await ciclo();

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.token).toBe(TOKEN_CENTRO);
    expect(chamadas[0]!.chave).toMatch(/^liame-[0-9a-f]{48}$/);
    expect(chamadas[0]!.corpo).toEqual({
      codigo: 'SEXTA15',
      nome: 'Liame · Combo sexta',
      tipo: 'percentual',
      percentual: '15.00',
      pedido_minimo_centavos: 5000,
      valido_de: hoje,
      valido_ate: fim,
    });
    expect(await acao(id)).toMatchObject({ status: 'executada', status_reason: null });
    expect(await pedidosDaLista()).toEqual([]);
    expect(await itemDe('SEXTA15')).toMatchObject({
      origin: 'regem',
      kind: 'percentual',
      percent: 15,
      min_order_micros: '50000000',
      link: { campaign: { id: e.C1 }, exclusive: true },
    });

    // O vínculo leva quem pediu; a execução guarda o resultado sem o token da loja.
    const [vinculo] = await ownerQuery<{ created_by: string | null }>(
      `select cc.created_by from liame.campaign_coupon cc join liame.coupon cp on cp.id = cc.coupon_id where cp.connected_account_id = $1 and cp.code = 'SEXTA15'`,
      [e.contaCentro],
    );
    expect(vinculo!.created_by).toBe(e.userId);
    const [exec] = await ownerQuery<{ status: string; result_state: Record<string, unknown> }>(`select status, result_state from liame.action_execution where action_request_id = $1`, [id]);
    expect(exec).toMatchObject({ status: 'executada', result_state: { codigo: 'SEXTA15', existe: true, vinculo: 'feito', campanha_id: e.C1, exclusivo: true } });
    const trilha = await ownerQuery<{ action: string; actor_type: string; origin: string; tudo: string }>(
      `select action, actor_type, origin, row_to_json(a)::text as tudo from liame.audit_event a where chain_key = $1 and resource_id = $2 order by chain_seq`,
      [e.tenantId, id],
    );
    expect(trilha.map((t) => [t.action, t.actor_type, t.origin])).toEqual([
      ['cupom.pedir_criacao', 'human', 'api'],
      ['acao.aprovar', 'human', 'api'],
      ['acao.executar', 'system', 'worker'],
    ]);
    const guardado = await ownerQuery<{ tudo: string }>(`select row_to_json(r)::text as tudo from liame.action_request r where id = $1`, [id]);
    expect(`${JSON.stringify(exec)}${trilha.map((t) => t.tudo).join('')}${guardado[0]!.tudo}`).not.toContain('rgm_it_');
    expect((await api.call('GET', '/v1/audit/verify', { cookie: e.cookie })).body.ok).toBe(true);

    // O código que acabou de nascer não pode ser pedido de novo.
    const deNovo = await pedir();
    expect([deNovo.status, deNovo.body.code]).toEqual([422, 'plano-recusado']);
    expect(deNovo.body.detail).toContain('Já existe um cupom com este código');
  });

  it('valor fixo e entrega grátis: a regra vai ao Regem em centavos, sem campo que não é do tipo; cupom não exclusivo fica ligado para acompanhar', async () => {
    await ligarFlag(true);
    await pedirAprovarExecutar({ code: 'DEZREAIS', kind: 'valor', percent: undefined, value_micros: '10000000', campaign_id: e.C2, exclusive: false });
    expect(chamadasDe('DEZREAIS').map((c) => c.corpo)).toEqual([{ codigo: 'DEZREAIS', nome: 'Liame · Smash em dobro', tipo: 'valor', valor_centavos: 1000, valido_de: hoje, valido_ate: fim }]);
    expect(await itemDe('DEZREAIS')).toMatchObject({ kind: 'valor', value_micros: '10000000', min_order_micros: null, link: { campaign: { id: e.C2 }, exclusive: false } });

    await pedirAprovarExecutar({ code: 'FRETE0', kind: 'frete_gratis', percent: undefined, min_order_micros: '30000000' });
    expect(chamadasDe('FRETE0').map((c) => c.corpo)).toEqual([{ codigo: 'FRETE0', nome: 'Liame · Combo sexta', tipo: 'frete_gratis', pedido_minimo_centavos: 3000, valido_de: hoje, valido_ate: fim }]);
    expect(await itemDe('FRETE0')).toMatchObject({ kind: 'frete_gratis', percent: null, value_micros: null });
  });

  it('recusas do Regem viram falha com o motivo, sem cupom na lista: código em uso (409) e regra inválida (422); pedir de novo e cancelar', async () => {
    await ligarFlag(true);
    const usado = await pedirAprovarExecutar({ code: 'JAEXISTE' });
    expect(await acao(usado)).toMatchObject({ status: 'falhou', status_reason: 'Já existe um cupom com este código no Regem. Escolha outro código.' });
    expect(await itemDe('JAEXISTE')).toBeUndefined();
    expect((await pedidosDaLista()).filter((p) => p.code === 'JAEXISTE')).toMatchObject([{ action_id: usado, status: 'falhou', status_reason: 'Já existe um cupom com este código no Regem. Escolha outro código.' }]);

    const regra = await pedirAprovarExecutar({ code: 'REGRA422' });
    const falha = await acao(regra);
    expect(falha.status).toBe('falhou');
    expect(falha.status_reason).toBe('O Regem não aceitou a regra do cupom. Regra inválida — valido_ate: já passou.');
    const [exec] = await ownerQuery<{ status: string; error: string }>(`select status, error from liame.action_execution where action_request_id = $1`, [regra]);
    expect(exec).toMatchObject({ status: 'falhou' });

    // O pedido que falhou não trava o código: dá para pedir de novo, e o antigo sai da lista.
    const novo = await pedir({ code: 'JAEXISTE' });
    expect(novo.status).toBe(201);
    expect((await pedidosDaLista()).filter((p) => p.code === 'JAEXISTE').map((p) => [p.action_id, p.status])).toEqual([[novo.body.request.action_id, 'aguardando_aprovacao']]);

    // Cancelar o pedido antes da aprovação: some da lista e nada vai ao Regem.
    const antes = chamadasDe('JAEXISTE').length;
    expect((await cancelar(novo.body.request.action_id)).status).toBe(204);
    expect((await pedidosDaLista()).filter((p) => p.code === 'JAEXISTE')).toEqual([]);
    await ciclo();
    expect(chamadasDe('JAEXISTE')).toHaveLength(antes);
    expect((await acao(novo.body.request.action_id)).status).toBe('cancelada');
    // Cancelar de novo, ou o que já executou, não passa; ação que não existe é 404.
    expect((await cancelar(novo.body.request.action_id)).status).toBe(409);
    expect((await cancelar(usado)).status).toBe(409);
    expect((await cancelar(randomUUID())).status).toBe(404);
  });

  it('queda passageira do Regem: a ação volta para a fila e repete com a MESMA chave; o cupom nasce uma vez só', async () => {
    await ligarFlag(true);
    quedas = 1;
    const r = await pedir({ code: 'CAIU10' });
    const id = r.body.request.action_id as string;
    await aprovar(id);
    await ciclo();
    // Erro passageiro: nada gravado, a ação fica travada em execução até o prazo de devolver à fila.
    expect((await acao(id)).status).toBe('executando');
    expect(await itemDe('CAIU10')).toBeUndefined();
    await ownerQuery(`update liame.action_request set updated_at = now() - interval '11 minutes' where id = $1`, [id]);
    await ciclo();
    expect((await acao(id)).status).toBe('executada');
    const feitas = chamadasDe('CAIU10');
    expect(feitas).toHaveLength(2);
    expect(feitas[0]!.chave).toBe(feitas[1]!.chave);
    expect(await itemDe('CAIU10')).toMatchObject({ link: { campaign: { id: e.C1 }, exclusive: true } });
  });

  it('o Regem criou, mas a resposta se perdeu, e a leitura trouxe o cupom antes da repetição: a mesma chave devolve o mesmo cupom e ele sai ligado, sem duplicar', async () => {
    await ligarFlag(true);
    respostaPerdida = 'PERDEU20';
    const r = await pedir({ code: 'PERDEU20', percent: 20 });
    const id = r.body.request.action_id as string;
    await aprovar(id);
    await ciclo();
    expect((await acao(id)).status).toBe('executando');
    expect(criados.has('PERDEU20')).toBe(true);

    // A leitura periódica dos cupons traz o cupom que o Regem criou (ainda sem campanha no Liame).
    const doRegem = CupomRegem.parse(criados.get('PERDEU20'));
    await withTenant(database.db, e.tenantId, (tx) => gravarCupons(tx, { tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.contaCentro }, [doRegem]));
    expect(await itemDe('PERDEU20')).toMatchObject({ link: null });

    await ownerQuery(`update liame.action_request set updated_at = now() - interval '11 minutes' where id = $1`, [id]);
    await ciclo();
    expect(await acao(id)).toMatchObject({ status: 'executada', status_reason: null });
    expect(await itemDe('PERDEU20')).toMatchObject({ percent: 20, link: { campaign: { id: e.C1 }, exclusive: true } });
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.coupon where connected_account_id = $1 and code = 'PERDEU20'`, [e.contaCentro]);
    expect(n!.n).toBe('1');
  });

  it('campanha encerrada entre o pedido e a aprovação: o cupom não é criado no Regem e o pedido falha com o motivo', async () => {
    await ligarFlag(true);
    const temporaria = await campanha((await ownerQuery<{ id: string }>(`select connected_account_id as id from liame.campaign where id = $1`, [e.C1]))[0]!.id, '1299', 'Relâmpago');
    const r = await pedir({ code: 'RELAMPAGO', campaign_id: temporaria });
    const id = r.body.request.action_id as string;
    await aprovar(id);
    await ownerQuery(`update liame.campaign set status = 'removida' where id = $1`, [temporaria]);
    await ciclo();
    const fim = await acao(id);
    expect(fim.status).toBe('falhou');
    expect(fim.status_reason).toBe('Esta campanha foi removida ou arquivada na plataforma. O cupom não foi criado: peça de novo com outra campanha.');
    expect(chamadasDe('RELAMPAGO')).toEqual([]);
  });

  it('flag desligada depois da aprovação: o worker não cria (a escrita se confere de novo na hora de executar)', async () => {
    await ligarFlag(true);
    const r = await pedir({ code: 'DESLIGOU' });
    const id = r.body.request.action_id as string;
    await aprovar(id);
    await ligarFlag(false);
    await ciclo();
    expect(await acao(id)).toMatchObject({ status: 'falhou', status_reason: 'escrita em regem desligada' });
    expect(chamadasDe('DESLIGOU')).toEqual([]);
  });

  it('recusas no pedido: campos fora da regra, validade no passado, campanha encerrada, loja que não liberou a criação, loja sem Regem; nenhuma deixa pedido', async () => {
    await ligarFlag(true);
    const antes = (await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n;
    const campo = async (over: Record<string, unknown>) => {
      const r = await pedir({ code: 'NOVO10', ...over });
      return [r.status, (r.body.errors as { path: string }[] | undefined)?.map((x) => x.path).join(',') ?? r.body.code];
    };
    expect(await campo({ percent: undefined })).toEqual([400, 'percent']);
    expect(await campo({ percent: 101 })).toEqual([400, 'percent']);
    expect(await campo({ percent: 12.5 })).toEqual([400, 'percent']);
    expect(await campo({ kind: 'valor' })).toEqual([400, 'percent,value_micros']);
    expect(await campo({ kind: 'valor', percent: undefined, value_micros: '10005' })).toEqual([400, 'value_micros']);
    expect(await campo({ kind: 'valor', percent: undefined, value_micros: '0' })).toEqual([400, 'value_micros']);
    expect(await campo({ kind: 'frete_gratis', percent: undefined, value_micros: '5000000' })).toEqual([400, 'value_micros']);
    expect(await campo({ min_order_micros: '15' })).toEqual([400, 'min_order_micros']);
    expect(await campo({ valid_until: somarDias(hoje, -1), valid_from: somarDias(hoje, -5) })).toEqual([400, 'valid_until']);
    expect(await campo({ valid_from: somarDias(hoje, 5), valid_until: somarDias(hoje, 2) })).toEqual([400, 'valid_until']);
    expect(await campo({ valid_until: '31/10/2026' })).toEqual([400, 'valid_until']);
    expect(await campo({ code: 'ab' })).toEqual([400, 'code']);
    expect(await campo({ code: 'COM ESPACO' })).toEqual([400, 'code']);
    expect(await campo({ code: 'SEXTA-15' })).toEqual([400, 'code']);
    expect(await campo({ kind: 'outro' })).toEqual([400, 'kind']);

    expect(await campo({ campaign_id: e.encerrada })).toEqual([422, 'campanha-encerrada']);
    expect(await campo({ campaign_id: randomUUID() })).toEqual([404, 'nao-encontrado']);
    expect(await campo({ unit_id: e.semRegem })).toEqual([422, 'loja-sem-regem']);
    expect(await campo({ unit_id: randomUUID() })).toEqual([404, 'nao-encontrado']);
    const semEscopo = await pedir({ code: 'NOVO10', unit_id: e.praia });
    expect([semEscopo.status, semEscopo.body.code]).toEqual([422, 'plano-recusado']);
    expect(semEscopo.body.detail).toContain('Contas conectadas');

    const depois = (await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n;
    expect(depois).toBe(antes);
    expect(chamadasDe('NOVO10')).toEqual([]);
  });

  it('política da empresa em modo sombra para a criação de cupom: o pedido é recusado com o motivo, em vez de ficar parado sem aprovação', async () => {
    await ligarFlag(true);
    const politica = await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { document: { rules: [{ type: 'autonomy', action: 'cupom.criar', mode: 'SHADOW' }] } } });
    expect(politica.status).toBe(201);
    const r = await pedir({ code: 'SOMBRA10' });
    expect([r.status, r.body.code]).toEqual([409, 'criacao-em-sombra']);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1 and resource_id = 'cupom:SOMBRA10'`, [e.tenantId]);
    expect(n!.n).toBe('0');
    // Volta a política ao padrão da plataforma (aprovação) para não vazar para os outros testes do arquivo.
    const volta = await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { document: { rules: [{ type: 'autonomy', action: 'cupom.criar', mode: 'APPROVAL' }] } } });
    expect(volta.status).toBe(201);
    expect((await pedir({ code: 'SOMBRA10' })).status).toBe(201);
  });

  it('recusar: quem pode aprovar recusa com o motivo e o plano visto; o pedido volta como recusado na aba Cupons, nada vai ao Regem e a auditoria guarda quem recusou', async () => {
    await ligarFlag(true);
    const r = await pedir({ code: 'RECUSA10' });
    const id = r.body.request.action_id as string;
    const a = await acao(id);
    // O pedido leva o que a tela Aprovações mostra: quem pediu, a loja do alvo e a campanha.
    expect(a).toMatchObject({
      requested_by: { id: e.userId, name: 'Pessoa de Teste' },
      account_name: 'Loja Centro',
      campaign: { id: e.C1, name: 'Combo sexta', provider: 'meta_ads', status: 'ativa' },
    });
    expect(Date.parse((a as unknown as { updated_at: string }).updated_at)).not.toBeNaN();
    const recusar = (corpo: Record<string, unknown>, cookie = e.cookie) => api.call('POST', `/v1/actions/${id}/reject`, { cookie, body: corpo });
    expect((await recusar({ plan_hash: a.plan_hash, reason: 'x' })).status).toBe(400);
    expect((await recusar({ reason: 'Desconto alto demais' })).status).toBe(400);
    const trocado = await recusar({ plan_hash: 'f'.repeat(64), reason: 'Desconto alto demais' });
    expect([trocado.status, trocado.body.code]).toEqual([409, 'plano-mudou']);

    // Quem só lê não recusa; o Aprovador (aprova e recusa, sem operar campanha nem pedir cupom) recusa, sem código do app.
    const convidar = async (papel: string, nome: string, extra: Record<string, unknown> = {}) => {
      const email = uniqueEmail(nome.split(' ')[0]!.toLowerCase());
      expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: papel, ...extra } })).status).toBe(201);
      const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: nome, password: PASSWORD, terms_version: TERMOS } });
      expect(s.status).toBe(200);
      return s.cookie!;
    };
    const leitor = await convidar('somente_leitura', 'Leo Leitor');
    expect((await recusar({ plan_hash: a.plan_hash, reason: 'Desconto alto demais' }, leitor)).body.code).toBe('sem-permissao');
    // O convite de Aprovador pede o limite de aprovação por ação.
    const aprovador = await convidar('aprovador', 'Ana Aprovadora', { approve_limit_micros: 100_000_000 });
    // Quem pode aprovar só age com o app autenticador ativo (recusar não pede o código, mas a conta precisa dele).
    expect((await recusar({ plan_hash: a.plan_hash, reason: 'Desconto alto demais' }, aprovador)).body.code).toBe('segundo-fator-nao-configurado');
    await enableMfa(api, aprovador);
    expect((await pedir({ code: 'APROVA10' }, aprovador)).body.code).toBe('sem-permissao');
    const feito = await recusar({ plan_hash: a.plan_hash, reason: '  Desconto alto demais ' }, aprovador);
    expect([feito.status, feito.body.status, feito.body.status_reason]).toEqual([200, 'cancelada', 'recusada por Ana Aprovadora: Desconto alto demais']);
    expect(feito.body.workflow).toMatchObject({ status: 'cancelado' });
    const deNovo = await recusar({ plan_hash: a.plan_hash, reason: 'Desconto alto demais' }, aprovador);
    expect([deNovo.status, deNovo.body.code]).toEqual([409, 'acao-nao-aguarda']);

    // Na aba Cupons, quem pediu vê que foi recusado, por quem e por quê; nada foi ao Regem.
    expect((await pedidosDaLista()).find((p) => p.code === 'RECUSA10')).toMatchObject({ action_id: id, status: 'recusada', status_reason: 'recusada por Ana Aprovadora: Desconto alto demais' });
    await ciclo();
    expect(chamadasDe('RECUSA10')).toEqual([]);
    const trilha = await ownerQuery<{ action: string; actor_label: string; after: Record<string, unknown> }>(
      `select action, actor_label, after from liame.audit_event where chain_key = $1 and resource_id = $2 order by chain_seq`,
      [e.tenantId, id],
    );
    expect(trilha.map((t) => t.action)).toEqual(['cupom.pedir_criacao', 'acao.recusar']);
    expect(trilha[1]).toMatchObject({ after: { status: 'cancelada', recusada: true, reason: 'Desconto alto demais' } });
    const eventos = await ownerQuery<{ type: string; data: { rejected?: boolean } }>(`select type, data from liame.outbox_event where subject = $1 order by created_at`, [id]);
    expect(eventos.map((x) => [x.type, x.data.rejected ?? null])).toEqual([
      ['liame.action.requested', null],
      ['liame.action.cancelled', true],
    ]);

    // O pedido recusado não trava o código: pedir de novo tira o recusado da lista.
    const outro = await pedir({ code: 'RECUSA10' });
    expect(outro.status).toBe(201);
    expect((await pedidosDaLista()).filter((p) => p.code === 'RECUSA10').map((p) => p.status)).toEqual(['aguardando_aprovacao']);
    expect((await cancelar(outro.body.request.action_id)).status).toBe(204);
  });

  it('permissão e isolamento: Somente leitura vê os pedidos, mas não pede nem cancela; outra empresa não pede na loja desta nem cancela o pedido desta (A1-3)', async () => {
    await ligarFlag(true);
    const meu = await pedir({ code: 'MEUPEDIDO' });
    expect(meu.status).toBe(201);
    const id = meu.body.request.action_id as string;

    const email = uniqueEmail('leitura-cria-cupom');
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: 'somente_leitura' } })).status).toBe(201);
    const leitor = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Leitor', password: PASSWORD, terms_version: TERMOS } });
    const c = leitor.cookie!;
    const lista = await listar(c);
    expect(lista.status).toBe(200);
    expect((lista.body.requests as Pedido[]).map((p) => p.code)).toContain('MEUPEDIDO');
    expect([(await pedir({ code: 'LEITOR10' }, c)).body.code, (await cancelar(id, c)).body.code]).toEqual(['sem-permissao', 'sem-permissao']);

    const outra = await signupAndLogin(api, undefined, 'Outra Hamburgueria Cria Cupom');
    await enableMfa(api, outra.cookie);
    expect((await pedir({ code: 'INVASAO' }, outra.cookie)).status).toBe(404);
    expect((await cancelar(id, outra.cookie)).status).toBe(404);
    expect((await listar(outra.cookie)).status).toBe(404);
    expect((await acao(id)).status).toBe('aguardando_aprovacao');
    expect((await cancelar(id)).status).toBe(204);
  });
});
