import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONNECTORS } from '../../src/actions/connectors.js';
import { regemcastMensagemConnector } from '../../src/actions/regemcast-mensagem.js';
import type { ActionExecutor } from '../../src/worker/action-executor.js';
import type { TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y5 (parte 2): o pedido de mensagem de WhatsApp pelo trilho de ação, do pedido à pausa, pela API e contra um
// RegemCast falso que fala o MCP sem estado e guarda as campanhas, o plano do disparo, a confirmação e a chave de
// idempotência como o de verdade. Em produção o conector do RegemCast ainda NÃO está no registro (entra com as telas,
// depois do aceite do protótipo P15): aqui ele é registrado só neste arquivo, ANTES de o app carregar. Por isso o app e
// os ajudantes entram por `import()` dentro do `beforeAll`.
CONNECTORS.regemcast = regemcastMensagemConnector;

const TODAS = ['conversas.anuncio.ler', 'conta.ler', 'campanhas.ler', 'publicos.ler', 'modelos.ler', 'orcamento.ler', 'modelos.rascunhar', 'campanhas.rascunhar', 'campanhas.disparar'];
const PLANO_MUDOU = 'O plano mudou desde a confirmação. Peça um plano novo com campanha_disparo_planejar.';

type Campanha = { id: string; conta: string; nome: string; situacao: string; destinatarios: number; naFila: number; enviadas: number; custo: number | null; impedimentos: string[] };
type Perfil = { contaId: string; permissoes: string[] };
type Chamada = { token: string; ferramenta: string; argumentos: Record<string, unknown> };
type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; secret: string; token: string; contaId: string; conta: string };
type Resposta = Awaited<ReturnType<TestApi['call']>>;

