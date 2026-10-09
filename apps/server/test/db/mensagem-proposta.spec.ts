import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONNECTORS } from '../../src/actions/connectors.js';
import { regemcastMensagemConnector } from '../../src/actions/regemcast-mensagem.js';
import type { PedidoDeMensagemService, Proponente } from '../../src/mensageria/pedido-de-mensagem.service.js';
import type { TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y5 (parte 4): montar o pedido de mensagem a partir da proposta do funcionário de CRM e mensageria, contra um
// RegemCast falso que fala o MCP sem estado (os modelos, os públicos, a conta de quem recebe, o rascunho da campanha e
// o plano do disparo) e um Regem falso (a loja do cupom). Em produção o conector do RegemCast ainda NÃO está no
// registro: aqui ele é registrado só neste arquivo, ANTES de o app carregar. Por isso o app e os ajudantes entram por
// `import()` dentro do `beforeAll`.
CONNECTORS.regemcast = regemcastMensagemConnector;

const TODAS = ['conta.ler', 'campanhas.ler', 'publicos.ler', 'modelos.ler', 'orcamento.ler', 'campanhas.rascunhar', 'campanhas.disparar'];
const TOKEN_DA_LOJA = `rgm_it_${'m'.repeat(32)}`;
const TOKEN_SO_LEITURA = `rgm_it_${'n'.repeat(32)}`;
const LISTA = '0a000000-0000-4000-8000-000000000001';
const PUBLICO = 'pediram_30_dias';

type Campanha = { id: string; conta: string; nome: string; situacao: string; destinatarios: number; argumentos: Record<string, unknown> };
type Perfil = { contaId: string; permissoes: string[] };
type Chamada = { token: string; ferramenta: string; argumentos: Record<string, unknown> };
type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; secret: string; token: string; contaId: string; conta: string; loja: string; lojaSoLeitura: string };