describe.skipIf(!hasDb)('pedido de mensagem pelo trilho de ação: do pedido à pausa (A5 · Y5, conector registrado só no teste)', () => {
  let api: TestApi;
  let database: Database;
  let executor: ActionExecutor;
  let regemcast: Server;
  let base = '';
  let e: Empresa;
  let ownerQuery: typeof import('../helpers/api.js').ownerQuery;
  let resetIpRateLimits: typeof import('../helpers/api.js').resetIpRateLimits;
  let ajuda: typeof import('../helpers/api.js');
  let registrar: typeof import('../../src/connections/distribuicao.js').registrarConexaoDaDistribuicao;
  let deps: Parameters<typeof import('../../src/connections/distribuicao.js').registrarConexaoDaDistribuicao>[0];
  let codigoDoApp: (segredo: string) => string;
  let invalidarFlags: () => void;
  const anterior: Record<string, string | undefined> = {};

  // ---------------------------------------------------------------- o RegemCast falso
  const perfis = new Map<string, Perfil>();
  const campanhas = new Map<string, Campanha>();
  /** O teto do mês de cada conta (em centavos), com o que já saiu. Sem linha: a conta não tem teto definido. */
  const orcamentos = new Map<string, { teto: number; gasto: number }>();
  const chaves = new Map<string, { pedido: string; resposta: unknown }>();
  const chamadas: Chamada[] = [];
  /** A ferramenta que responde 503 nesta quantidade de chamadas antes de voltar. */
  const caidas = new Map<string, number>();

  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const recusada = (texto: string) => ({ result: { content: [{ type: 'text', text: texto }], isError: true, resultType: 'complete' } });
  const paraFora = (c: Campanha) => ({
    id: c.id,
    nome: c.nome,
    situacao: c.situacao,
    pausaMotivo: c.situacao === 'pausada' ? 'integracao' : null,
    modelo: 'promo_sexta_v2',
    categoria: 'marketing',
    publico: 'Quem pediu nos últimos 30 dias',
    destinatarios: c.destinatarios,
    naFila: c.naFila,
    enviadas: c.enviadas,
    entregues: 0,
    lidas: 0,
    falhas: 0,
    responderam: 0,
    criadaEm: '2026-09-30T12:12:00.000Z',
    iniciadaEm: c.situacao === 'rascunho' ? null : '2026-10-02T14:00:00.000Z',
    concluidaEm: null,
  });
  const custoDe = (c: Campanha) => (c.custo === null ? null : { moeda: 'BRL', gastoCentavos: 0, aSairCentavos: c.custo, linhas: [{ rotulo: 'Custo estimado na Meta', valor: `até ${c.custo} centavos`, detalhe: `${c.naFila} mensagens de marketing` }], avisos: [] });
  function planoDe(c: Campanha) {
    const o = orcamentos.get(c.conta) ?? null;
    const impedimentos = [...c.impedimentos, ...(c.situacao === 'rascunho' ? [] : ['A campanha não está em rascunho.']), ...(o ? [] : ['A conta não tem teto de gasto de disparos definido.'])];
    const pode = impedimentos.length === 0;
    return {
      campanha: paraFora(c),
      custo: custoDe(c),
      orcamento: { definido: Boolean(o), periodos: o ? [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: o.teto, gastoCentavos: o.gasto, texto: `${o.gasto} de ${o.teto}`, sinal: 'ok' }] : [], aviso: null },
      podeDisparar: pode,
      impedimentos,
      // A impressão digital do que o plano mostrou: muda com o público, o custo, o orçamento ou a situação.
      confirmacao: pode ? createHash('sha256').update(JSON.stringify([c.id, c.situacao, c.destinatarios, c.naFila, c.custo, o])).digest('hex').slice(0, 40) : null,
    };
  }

  function responder(credencial: string, corpo: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }): { status: number; corpo: unknown } {
    const perfil = perfis.get(credencial);
    if (!perfil) return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
    const nome = corpo.params?.name ?? '';
    const args = corpo.params?.arguments ?? {};
    chamadas.push({ token: credencial, ferramenta: nome, argumentos: args });
    const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
    if (nome === 'integracao_situacao') {
      return {
        status: 200,
        corpo: comId(
          resultado({ contaId: perfil.contaId, conta: 'Mister Burgers', fuso: 'America/Sao_Paulo', produto: 'liame', classe: 'dms', token: 'Liame — piloto', permissoes: perfil.permissoes.map((id) => ({ id, rotulo: id, descricao: '' })), limitePorMinuto: 60 }),
        ),
      };
    }
    const doDisparo = ['campanha_disparo_planejar', 'campanha_disparar', 'campanha_pausar'].includes(nome);
    if (!doDisparo || !perfil.permissoes.includes('campanhas.disparar')) return { status: 200, corpo: comId({ error: { code: -32602, message: `Tool ${nome} not found` } }) };
    const restam = caidas.get(nome) ?? 0;
    if (restam > 0) {
      caidas.set(nome, restam - 1);
      return { status: 503, corpo: { mensagem: 'fora do ar' } };
    }
    const c = campanhas.get(String(args.id));
    // De outra conta, ou inexistente: para quem chama, a campanha não existe.
    if (!c || c.conta !== perfil.contaId) return { status: 200, corpo: comId(recusada('Campanha não encontrada.')) };
    if (nome === 'campanha_disparo_planejar') return { status: 200, corpo: comId(resultado(planoDe(c))) };

    const { chaveIdempotencia, ...pedido } = args;
    const chave = `${nome}:${String(chaveIdempotencia)}`;
    const guardada = chaves.get(chave);
    if (guardada) {
      if (guardada.pedido !== JSON.stringify(pedido)) return { status: 200, corpo: comId(recusada('Esta chave já foi usada com outro pedido. Use uma chave nova.')) };
      return { status: 200, corpo: comId(guardada.resposta as object) };
    }
    let resposta: unknown;
    if (nome === 'campanha_disparar') {
      const plano = planoDe(c);
      if (!plano.podeDisparar) resposta = recusada(plano.impedimentos.join(' '));
      else if (plano.confirmacao !== args.confirmacao) resposta = recusada(PLANO_MUDOU);
      else {
        c.situacao = 'enviando';
        resposta = resultado({ campanha: paraFora(c), custo: custoDe(c), proximoPasso: 'A campanha entrou na fila de envio.' });
      }
    } else if (c.situacao !== 'enviando' && c.situacao !== 'agendada') resposta = recusada('A campanha não está em andamento: não há o que pausar.');
    else {
      c.situacao = 'pausada';
      resposta = resultado({ campanha: paraFora(c), proximoPasso: 'A campanha está pausada. Quem retoma é uma pessoa da conta, em Campanhas.' });
    }
    if (!(resposta as { result: { isError?: boolean } }).result.isError) chaves.set(chave, { pedido: JSON.stringify(pedido), resposta });
    return { status: 200, corpo: comId(resposta as object) };
  }

  // ---------------------------------------------------------------- ajudantes
  /** Uma campanha em rascunho no RegemCast, montada pelo Liame para a conta da empresa. */
  function rascunho(emp: Empresa, extra: Partial<Campanha> = {}): Campanha {
    const c: Campanha = { id: randomUUID(), conta: emp.contaId, nome: 'Sexta em dobro', situacao: 'rascunho', destinatarios: 412, naFila: 412, enviadas: 0, custo: 13_184, impedimentos: [], ...extra };
    campanhas.set(c.id, c);
    return c;
  }
  const doToken = (emp: Empresa) => chamadas.filter((c) => c.token === emp.token).map((c) => c.ferramenta);
  const pedir = (emp: Empresa, tool: string, c: { id: string }, conta = emp.conta): Promise<Resposta> =>
    api.call('POST', '/v1/actions', { cookie: emp.cookie, body: { tool, provider: 'regemcast', account_id: conta, resource_id: `mensagem:${c.id}`, params: {} } });
  /** Aprova com o código do app de agora (o passo usado e o limite de tentativas são zerados: o teste aprova muito). */
  async function aprovar(emp: Empresa, pedido: { id: string; plan_hash: string }): Promise<Resposta> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [emp.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${emp.userId}`]);
    return api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: emp.cookie, body: { plan_hash: pedido.plan_hash, code: codigoDoApp(emp.secret) } });
  }
  const ciclo = (emp: Empresa) => executor.runCycle(20, { tenantIds: [emp.tenantId] });
  const ver = async (emp: Empresa, id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: emp.cookie })).body;
  const desfazer = (emp: Empresa, id: string) => api.call('POST', `/v1/actions/${id}/undo`, { cookie: emp.cookie });
  async function ligarFlag(emp: Empresa, flag: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [flag, emp.tenantId]);
    if (valor) await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, emp.tenantId]);
    invalidarFlags();
  }
  /** Uma empresa com a conta do RegemCast conectada pelo caminho de verdade e o teto de gasto de mensagens definido lá. */
  async function empresa(opcoes: { escrita?: boolean; permissoes?: string[]; teto?: { teto: number; gasto: number } | null } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await ajuda.signupAndLogin(api, undefined, 'Hamburgueria do Pedido de Mensagem');
    const { secret } = await ajuda.enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const token = `rct_it_${randomBytes(33).toString('base64url').slice(0, 43)}`;
    const contaId = randomUUID();
    perfis.set(token, { contaId, permissoes: opcoes.permissoes ?? TODAS });
    if (opcoes.teto !== null) orcamentos.set(contaId, opcoes.teto ?? { teto: 30_000, gasto: 12_736 });
    const conexao = await registrar(deps, { tenantId, brandId, produto: 'regemcast', tokens: [token] });
    const ligada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: s.cookie, body: { accounts: [{ provider: 'regemcast', external_id: contaId }] } });
    expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
    const emp: Empresa = { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, secret, token, contaId, conta: ligada.body.linked[0].id as string };
    if (opcoes.escrita !== false) await ligarFlag(emp, 'whatsapp_campaign', true);
    return emp;
  }
  /** Pede, aprova com o código do app e executa; devolve a ação como ficou. */
  async function executar(emp: Empresa, tool: string, c: { id: string }) {
    const p = await pedir(emp, tool, c);
    expect([p.status, p.body.status], JSON.stringify(p.body)).toEqual([201, 'aguardando_aprovacao']);
    expect((await aprovar(emp, p.body)).body.status).toBe('aprovada');
    await ciclo(emp);
    return ver(emp, p.body.id);
  }

  beforeAll(async () => {
    const { createDatabase, runMigrations } = await import('@liame/database');
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    regemcast = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        let r: { status: number; corpo: unknown };
        try {
          const corpo = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}') as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
          const url = new URL(req.url ?? '/', base);
          if (url.pathname !== '/cast/mcp' || req.method !== 'POST') r = { status: 405, corpo: { mensagem: 'só POST' } };
          else if (req.headers['mcp-method'] !== corpo.method || req.headers['mcp-name'] !== (corpo.params?.name ?? '')) r = { status: 400, corpo: { jsonrpc: '2.0', id: corpo.id, error: { code: -32020, message: 'header mismatch' } } };
          else r = responder((req.headers.authorization ?? '').replace(/^Bearer /, ''), corpo);
        } catch {
          r = { status: 500, corpo: {} };
        }
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.status === 401 ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {}) });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => regemcast.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regemcast.address() as AddressInfo).port}`;
    anterior.REGEMCAST_API_URL = process.env.REGEMCAST_API_URL;
    process.env.REGEMCAST_API_URL = `${base}/cast`;

    ajuda = await import('../helpers/api.js');
    ({ ownerQuery, resetIpRateLimits } = ajuda);
    api = await ajuda.startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    const [{ ActionExecutor: Executor }, { BudgetService }, { KillSwitchService }, { FlagService }, { DATABASE }, totp, distribuicao, { VaultService }, { loadConfig }] = await Promise.all([
      import('../../src/worker/action-executor.js'),
      import('../../src/actions/budget.service.js'),
      import('../../src/kill-switch/kill-switch.service.js'),
      import('../../src/flags/flag.service.js'),
      import('../../src/database/database.module.js'),
      import('../../src/auth/totp.js'),
      import('../../src/connections/distribuicao.js'),
      import('../../src/vault/vault.service.js'),
      import('../../src/config.js'),
    ]);
    const flags = api.app.get(FlagService);
    invalidarFlags = () => flags.invalidate();
    codigoDoApp = (segredo) => totp.totpCode(segredo, totp.currentStep());
    executor = new Executor(api.app.get(DATABASE), api.app.get(BudgetService), api.app.get(KillSwitchService), flags);
    registrar = distribuicao.registrarConexaoDaDistribuicao;
    deps = { db: database.db, vault: api.app.get(VaultService), config: loadConfig() };
    e = await empresa();
  }, 120_000);
  beforeEach(async () => {
    chamadas.length = 0;
    caidas.clear();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    delete CONNECTORS.regemcast;
    if (anterior.REGEMCAST_API_URL === undefined) delete process.env.REGEMCAST_API_URL;
    else process.env.REGEMCAST_API_URL = anterior.REGEMCAST_API_URL;
    await api?.close();
    await database?.close();
    await new Promise((ok) => regemcast?.close(ok));
  });

  it('A5-10: a pessoa pede o envio; a política manda esperar a aprovação com o código do app; só então o Liame dispara, uma vez, com a confirmação do plano aprovado', async () => {
    const c = rascunho(e);
    const confirmacao = planoDe(c).confirmacao;
    const p = await pedir(e, 'mensagem_disparar', c);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({
      tool: 'mensagem_disparar',
      action: 'mensagem.disparar',
      provider: 'regemcast',
      brand_id: e.brandId,
      resource_id: `mensagem:${c.id}`,
      risk_level: 'R3',
      // O dinheiro das mensagens não entra na Verba do mês (D-A5-12): nada é reservado.
      budget_impact: 'none',
      reserved_micros: 0,
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      policy: { allowed: true, mode: 'APPROVAL', violations: [] },
    });
    // A regra é da distribuição (versão 5): mensagem só sai com a aprovação de uma pessoa.
    expect(p.body.policy.versions[0]).toBe('plataforma@5');
    // O pedido leu o plano no RegemCast, e mais nada. Sem a aprovação, o executor nem olha para ele.
    expect(doToken(e)).toEqual(['campanha_disparo_planejar']);
    await ciclo(e);
    expect(doToken(e)).toEqual(['campanha_disparo_planejar']);
    expect(c.situacao).toBe('rascunho');

    // O código errado não aprova, e nada sai.
    const errado = await api.call('POST', `/v1/actions/${p.body.id}/approve`, { cookie: e.cookie, body: { plan_hash: p.body.plan_hash, code: '000000' } });
    expect(errado.status).not.toBe(200);
    await ciclo(e);
    expect(c.situacao).toBe('rascunho');

    expect((await aprovar(e, p.body)).body).toMatchObject({ status: 'aprovada' });
    await ciclo(e);
    const feita = await ver(e, p.body.id);
    expect(feita, JSON.stringify(feita)).toMatchObject({ status: 'executada', status_reason: null, execution: { status: 'executada', no_write: false } });
    expect(c.situacao).toBe('enviando');
    // Um disparo só, com a confirmação do plano que a pessoa aprovou e uma chave de idempotência.
    const disparos = chamadas.filter((x) => x.ferramenta === 'campanha_disparar');
    expect(disparos).toHaveLength(1);
    expect(disparos[0]!.argumentos).toMatchObject({ id: c.id, confirmacao });
    expect(String(disparos[0]!.argumentos.chaveIdempotencia)).toMatch(/^liame:disparo:[0-9a-f]{48}$/);
    // Rodar o executor de novo não dispara outra vez.
    await ciclo(e);
    expect(chamadas.filter((x) => x.ferramenta === 'campanha_disparar')).toHaveLength(1);
    // Nenhum telefone nem o token no que ficou guardado do pedido.
    const guardado = JSON.stringify(await ownerQuery(`select * from liame.action_request where id = $1`, [p.body.id]));
    expect(guardado).not.toContain(e.token);
    expect(guardado).not.toMatch(/\+55\d{10,11}/);
  });

  it('o plano mudou entre o pedido e a execução (o público cresceu): nada é enviado, e a pessoa pede de novo vendo os números novos', async () => {
    const c = rascunho(e);
    const p = await pedir(e, 'mensagem_disparar', c);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    // Entre o pedido e a aprovação, mais gente entrou no público: o plano (e a confirmação dele) não é mais o mesmo.
    Object.assign(c, { destinatarios: 430, naFila: 430, custo: 13_760 });
    const aprovada = await aprovar(e, p.body);
    if (aprovada.status === 200) {
      await ciclo(e);
      expect(await ver(e, p.body.id)).toMatchObject({ status: 'falhou', status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', execution: { status: 'estado_mudou' } });
    } else {
      // A aprovação já confere o estado: o pedido não chega a ser aprovado.
      expect([aprovada.status, aprovada.body.code], JSON.stringify(aprovada.body)).toEqual([409, 'estado-mudou']);
    }
    expect(c.situacao).toBe('rascunho');
    expect(chamadas.filter((x) => x.ferramenta === 'campanha_disparar')).toHaveLength(0);
    // O pedido novo já nasce com os números de agora.
    const novo = await executar(e, 'mensagem_disparar', c);
    expect(novo).toMatchObject({ status: 'executada' });
    expect(c.situacao).toBe('enviando');
  });

  it('A5-12: o que impede vira recusa já no pedido, com o motivo: o que o RegemCast diz, a conta sem teto de gasto e o envio que não cabe no teto do mês', async () => {
    const antes = Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n);
    // O modelo ainda em análise na Meta: a frase é a do RegemCast.
    const semModelo = rascunho(e, { impedimentos: ['O modelo desta campanha ainda não foi aprovado pela Meta.'] });
    const r1 = await pedir(e, 'mensagem_disparar', semModelo);
    expect([r1.status, r1.body.code, r1.body.detail], JSON.stringify(r1.body)).toEqual([422, 'plano-recusado', 'O modelo desta campanha ainda não foi aprovado pela Meta.']);

    // Não cabe no teto do mês: sobram R$ 172,64 de R$ 300,00, e o envio pode custar até R$ 200,00.
    const cara = rascunho(e, { destinatarios: 625, naFila: 625, custo: 20_000 });
    const r2 = await pedir(e, 'mensagem_disparar', cara);
    expect([r2.status, r2.body.code], JSON.stringify(r2.body)).toEqual([422, 'plano-recusado']);
    expect(String(r2.body.detail).replace(/ /g, ' ')).toBe(
      'Não cabe no teto de gasto de mensagens do mês: o envio pode custar até R$ 200,00, e sobram R$ 172,64 de R$ 300,00. Quem muda o teto é o dono da conta, no RegemCast; outra saída é um público menor.',
    );

    // A conta sem teto de gasto definido no RegemCast: ele não dispara, e o pedido nem nasce.
    const semTeto = await empresa({ teto: null });
    const r3 = await pedir(semTeto, 'mensagem_disparar', rascunho(semTeto));
    expect([r3.status, r3.body.code, r3.body.detail], JSON.stringify(r3.body)).toEqual([422, 'plano-recusado', 'A conta não tem teto de gasto de disparos definido.']);

    // Pausar o que nem saiu, e disparar o que já saiu.
    const r4 = await pedir(e, 'mensagem_pausar', rascunho(e));
    expect([r4.status, r4.body.detail], JSON.stringify(r4.body)).toEqual([422, 'Esta mensagem ainda não foi enviada: não há o que pausar.']);
    const r5 = await pedir(e, 'mensagem_disparar', rascunho(e, { situacao: 'enviando' }));
    expect([r5.status, r5.body.detail], JSON.stringify(r5.body)).toEqual([422, 'Esta mensagem já foi enviada ou cancelada: não dá para enviar de novo.']);

    expect(Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n)).toBe(antes);
    expect(chamadas.filter((x) => x.ferramenta !== 'campanha_disparo_planejar' && x.ferramenta !== 'integracao_situacao')).toHaveLength(0);
  });

  it('nem com a autonomia pedida pela empresa e o autopilot ligado o envio sai sem uma pessoa (D-A5-11)', async () => {
    const auto = await empresa();
    const politica = await api.call('POST', '/v1/policies', { cookie: auto.cookie, body: { document: { rules: [{ type: 'autonomy', action: 'mensagem.disparar', provider: 'regemcast', mode: 'AUTO' }] } } });
    expect(politica.status, JSON.stringify(politica.body)).toBe(201);
    await ligarFlag(auto, 'autopilot', true);
    const c = rascunho(auto);
    const p = await pedir(auto, 'mensagem_disparar', c);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ mode: 'APPROVAL', status: 'aguardando_aprovacao', status_reason: 'autonomia AUTO pedida, mas esta ação sempre espera a aprovação de uma pessoa' });
    await ciclo(auto);
    expect(c.situacao).toBe('rascunho');
    expect(chamadas.filter((x) => x.ferramenta === 'campanha_disparar')).toHaveLength(0);
  });

  it('a volta do envio é pausar o que ainda não saiu: é um pedido novo, que também espera a aprovação; e a pausa não tem volta pelo Liame', async () => {
    const c = rascunho(e);
    const enviada = await executar(e, 'mensagem_disparar', c);
    expect(enviada).toMatchObject({ status: 'executada' });
    // A fila anda enquanto a campanha sai: isso não é "alguém mexeu", e a volta continua valendo.
    Object.assign(c, { naFila: 232, enviadas: 180 });

    const volta = await desfazer(e, enviada.id);
    expect([volta.status, volta.body.tool, volta.body.action, volta.body.status, volta.body.undoes], JSON.stringify(volta.body)).toEqual([201, 'mensagem_pausar', 'mensagem.pausar', 'aguardando_aprovacao', enviada.id]);
    expect(c.situacao).toBe('enviando');
    expect((await aprovar(e, volta.body)).body.status).toBe('aprovada');
    await ciclo(e);
    expect(await ver(e, volta.body.id)).toMatchObject({ status: 'executada' });
    expect(c.situacao).toBe('pausada');
    const pausas = chamadas.filter((x) => x.ferramenta === 'campanha_pausar');
    expect(pausas).toHaveLength(1);
    expect(String(pausas[0]!.argumentos.chaveIdempotencia)).toMatch(/^liame:pausa:[0-9a-f]{48}$/);
    // Retomar é de uma pessoa, no RegemCast: a pausa não tem volta pelo Liame.
    const semVolta = await desfazer(e, volta.body.id);
    expect(semVolta.status, JSON.stringify(semVolta.body)).not.toBe(201);
    expect(c.situacao).toBe('pausada');
  });

  it('o RegemCast cai na hora do disparo: a ação espera e tenta de novo com a mesma chave, e o envio acontece uma vez', async () => {
    const c = rascunho(e);
    const p = await pedir(e, 'mensagem_disparar', c);
    expect((await aprovar(e, p.body)).body.status).toBe('aprovada');
    caidas.set('campanha_disparar', 1);
    await ciclo(e);
    // A falha é passageira: nada foi dado como feito, e a ação fica para depois.
    expect(c.situacao).toBe('rascunho');
    const adiada = await ver(e, p.body.id);
    expect(adiada.status, JSON.stringify(adiada)).not.toBe('executada');
    expect(adiada.status).not.toBe('falhou');
    // Na vez seguinte (a espera é adiantada no teste), a mesma chave.
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 minute' where id = $1`, [p.body.id]);
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada' });
    expect(c.situacao).toBe('enviando');
    const disparos = chamadas.filter((x) => x.ferramenta === 'campanha_disparar');
    expect(disparos).toHaveLength(2);
    expect(disparos[0]!.argumentos.chaveIdempotencia).toBe(disparos[1]!.argumentos.chaveIdempotencia);
  });

  it('sem a escrita de mensagens ligada para a empresa, o pedido é negado; a conexão sem a permissão de envio diz isso; e outra empresa não alcança a conta', async () => {
    const semEscrita = await empresa({ escrita: false });
    const c1 = rascunho(semEscrita);
    chamadas.length = 0;
    const r1 = await pedir(semEscrita, 'mensagem_disparar', c1);
    expect([r1.status, r1.body.code], JSON.stringify(r1.body)).toEqual([403, 'escrita-desligada']);
    expect(chamadas.filter((x) => x.ferramenta === 'campanha_disparar')).toHaveLength(0);
    expect(c1.situacao).toBe('rascunho');

    // A conexão que só lê: o RegemCast nem mostra a ferramenta do plano.
    const soLeitura = await empresa({ permissoes: ['conversas.anuncio.ler', 'conta.ler', 'campanhas.ler'] });
    const r2 = await pedir(soLeitura, 'mensagem_disparar', rascunho(soLeitura));
    expect([r2.status, r2.body.code], JSON.stringify(r2.body)).toEqual([409, 'sem-permissao-na-plataforma']);
    expect(String(r2.body.detail)).toContain('O RegemCast');

    // A conta de outra empresa, e a campanha de outra conta.
    const vizinha = await empresa();
    const daPrimeira = rascunho(e);
    const r3 = await pedir(vizinha, 'mensagem_disparar', daPrimeira, e.conta);
    expect(r3.status, JSON.stringify(r3.body)).toBe(404);
    const r4 = await pedir(vizinha, 'mensagem_disparar', daPrimeira);
    expect([r4.status, r4.body.code], JSON.stringify(r4.body)).toEqual([422, 'plataforma-recusou']);
    expect(daPrimeira.situacao).toBe('rascunho');
    // O recurso que não é uma mensagem do RegemCast.
    const r5 = await api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool: 'mensagem_disparar', provider: 'regemcast', account_id: e.conta, resource_id: 'mensagem:nao-e-um-id', params: {} } });
    expect(r5.status, JSON.stringify(r5.body)).toBe(404);
  });
});