describe.skipIf(!hasDb)('montar o pedido de mensagem a partir da proposta (A5 · Y5, parte 4; conector registrado só no teste)', () => {
  let api: TestApi;
  let database: Database;
  let regemcast: Server;
  let regem: Server;
  let e: Empresa;
  let servico: PedidoDeMensagemService;
  let ownerQuery: typeof import('../helpers/api.js').ownerQuery;
  let resetIpRateLimits: typeof import('../helpers/api.js').resetIpRateLimits;
  let ajuda: typeof import('../helpers/api.js');
  let registrar: typeof import('../../src/connections/distribuicao.js').registrarConexaoDaDistribuicao;
  let deps: Parameters<typeof import('../../src/connections/distribuicao.js').registrarConexaoDaDistribuicao>[0];
  let invalidarFlags: () => void;
  const anterior: Record<string, string | undefined> = {};

  // ---------------------------------------------------------------- o RegemCast falso
  const perfis = new Map<string, Perfil>();
  const campanhas = new Map<string, Campanha>();
  const chaves = new Map<string, { pedido: string; resposta: unknown }>();
  const chamadas: Chamada[] = [];
  /** O modelo aprovado, o que ainda está em análise e o que tem variável no título. */
  const MODELOS = [
    { id: 'm1', nome: 'combo_domingo_v2', idioma: 'pt_BR', categoria: 'marketing', situacao: 'aprovado', podeDisparar: true, qualidade: 'alta', variaveis: 2, cabecalho: null, corpo: 'Oi, {{1}}! Domingo tem combo família por R$ 89,90. Peça com o cupom {{2}} e ganhe 10% de desconto.', rodape: 'Responda SAIR para não receber mais.', botoes: ['Ver o cardápio'], alertas: [] },
    { id: 'm2', nome: 'volte_a_pedir_v1', idioma: 'pt_BR', categoria: 'marketing', situacao: 'em_analise', podeDisparar: false, qualidade: 'desconhecida', variaveis: 1, cabecalho: null, corpo: 'Sentimos a sua falta, {{1}}.', rodape: null, botoes: [], alertas: [] },
    { id: 'm3', nome: 'aviso_com_titulo', idioma: 'pt_BR', categoria: 'utilidade', situacao: 'aprovado', podeDisparar: true, qualidade: 'alta', variaveis: 0, cabecalho: 'Novidade na {{1}}', corpo: 'O cardápio mudou.', rodape: null, botoes: [], alertas: [] },
  ];
  const PUBLICOS = {
    listas: [{ id: LISTA, nome: 'Clientes de domingo', regra: null, pessoas: 450, usadaEm: null }],
    publicos: [{ id: PUBLICO, nome: 'Quem pediu nos últimos 30 dias', regra: 'Pediu pelo menos uma vez nos últimos 30 dias', pessoas: 450 }],
    perfis: [{ id: 'sumidos', nome: 'Sumidos', regra: 'Sem pedido há 60 a 90 dias', pessoas: 0 }],
  };
  /** Quantas pessoas de cada público podem receber agora, e quantas estão em descanso. */
  const estimativas: Record<string, { pessoas: number; emDescanso: number }> = { [LISTA]: { pessoas: 412, emDescanso: 38 }, [PUBLICO]: { pessoas: 412, emDescanso: 38 }, sumidos: { pessoas: 0, emDescanso: 0 } };
  const TETO = { teto: 30_000, gasto: 12_736 };
  const CENTAVOS_POR_MENSAGEM = 32;

  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const recusada = (texto: string) => ({ result: { content: [{ type: 'text', text: texto }], isError: true, resultType: 'complete' } });
  const custoDe = (pessoas: number) => ({ moeda: 'BRL', gastoCentavos: 0, aSairCentavos: pessoas * CENTAVOS_POR_MENSAGEM, linhas: [{ rotulo: 'Custo estimado na Meta', valor: `até ${pessoas * CENTAVOS_POR_MENSAGEM} centavos`, detalhe: `${pessoas} mensagens de marketing` }], avisos: [] });
  const paraFora = (c: Campanha) => ({
    id: c.id,
    nome: c.nome,
    situacao: c.situacao,
    pausaMotivo: null,
    modelo: String(c.argumentos.modeloNome),
    categoria: 'marketing',
    publico: 'Quem pediu nos últimos 30 dias',
    destinatarios: c.destinatarios,
    naFila: c.destinatarios,
    enviadas: 0,
    entregues: 0,
    lidas: 0,
    falhas: 0,
    responderam: 0,
    criadaEm: '2026-10-09T12:12:00.000Z',
    iniciadaEm: null,
    concluidaEm: null,
  });
  const idDoPublico = (p: Record<string, unknown>) => String(p.origemId ?? p.publico ?? p.segmento ?? '');

  function responder(credencial: string, corpo: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }): { status: number; corpo: unknown } {
    const perfil = perfis.get(credencial);
    if (!perfil) return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
    const nome = corpo.params?.name ?? '';
    const args = corpo.params?.arguments ?? {};
    chamadas.push({ token: credencial, ferramenta: nome, argumentos: args });
    const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
    const ok = (sc: unknown) => ({ status: 200, corpo: comId(resultado(sc)) });
    const semFerramenta = { status: 200, corpo: comId({ error: { code: -32602, message: `Tool ${nome} not found` } }) };
    if (nome === 'integracao_situacao') {
      return ok({ contaId: perfil.contaId, conta: 'Mister Burgers', fuso: 'America/Sao_Paulo', produto: 'liame', classe: 'dms', token: 'Liame — piloto', permissoes: perfil.permissoes.map((id) => ({ id, rotulo: id, descricao: '' })), limitePorMinuto: 60 });
    }
    if (nome === 'modelos_listar') return perfil.permissoes.includes('modelos.ler') ? ok({ modelos: MODELOS }) : semFerramenta;
    if (nome === 'publicos_listar') return perfil.permissoes.includes('publicos.ler') ? ok(PUBLICOS) : semFerramenta;
    if (nome === 'publico_estimar') {
      const e0 = estimativas[idDoPublico(args)] ?? { pessoas: 0, emDescanso: 0 };
      return ok({ ...e0, descansoDias: 7, custo: custoDe(e0.pessoas) });
    }
    if (nome === 'campanha_rascunhar') {
      if (!perfil.permissoes.includes('campanhas.rascunhar')) return semFerramenta;
      const { chaveIdempotencia, ...pedido } = args;
      const chave = `${perfil.contaId}:${String(chaveIdempotencia)}`;
      const guardada = chaves.get(chave);
      if (guardada) return guardada.pedido === JSON.stringify(pedido) ? { status: 200, corpo: comId(guardada.resposta as object) } : { status: 200, corpo: comId(recusada('Esta chave já foi usada com outro pedido. Use uma chave nova.')) };
      if (String(pedido.nome).includes('RECUSAR')) return { status: 200, corpo: comId(recusada('A variável {{2}} não aceita este valor.')) };
      const pessoas = (estimativas[idDoPublico(pedido.publico as Record<string, unknown>)] ?? { pessoas: 0 }).pessoas;
      const c: Campanha = { id: randomUUID(), conta: perfil.contaId, nome: String(pedido.nome), situacao: 'rascunho', destinatarios: pessoas, argumentos: pedido };
      campanhas.set(c.id, c);
      const resposta = resultado({ campanha: paraFora(c), custo: custoDe(pessoas), descansoDias: 7, proximoPasso: 'A campanha está em rascunho. Nada foi enviado.' });
      chaves.set(chave, { pedido: JSON.stringify(pedido), resposta });
      return { status: 200, corpo: comId(resposta) };
    }
    if (nome === 'campanha_disparo_planejar') {
      const c = campanhas.get(String(args.id));
      if (!c || c.conta !== perfil.contaId) return { status: 200, corpo: comId(recusada('Campanha não encontrada.')) };
      return ok({
        campanha: paraFora(c),
        custo: custoDe(c.destinatarios),
        orcamento: { definido: true, periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: TETO.teto, gastoCentavos: TETO.gasto, texto: `${TETO.gasto} de ${TETO.teto}`, sinal: 'ok' }], aviso: null },
        podeDisparar: true,
        impedimentos: [],
        confirmacao: createHash('sha256').update(JSON.stringify([c.id, c.situacao, c.destinatarios, TETO])).digest('hex').slice(0, 40),
      });
    }
    return semFerramenta;
  }

  // ---------------------------------------------------------------- o Regem falso: só a loja (o cupom nasce na execução)
  const lojas: Record<string, { loja_id: string; loja_nome: string; escopos: string[] }> = {
    [TOKEN_DA_LOJA]: { loja_id: `loja-msg-${randomUUID().slice(0, 8)}`, loja_nome: 'Mister Burgers — Centro', escopos: ['pedidos.ler', 'cupons.ler', 'cupons.uso.ler', 'cupons.criar'] },
    [TOKEN_SO_LEITURA]: { loja_id: `loja-msg-${randomUUID().slice(0, 8)}`, loja_nome: 'Mister Burgers — Praia', escopos: ['pedidos.ler', 'cupons.ler', 'cupons.uso.ler'] },
  };
  const chamadasAoRegem: string[] = [];

  // ---------------------------------------------------------------- ajudantes
  const quem = (emp: Empresa): Proponente => ({ tenantId: emp.tenantId, agentKey: 'crm', agentLabel: 'CRM e mensageria', emNomeDe: emp.userId });
  const proposta = (emp: Empresa, extra: Record<string, unknown> = {}) => ({
    marca: emp.brandId,
    conta: emp.conta,
    nome: `Combo família de domingo ${randomUUID().slice(0, 6)}`,
    modelo: { nome: 'combo_domingo_v2' },
    publico: { origem: 'publico', id: PUBLICO },
    variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'COMBO10' }],
    ...extra,
  });
  const cupom = (emp: Empresa, extra: Record<string, unknown> = {}) => ({ loja: emp.loja, codigo: 'COMBO10', tipo: 'percentual', percentual: 10, valido_de: '2026-10-10', valido_ate: '2026-10-12', ...extra });
  /** A recusa de `propor`, como [status, código, detalhe]. */
  async function recusa(emp: Empresa, entrada: unknown): Promise<[number, string, string]> {
    try {
      await servico.propor(quem(emp), entrada);
    } catch (err) {
      const p = err as { status?: number; code?: string; detail?: string; getStatus?: () => number };
      return [p.status ?? p.getStatus?.() ?? 0, String(p.code), String(p.detail)];
    }
    throw new Error('a proposta não foi recusada');
  }
  const doToken = (emp: Empresa) => chamadas.filter((c) => c.token === emp.token).map((c) => c.ferramenta);
  const linhas = async (emp: Empresa) => Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.message_request where tenant_id = $1`, [emp.tenantId]))[0]!.n);
  async function ligarFlag(emp: Empresa, flag: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [flag, emp.tenantId]);
    if (valor) await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, emp.tenantId]);
    invalidarFlags();
  }
  /** Uma empresa com a conta do RegemCast e duas lojas do Regem conectadas pelo caminho de verdade, e as duas flags ligadas. */
  async function empresa(opcoes: { permissoes?: string[]; comLojas?: boolean } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await ajuda.signupAndLogin(api, undefined, 'Hamburgueria da Proposta de Mensagem');
    const { secret } = await ajuda.enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const token = `rct_it_${randomBytes(33).toString('base64url').slice(0, 43)}`;
    const contaId = randomUUID();
    perfis.set(token, { contaId, permissoes: opcoes.permissoes ?? TODAS });
    const conexao = await registrar(deps, { tenantId, brandId, produto: 'regemcast', tokens: [token] });
    const ligada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: s.cookie, body: { accounts: [{ provider: 'regemcast', external_id: contaId }] } });
    expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
    let loja: string = randomUUID();
    let lojaSoLeitura: string = randomUUID();
    if (opcoes.comLojas) {
      const doRegem = await registrar(deps, { tenantId, brandId, produto: 'regem', tokens: [TOKEN_DA_LOJA, TOKEN_SO_LEITURA] });
      const lojasLigadas = await api.call('POST', `/v1/connections/${doRegem.connectionId}/accounts`, {
        cookie: s.cookie,
        body: { accounts: [{ provider: 'regem', external_id: lojas[TOKEN_DA_LOJA]!.loja_id }, { provider: 'regem', external_id: lojas[TOKEN_SO_LEITURA]!.loja_id }] },
      });
      expect(lojasLigadas.status, JSON.stringify(lojasLigadas.body)).toBe(200);
      const contas = await ownerQuery<{ id: string; external_id: string }>(`select id, external_id from liame.connected_account where tenant_id = $1 and provider = 'regem'`, [tenantId]);
      loja = contas.find((c) => c.external_id === lojas[TOKEN_DA_LOJA]!.loja_id)!.id;
      lojaSoLeitura = contas.find((c) => c.external_id === lojas[TOKEN_SO_LEITURA]!.loja_id)!.id;
    }
    const emp: Empresa = { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, secret, token, contaId, conta: ligada.body.linked[0].id as string, loja, lojaSoLeitura };
    await ligarFlag(emp, 'whatsapp_campaign', true);
    await ligarFlag(emp, 'mensageria', true);
    return emp;
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
          if (new URL(req.url ?? '/', 'http://x').pathname !== '/cast/mcp' || req.method !== 'POST') r = { status: 405, corpo: { mensagem: 'só POST' } };
          else if (req.headers['mcp-method'] !== corpo.method || req.headers['mcp-name'] !== (corpo.params?.name ?? '')) r = { status: 400, corpo: { jsonrpc: '2.0', id: corpo.id, error: { code: -32020, message: 'header mismatch' } } };
          else r = responder((req.headers.authorization ?? '').replace(/^Bearer /, ''), corpo);
        } catch {
          r = { status: 500, corpo: {} };
        }
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.status === 401 ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {}) });
        res.end(JSON.stringify(r.corpo));
      });
    });
    regem = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const caminho = new URL(req.url ?? '/', 'http://x').pathname;
        chamadasAoRegem.push(`${req.method} ${caminho}`);
        const loja = lojas[req.headers.authorization?.replace(/^Bearer /, '') ?? ''];
        const r = !loja ? { status: 401, corpo: { title: 'Token inválido', status: 401 } } : caminho === '/regem/loja' ? { status: 200, corpo: { ...loja, empresa_nome: 'Mister Burgers', fuso: 'America/Sao_Paulo', moeda: 'BRL' } } : { status: 404, corpo: { title: 'Não encontrado', status: 404 } };
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => regemcast.listen(0, '127.0.0.1', ok));
    await new Promise<void>((ok) => regem.listen(0, '127.0.0.1', ok));
    anterior.REGEMCAST_API_URL = process.env.REGEMCAST_API_URL;
    anterior.REGEM_API_URL = process.env.REGEM_API_URL;
    process.env.REGEMCAST_API_URL = `http://127.0.0.1:${(regemcast.address() as AddressInfo).port}/cast`;
    process.env.REGEM_API_URL = `http://127.0.0.1:${(regem.address() as AddressInfo).port}/regem`;

    ajuda = await import('../helpers/api.js');
    ({ ownerQuery, resetIpRateLimits } = ajuda);
    api = await ajuda.startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    const [{ FlagService }, distribuicao, { VaultService }, { loadConfig }, { PedidoDeMensagemService: Servico }] = await Promise.all([
      import('../../src/flags/flag.service.js'),
      import('../../src/connections/distribuicao.js'),
      import('../../src/vault/vault.service.js'),
      import('../../src/config.js'),
      import('../../src/mensageria/pedido-de-mensagem.service.js'),
    ]);
    const flags = api.app.get(FlagService);
    invalidarFlags = () => flags.invalidate();
    servico = api.app.get(Servico);
    registrar = distribuicao.registrarConexaoDaDistribuicao;
    deps = { db: database.db, vault: api.app.get(VaultService), config: loadConfig() };
    e = await empresa({ comLojas: true });
  }, 120_000);
  beforeEach(async () => {
    chamadas.length = 0;
    chamadasAoRegem.length = 0;
    await resetIpRateLimits();
  });
  afterAll(async () => {
    delete CONNECTORS.regemcast;
    for (const [nome, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
    await api?.close();
    await database?.close();
    await new Promise((ok) => regemcast?.close(ok));
    await new Promise((ok) => regem?.close(ok));
  });

  it('a proposta vira o rascunho no RegemCast (janela das 9h às 20h), o retrato do pedido e o pedido de envio, que espera a aprovação', async () => {
    const p = proposta(e, { cupom: cupom(e) });
    const feito = await servico.propor(quem(e), p);
    // No RegemCast: leu os modelos e os públicos, estimou quem recebe, rascunhou, e o trilho leu o plano. Nada foi disparado.
    expect(doToken(e).sort()).toEqual(['campanha_disparo_planejar', 'campanha_rascunhar', 'modelos_listar', 'publico_estimar', 'publicos_listar']);
    const rascunhada = chamadas.find((c) => c.ferramenta === 'campanha_rascunhar')!.argumentos;
    expect(rascunhada).toMatchObject({
      nome: p.nome,
      modeloNome: 'combo_domingo_v2',
      modeloIdioma: 'pt_BR',
      publico: { origem: 'publico', publico: PUBLICO },
      variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'COMBO10' }],
      // Sem janela na proposta: todos os dias, o horário inteiro que o Liame aceita.
      janelaDias: [0, 1, 2, 3, 4, 5, 6],
      janelaInicio: '09:00',
      janelaFim: '20:00',
    });
    expect(String(rascunhada.chaveIdempotencia)).toMatch(/^liame:rascunho:[0-9a-f]{48}$/);
    expect(campanhas.get(feito.campaign_id)).toMatchObject({ situacao: 'rascunho', destinatarios: 412 });

    // O retrato: o texto como a Meta o aprovou, o público com a conta de quem recebe, a janela e o cupom (ainda não criado).
    const [linha] = await ownerQuery<Record<string, unknown>>(`select * from liame.message_request where id = $1`, [feito.id]);
    expect(linha).toMatchObject({
      tenant_id: e.tenantId,
      brand_id: e.brandId,
      connected_account_id: e.conta,
      campaign_id: feito.campaign_id,
      action_request_id: feito.action_id,
      name: p.nome,
      template_name: 'combo_domingo_v2',
      template_language: 'pt_BR',
      template_category: 'marketing',
      template_header: null,
      template_body: MODELOS[0]!.corpo,
      template_footer: 'Responda SAIR para não receber mais.',
      template_buttons: ['Ver o cardápio'],
      variables: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'COMBO10' }],
      audience: { origem: 'publico', id: PUBLICO },
      audience_name: 'Quem pediu nos últimos 30 dias',
      audience_rule: 'Pediu pelo menos uma vez nos últimos 30 dias',
      people_can_receive: 412,
      people_resting: 38,
      rest_days: 7,
      window_days: [0, 1, 2, 3, 4, 5, 6],
      window_start: '09:00',
      window_end: '20:00',
      coupon_account_id: e.loja,
      coupon_code: 'COMBO10',
      coupon_rule: { codigo: 'COMBO10', tipo: 'percentual', percentual: '10.00', valido_de: '2026-10-10', valido_ate: '2026-10-12' },
      coupon_id: null,
      actor_type: 'agent',
      agent_key: 'crm',
      requested_by: e.userId,
    });
    // O cupom só nasce com o envio: nada foi criado no Regem.
    expect(chamadasAoRegem.filter((c) => c.startsWith('POST'))).toEqual([]);

    // O pedido de envio: do funcionário, em nome da pessoa, esperando a aprovação com o código do app, sem impedimento.
    const acao = (await api.call('GET', `/v1/actions/${feito.action_id}`, { cookie: e.cookie })).body;
    expect(acao, JSON.stringify(acao)).toMatchObject({
      tool: 'mensagem_disparar',
      provider: 'regemcast',
      account_id: e.conta,
      resource_id: `mensagem:${feito.campaign_id}`,
      risk_level: 'R3',
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      blocked_reason: null,
      agent_key: 'crm',
      requested_by: { id: e.userId },
    });
    // A trilha: a proposta e o pedido, em nome do funcionário, sem o texto da mensagem.
    const trilha = await ownerQuery<{ action: string; actor_type: string; actor_label: string; after: Record<string, unknown> }>(
      `select action, actor_type, actor_label, "after" from liame.audit_event where chain_key = $1 and resource_id in ($2, $3) order by chain_seq`,
      [e.tenantId, feito.id, feito.action_id],
    );
    expect(trilha.map((t) => [t.action, t.actor_type, t.actor_label])).toEqual([
      ['acao.pedir', 'agent', 'CRM e mensageria'],
      ['mensagem.propor', 'agent', 'CRM e mensageria'],
    ]);
    expect(trilha[1]!.after).toMatchObject({ action_request_id: feito.action_id, campaign_id: feito.campaign_id, template: 'combo_domingo_v2', people_can_receive: 412, people_resting: 38, window: '09:00-20:00', coupon_code: 'COMBO10', on_behalf_of: e.userId });
    expect(JSON.stringify(trilha)).not.toContain('Domingo tem combo');
    // Nenhum telefone e nenhum token no que ficou guardado.
    const guardado = JSON.stringify(linha);
    expect(guardado).not.toContain(e.token);
    expect(guardado).not.toMatch(/\+55\d{10,11}/);
  });

  it('a janela da proposta estreita o horário, e nunca alarga (D-A5-13); o que foge do formato nem chega ao RegemCast', async () => {
    const estreita = await servico.propor(quem(e), proposta(e, { janela: { dias: [6, 0, 6], inicio: '11:00', fim: '14:30' } }));
    expect(chamadas.find((c) => c.ferramenta === 'campanha_rascunhar')!.argumentos).toMatchObject({ janelaDias: [0, 6], janelaInicio: '11:00', janelaFim: '14:30' });
    expect((await ownerQuery<Record<string, unknown>>(`select window_days, window_start, window_end, coupon_code from liame.message_request where id = $1`, [estreita.id]))[0]).toEqual({ window_days: [0, 6], window_start: '11:00', window_end: '14:30', coupon_code: null });

    chamadas.length = 0;
    const antes = await linhas(e);
    expect(await recusa(e, proposta(e, { janela: { inicio: '08:00' } }))).toEqual([422, 'proposta-recusada', 'O envio de mensagem só acontece entre 9h e 20h, no horário da loja.']);
    expect(await recusa(e, proposta(e, { janela: { fim: '21:30' } }))).toEqual([422, 'proposta-recusada', 'O envio de mensagem só acontece entre 9h e 20h, no horário da loja.']);
    expect(await recusa(e, proposta(e, { janela: { inicio: '15:00', fim: '12:00' } }))).toEqual([422, 'proposta-recusada', 'A janela de envio termina antes de começar.']);
    expect((await recusa(e, proposta(e, { telefone: '+5521999990001' })))[1]).toBe('proposta-recusada');
    expect((await recusa(e, proposta(e, { publico: { origem: 'base', id: 'toda' } })))[2]).toContain('fora do formato');
    // Nenhuma campanha foi rascunhada, e nenhuma linha nasceu.
    expect(chamadas.filter((c) => c.ferramenta === 'campanha_rascunhar')).toEqual([]);
    expect(await linhas(e)).toBe(antes);
  });

  it('o modelo precisa estar aprovado pela Meta e ter cada variável com valor; o texto não leva telefone; o cupom precisa ser citado', async () => {
    const antes = await linhas(e);
    expect(await recusa(e, proposta(e, { modelo: { nome: 'nao_existe' } }))).toEqual([422, 'proposta-recusada', 'O modelo "nao_existe" não existe nesta conta do RegemCast.']);
    expect(await recusa(e, proposta(e, { modelo: { nome: 'volte_a_pedir_v1' }, variaveis: [{ origem: 'primeiro_nome' }] }))).toEqual([
      422,
      'proposta-recusada',
      'O modelo "volte_a_pedir_v1" ainda não foi aprovado pela Meta: só modelo aprovado pode ser enviado.',
    ]);
    expect((await recusa(e, proposta(e, { variaveis: [{ origem: 'primeiro_nome' }] })))[2]).toBe('O modelo "combo_domingo_v2" espera 2 variáveis no texto, e a proposta traz 1.');
    expect((await recusa(e, proposta(e, { variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'ligue (21) 99999-0001' }] })))[2]).toBe('O texto da mensagem não pode levar número de telefone.');
    expect((await recusa(e, proposta(e, { modelo: { nome: 'aviso_com_titulo' }, variaveis: [] })))[2]).toBe('O título do modelo "aviso_com_titulo" tem uma variável, e a proposta não diz o valor dela.');
    expect((await recusa(e, proposta(e, { variavel_do_titulo: { origem: 'fixo', valor: 'Centro' } })))[2]).toBe('O título do modelo "combo_domingo_v2" não tem variável.');
    // O cupom que a mensagem não cita: quem recebe não teria como usar.
    expect((await recusa(e, proposta(e, { cupom: cupom(e, { codigo: 'OUTRO15' }) })))[2]).toBe('A mensagem não diz o código do cupom (OUTRO15): sem ele, quem recebe não tem como usar, e o resultado não é medido.');
    expect(chamadas.filter((c) => c.ferramenta === 'campanha_rascunhar')).toEqual([]);
    expect(await linhas(e)).toBe(antes);
  });

  it('o público é um que existe no RegemCast e tem a quem enviar; a loja do cupom é da marca, liberou criar cupom e não tem o código', async () => {
    const antes = await linhas(e);
    expect((await recusa(e, proposta(e, { publico: { origem: 'lista', id: randomUUID() } })))[2]).toBe('O público da proposta não existe mais nesta conta do RegemCast.');
    expect((await recusa(e, proposta(e, { publico: { origem: 'perfil', id: 'sumidos' } })))[2]).toBe('Ninguém deste público pode receber esta mensagem agora.');
    // A loja que não é da empresa, a que só deixa ler, e o código que a loja já tem.
    expect((await recusa(e, proposta(e, { cupom: cupom(e, { loja: randomUUID() }) })))[2]).toBe('A loja do cupom não é uma loja do Regem conectada a esta marca.');
    expect((await recusa(e, proposta(e, { cupom: cupom(e, { loja: e.lojaSoLeitura }) })))[2]).toBe('A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.');
    await ownerQuery(
      `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, percent, active, source_version, source_updated_at)
       values (gen_random_uuid(), $1, $2, $3, $4, 'JATEM10', 'percentual', 10, true, 1, now())`,
      [e.tenantId, e.brandId, e.loja, `cp-${randomUUID().slice(0, 8)}`],
    );
    expect((await recusa(e, proposta(e, { variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'JATEM10' }], cupom: cupom(e, { codigo: 'JATEM10' }) })))[2]).toBe('Já existe um cupom com o código JATEM10 nesta loja. Proponha outro código.');
    expect(chamadas.filter((c) => c.ferramenta === 'campanha_rascunhar')).toEqual([]);
    expect(await linhas(e)).toBe(antes);

    // A lista também serve de público, com o id dela.
    const daLista = await servico.propor(quem(e), proposta(e, { publico: { origem: 'lista', id: LISTA } }));
    expect(chamadas.find((c) => c.ferramenta === 'campanha_rascunhar')!.argumentos.publico).toEqual({ origem: 'lista', origemId: LISTA });
    expect((await ownerQuery<{ audience_name: string; audience_rule: string | null }>(`select audience_name, audience_rule from liame.message_request where id = $1`, [daLista.id]))[0]).toEqual({ audience_name: 'Clientes de domingo', audience_rule: null });
  });

  it('o mesmo cupom não entra em duas mensagens da mesma loja, e a mesma proposta de novo não monta outro pedido', async () => {
    const primeira = proposta(e, { variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'DOMINGO10' }], cupom: cupom(e, { codigo: 'DOMINGO10' }) });
    const feito = await servico.propor(quem(e), primeira);
    const antes = await linhas(e);
    // Outra mensagem com o mesmo código: recusada (o rascunho dela fica no RegemCast, sem pedido no Liame).
    expect((await recusa(e, proposta(e, { variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'DOMINGO10' }], cupom: cupom(e, { codigo: 'DOMINGO10' }) })))[2]).toBe('O cupom DOMINGO10 já é de outra mensagem desta loja. Proponha outro código.');
    // A mesma proposta de novo: o RegemCast devolve a mesma campanha (a chave sai da proposta), e ela já tem pedido.
    expect(await recusa(e, primeira)).toEqual([409, 'pedido-ja-montado', 'Já existe um pedido de envio para esta campanha em rascunho.']);
    expect(await linhas(e)).toBe(antes);
    expect([...campanhas.values()].filter((c) => c.nome === primeira.nome)).toHaveLength(1);
    expect((await api.call('GET', `/v1/actions/${feito.action_id}`, { cookie: e.cookie })).body.status).toBe('aguardando_aprovacao');
  });

  it('com a função ou o envio desligados, nada é lido nem montado; a recusa do RegemCast vira o motivo; sem permissão, a proposta diz onde resolve', async () => {
    const semFuncao = await empresa();
    await ligarFlag(semFuncao, 'mensageria', false);
    expect((await recusa(semFuncao, proposta(semFuncao))).slice(0, 2)).toEqual([409, 'mensageria-desligada']);
    await ligarFlag(semFuncao, 'mensageria', true);
    await ligarFlag(semFuncao, 'whatsapp_campaign', false);
    expect((await recusa(semFuncao, proposta(semFuncao))).slice(0, 2)).toEqual([409, 'envio-desligado']);
    // Do RegemCast, só a conferência de quando a conta foi conectada: nenhuma leitura da proposta.
    expect(doToken(semFuncao).filter((f) => f !== 'integracao_situacao')).toEqual([]);

    // A conta de outra empresa não é alcançada.
    expect((await recusa(e, proposta(e, { conta: semFuncao.conta }))).slice(0, 2)).toEqual([404, 'nao-encontrado']);
    expect((await recusa(e, proposta(e, { marca: semFuncao.brandId }))).slice(0, 2)).toEqual([404, 'nao-encontrado']);

    // O RegemCast recusa o rascunho: a frase dele vira o motivo, e nada nasce no Liame.
    const antes = await linhas(e);
    expect(await recusa(e, proposta(e, { nome: 'RECUSAR esta campanha' }))).toEqual([422, 'proposta-recusada', 'O RegemCast não aceitou montar esta mensagem: A variável {{2}} não aceita este valor.']);
    expect(await linhas(e)).toBe(antes);

    // A conexão sem a permissão de rascunhar campanha.
    const semRascunho = await empresa({ permissoes: TODAS.filter((x) => x !== 'campanhas.rascunhar') });
    const r = await recusa(semRascunho, proposta(semRascunho));
    expect(r, r[2]).toEqual([409, 'regemcast-sem-permissao', 'A conexão com o RegemCast não inclui montar campanhas de mensagens. Quem dá a permissão é o dono da conta, no RegemCast.']);
    expect(await linhas(semRascunho)).toBe(0);
  });
});
