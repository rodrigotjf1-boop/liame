import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { MessagingCampaignDetailResponse, MessagingResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { FLAG_MENSAGERIA } from '../../src/mensageria/mensageria.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y4 pelas rotas (o que a tela do protótipo P15 vai ler), contra um RegemCast falso que fala o MCP 2026-07-28 sem
// estado. `GET /v1/messaging` lê, de cada conta do RegemCast da marca, a situação do WhatsApp, o teto de gasto, o que há
// pronto (modelos e públicos, só contagens) e as campanhas; `GET /v1/messaging/campaigns/:id` lê uma campanha de perto.
// As duas só leem, na hora, e não guardam nada; atrás da flag `mensageria`, que nasce desligada.

const CAMPANHA = '0199f1aa-1111-7222-8333-444455556666';
const TODAS = ['conversas.anuncio.ler', 'conta.ler', 'campanhas.ler', 'publicos.ler', 'modelos.ler', 'orcamento.ler'];
const ESCOPO_DA_FERRAMENTA: Record<string, string> = {
  conta_situacao: 'conta.ler',
  campanhas_listar: 'campanhas.ler',
  campanha_detalhar: 'campanhas.ler',
  publicos_listar: 'publicos.ler',
  modelos_listar: 'modelos.ler',
  orcamento_ler: 'orcamento.ler',
};

const CAMPANHA_FEITA = {
  id: CAMPANHA,
  nome: 'Sexta em dobro',
  situacao: 'concluida',
  pausaMotivo: null,
  modelo: 'promo_sexta_v2',
  categoria: 'marketing',
  publico: 'Quem pediu nos últimos 30 dias',
  destinatarios: 412,
  naFila: 0,
  enviadas: 405,
  entregues: 398,
  lidas: 301,
  falhas: 7,
  responderam: 22,
  criadaEm: '2026-10-02T11:00:00.000-03:00',
  iniciadaEm: '2026-10-02T21:00:00.000Z',
  concluidaEm: '2026-10-02T21:19:00.000Z',
};
const MODELO = {
  id: 'm1',
  nome: 'promo_sexta_v2',
  idioma: 'pt_BR',
  categoria: 'marketing',
  situacao: 'aprovado',
  podeDisparar: true,
  qualidade: 'alta',
  variaveis: 1,
  cabecalho: null,
  corpo: 'Oi, {{1}}! Sexta tem smash em dobro. Peça pelo cardápio.',
  rodape: 'Responda SAIR para não receber mais.',
  botoes: ['Ver o cardápio'],
  alertas: [],
};
const RESPOSTAS: Record<string, unknown> = {
  conta_situacao: {
    conta: 'Mister Burgers',
    fuso: 'America/Sao_Paulo',
    whatsapp: { conectado: true, sinal: 'pode_enviar', titulo: 'Tudo certo para enviar', resumo: 'A conta do WhatsApp está saudável na Meta.', lidaEm: '2026-10-08T12:00:00.000Z', problemas: [] },
    plano: { nome: 'Essencial', assinatura: 'ativa', gratisPeloRegem: true, disparosNoCiclo: 412, tetoDoCiclo: 5000, restantes: 4588, cicloFim: '2026-10-31' },
  },
  campanhas_listar: { campanhas: [CAMPANHA_FEITA], total: 1 },
  campanha_detalhar: {
    campanha: CAMPANHA_FEITA,
    pausa: null,
    espera: null,
    falhasPorMotivo: [{ mensagens: 7, titulo: 'Número sem WhatsApp', explicacao: 'O número não tem conta no WhatsApp.', acao: 'Confira o número no cadastro.' }],
    custo: { moeda: 'BRL', gastoCentavos: 12_736, aSairCentavos: 0, linhas: [{ rotulo: 'Gasto na Meta', valor: 'R$ 127,36', detalhe: '398 mensagens entregues' }], avisos: [] },
    descansoDias: 7,
  },
  publicos_listar: {
    listas: [{ id: 'l1', nome: 'Clientes do salão', regra: null, pessoas: 180, usadaEm: '2026-09-20T15:00:00.000Z' }],
    publicos: [{ id: 'recentes_30', nome: 'Quem pediu nos últimos 30 dias', regra: 'Pedido confirmado nos últimos 30 dias', pessoas: 450 }],
    perfis: [{ id: 'fieis', nome: 'Fiéis', regra: '3 pedidos ou mais em 60 dias', pessoas: 96 }],
  },
  modelos_listar: { modelos: [MODELO, { ...MODELO, id: 'm2', nome: 'combo_domingo_v1', situacao: 'em_analise', podeDisparar: false }] },
  orcamento_ler: {
    moeda: 'BRL',
    tetos: { dia: null, semana: null, mes: 30_000 },
    periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 12_736, percentual: 42.45, texto: 'R$ 127,36 de R$ 300,00 neste mês', sinal: 'ok' }],
    avisos: [],
  },
};

type Perfil = { contaId: string; conta: string; permissoes: string[] };
type Chamada = { token: string; ferramenta: string; argumentos: Record<string, unknown> };
type Empresa = { cookie: string; tenantId: string; brandId: string; token: string; contaId: string; conta: string };

describe.skipIf(!hasDb)('mensageria pelas rotas: o que a tela Mensagens lê do RegemCast (A5, Y4)', () => {
  let api: TestApi;
  let database: Database;
  let regemcast: Server;
  let base = '';
  let flags: FlagService;
  const anterior: Record<string, string | undefined> = {};
  /** De quem é cada token, com as permissões dele. */
  const perfis = new Map<string, Perfil>();
  /** O que o RegemCast falso devolve no lugar da resposta normal: `conta:ferramenta` → conteúdo. */
  const trocas = new Map<string, unknown>();
  /** A ferramenta de uma conta fora do ar: `conta:ferramenta` → status HTTP. */
  const foraDoAr = new Map<string, number>();
  const revogados = new Set<string>();
  const chamadas: Chamada[] = [];

  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const recusada = (texto: string) => ({ result: { content: [{ type: 'text', text: texto }], isError: true, resultType: 'complete' } });

  function responder(credencial: string, corpo: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }): { status: number; corpo: unknown } {
    const perfil = perfis.get(credencial);
    if (!perfil || revogados.has(credencial)) return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
    const nome = corpo.params?.name ?? '';
    const args = corpo.params?.arguments ?? {};
    chamadas.push({ token: credencial, ferramenta: nome, argumentos: args });
    const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
    if (nome === 'integracao_situacao') {
      return {
        status: 200,
        corpo: comId(
          resultado({
            contaId: perfil.contaId,
            conta: perfil.conta,
            fuso: 'America/Sao_Paulo',
            produto: 'liame',
            classe: 'dms',
            token: 'Liame — piloto',
            permissoes: perfil.permissoes.map((id) => ({ id, rotulo: id, descricao: '' })),
            limitePorMinuto: 60,
          }),
        ),
      };
    }
    // O RegemCast nem lista a ferramenta que o token não pode usar: a chamada direta responde "não encontrada".
    const escopo = ESCOPO_DA_FERRAMENTA[nome];
    if (!escopo || !perfil.permissoes.includes(escopo)) return { status: 200, corpo: comId({ error: { code: -32602, message: `Tool ${nome} not found` } }) };
    const chave = `${perfil.contaId}:${nome}`;
    const caiu = foraDoAr.get(chave);
    if (caiu) return { status: caiu, corpo: { mensagem: 'fora do ar' } };
    if (nome === 'campanha_detalhar' && args.id !== CAMPANHA) return { status: 200, corpo: comId(recusada('Campanha não encontrada nesta conta.')) };
    return { status: 200, corpo: comId(resultado(trocas.has(chave) ? trocas.get(chave) : RESPOSTAS[nome])) };
  }

  async function ligar(tenantId: string): Promise<void> {
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [FLAG_MENSAGERIA, tenantId]);
    flags.invalidate();
  }

  /** Uma empresa com uma conta do RegemCast conectada pelo caminho de verdade (a distribuição confere o token e o cofre o guarda). */
  async function empresa(opcoes: { flag?: boolean; permissoes?: string[]; conectar?: boolean } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria das Mensagens');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const token = `rct_it_${randomBytes(33).toString('base64url').slice(0, 43)}`;
    const contaId = randomUUID();
    perfis.set(token, { contaId, conta: 'Mister Burgers', permissoes: opcoes.permissoes ?? TODAS });
    let conta = '';
    if (opcoes.conectar !== false) {
      const conexao = await registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: loadConfig() }, { tenantId, brandId, produto: 'regemcast', tokens: [token] });
      const ligada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: s.cookie, body: { accounts: [{ provider: 'regemcast', external_id: contaId }] } });
      expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
      conta = ligada.body.linked[0].id as string;
    }
    if (opcoes.flag !== false) await ligar(tenantId);
    chamadas.length = 0;
    return { cookie: s.cookie, tenantId, brandId, token, contaId, conta };
  }

  async function membro(e: Empresa, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role } })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    return { cookie: s.cookie };
  }

  const ver = (e: Empresa, cookie = e.cookie, brandId = e.brandId) => api.call('GET', `/v1/messaging?brand_id=${brandId}`, { cookie });
  const detalhar = (e: Empresa, id = CAMPANHA, conta = e.conta, cookie = e.cookie) => api.call('GET', `/v1/messaging/campaigns/${id}?connected_account_id=${conta}`, { cookie });
  const lida = async (e: Empresa): Promise<MessagingResponse> => {
    const r = await ver(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return MessagingResponse.parse(r.body);
  };
  const ferramentasChamadas = (e: Empresa) =>
    chamadas
      .filter((c) => c.token === e.token)
      .map((c) => c.ferramenta)
      .sort();

  beforeAll(async () => {
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
          // Como o servidor de verdade (especificação 2026-07-28): o cabeçalho tem de bater com o corpo.
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
    api = await startApi();
    flags = api.app.get(FlagService);
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
  }, 120_000);
  beforeEach(() => {
    chamadas.length = 0;
    trocas.clear();
    foraDoAr.clear();
  });
  afterAll(async () => {
    if (anterior.REGEMCAST_API_URL === undefined) delete process.env.REGEMCAST_API_URL;
    else process.env.REGEMCAST_API_URL = anterior.REGEMCAST_API_URL;
    await api?.close();
    await database?.close();
    await new Promise((ok) => regemcast?.close(ok));
  });

  it('com a função desligada para a empresa, nada é lido do RegemCast', async () => {
    const e = await empresa({ flag: false });
    const r = await ver(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const corpo = MessagingResponse.parse(r.body);
    expect(corpo).toMatchObject({ brand_id: e.brandId, enabled: false, accounts: [] });
    const d = await detalhar(e);
    expect(d.status).toBe(409);
    expect(d.body.type).toContain('mensageria-desligada');
    expect(ferramentasChamadas(e)).toEqual([]);
  });

  it('ligada: a conta, o teto de gasto, o que há pronto e as campanhas, lidos agora e só com números', async () => {
    const e = await empresa();
    const corpo = await lida(e);
    expect(corpo.enabled).toBe(true);
    expect(corpo.accounts).toHaveLength(1);
    const [a] = corpo.accounts;
    expect(a).toMatchObject({ connected_account_id: e.conta, name: 'Mister Burgers', status: 'ok' });
    expect(a!.whatsapp).toEqual({ status: 'ok', connected: true, signal: 'pode_enviar', title: 'Tudo certo para enviar', summary: 'A conta do WhatsApp está saudável na Meta.', checked_at: '2026-10-08T12:00:00.000Z', problems: [] });
    expect(a!.budget).toEqual({ status: 'ok', currency: 'BRL', periods: [{ period: 'mes', label: 'Outubro', limit_cents: 30_000, spent_cents: 12_736, percent: 42.45, signal: 'ok' }], notices: [] });
    // Dois modelos, um só aprovado; três grupos de contatos, e o maior tem 450 pessoas que podem receber.
    expect(a!.ready).toEqual({ templates_status: 'ok', approved_templates: 1, templates: 2, audiences_status: 'ok', audiences: 3, largest_audience: 450 });
    expect(a!.campaigns.status).toBe('ok');
    expect(a!.campaigns.total).toBe(1);
    expect(a!.campaigns.items).toEqual([
      {
        id: CAMPANHA,
        name: 'Sexta em dobro',
        status: 'concluida',
        pause_reason: null,
        template: 'promo_sexta_v2',
        category: 'marketing',
        audience: 'Quem pediu nos últimos 30 dias',
        recipients: 412,
        queued: 0,
        sent: 405,
        delivered: 398,
        read: 301,
        failed: 7,
        replied: 22,
        // O instante com fuso do RegemCast sai em UTC.
        created_at: '2026-10-02T14:00:00.000Z',
        started_at: '2026-10-02T21:00:00.000Z',
        finished_at: '2026-10-02T21:19:00.000Z',
        // A campanha que o Liame não montou não tem cupom dele.
        coupon: null,
      },
    ]);
    // As cinco leituras, uma vez cada, com o token da conta; nenhuma ferramenta que escreve.
    expect(ferramentasChamadas(e)).toEqual(['campanhas_listar', 'conta_situacao', 'modelos_listar', 'orcamento_ler', 'publicos_listar']);
    expect(chamadas.find((c) => c.ferramenta === 'campanhas_listar')?.argumentos).toEqual({ limite: 20 });
    // O token não aparece na resposta, e o texto do modelo (conteúdo da loja) não é devolvido: só a contagem.
    const texto = JSON.stringify(corpo);
    expect(texto).not.toContain(e.token);
    expect(texto).not.toContain('rct_it_');
    expect(texto).not.toContain('Sexta tem smash em dobro');
    // Nada do que foi lido fica guardado: a leitura não cria estado de sincronização para a conta.
    const guardado = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.sync_state where connected_account_id = $1 and dataset <> 'conversas_anuncio'`, [e.conta]);
    expect(guardado[0]!.n).toBe('0');
  });

  it('o que o RegemCast mandar a mais não passa: nenhum telefone e nenhum nome de contato na resposta (A5-9)', async () => {
    const e = await empresa();
    trocas.set(`${e.contaId}:campanhas_listar`, { campanhas: [{ ...CAMPANHA_FEITA, destinatariosLista: [{ nome: 'Fulana de Tal', telefone: '+5521988887777' }] }], total: 1, contatos: ['+5521977776666'] });
    trocas.set(`${e.contaId}:publicos_listar`, {
      listas: [{ id: 'l1', nome: 'Clientes do salão', regra: null, pessoas: 180, usadaEm: null, telefones: ['+5521966665555'] }],
      publicos: [],
      perfis: [],
    });
    trocas.set(`${e.contaId}:campanha_detalhar`, { ...(RESPOSTAS.campanha_detalhar as object), quemRecebeu: [{ nome: 'Beltrano', telefone: '+5521955554444' }] });
    const corpo = await lida(e);
    expect(corpo.accounts[0]!.campaigns.items).toHaveLength(1);
    expect(corpo.accounts[0]!.ready).toMatchObject({ audiences: 1, largest_audience: 180 });
    const d = await detalhar(e);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    MessagingCampaignDetailResponse.parse(d.body);
    for (const texto of [JSON.stringify(corpo), JSON.stringify(d.body)]) {
      expect(texto).not.toMatch(/\+55\d{10,11}/);
      expect(texto).not.toContain('Fulana');
      expect(texto).not.toContain('Beltrano');
    }
  });

  it('cada parte diz como foi a leitura dela: sem a permissão, fora do ar ou fora do contrato, as outras seguem', async () => {
    // A conexão sem a leitura do orçamento e dos modelos; os públicos fora do ar; as campanhas fora do contrato.
    const e = await empresa({ permissoes: ['conversas.anuncio.ler', 'conta.ler', 'campanhas.ler', 'publicos.ler'] });
    foraDoAr.set(`${e.contaId}:publicos_listar`, 503);
    trocas.set(`${e.contaId}:campanhas_listar`, { campanhas: 'não é uma lista', total: 1 });
    const corpo = await lida(e);
    const [a] = corpo.accounts;
    expect(a!.status).toBe('ok');
    expect(a!.whatsapp).toMatchObject({ status: 'ok', signal: 'pode_enviar' });
    expect(a!.budget).toEqual({ status: 'sem_permissao', currency: null, periods: [], notices: [] });
    expect(a!.ready).toEqual({ templates_status: 'sem_permissao', approved_templates: null, templates: null, audiences_status: 'indisponivel', audiences: null, largest_audience: null });
    expect(a!.campaigns).toEqual({ status: 'indisponivel', total: null, items: [] });
  });

  it('o RegemCast recusa o token: a conta pede para conectar de novo, sem dado nenhum', async () => {
    const e = await empresa();
    revogados.add(e.token);
    const corpo = await lida(e);
    const [a] = corpo.accounts;
    expect(a!.status).toBe('sem_autorizacao');
    expect(a!.whatsapp).toEqual({ status: 'indisponivel', connected: null, signal: null, title: null, summary: null, checked_at: null, problems: [] });
    expect(a!.budget.status).toBe('indisponivel');
    expect(a!.campaigns).toEqual({ status: 'indisponivel', total: null, items: [] });
    const d = await detalhar(e);
    expect(d.status).toBe(409);
    expect(d.body.type).toContain('regemcast-sem-autorizacao');
  });

  it('a conta com restrição na Meta e o teto atingido chegam como o RegemCast escreve', async () => {
    const e = await empresa();
    trocas.set(`${e.contaId}:conta_situacao`, {
      ...(RESPOSTAS.conta_situacao as object),
      whatsapp: {
        conectado: true,
        sinal: 'com_restricao',
        titulo: 'A Meta limitou o envio',
        resumo: 'A qualidade do número caiu.',
        lidaEm: '2026-10-08T12:00:00.000Z',
        problemas: [{ onde: 'Número (21) da loja', titulo: 'Qualidade baixa', explicacao: 'Muitas pessoas bloquearam as mensagens.', acao: 'Reduza o envio por alguns dias.' }],
      },
    });
    trocas.set(`${e.contaId}:orcamento_ler`, {
      moeda: 'BRL',
      tetos: { dia: null, semana: null, mes: 30_000 },
      periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 30_000, percentual: 100, texto: 'R$ 300,00 de R$ 300,00 neste mês', sinal: 'cheio' }],
      avisos: ['O teto do mês foi atingido: os envios estão pausados até a virada do mês.'],
    });
    const [a] = (await lida(e)).accounts;
    expect(a!.whatsapp).toMatchObject({ signal: 'com_restricao', title: 'A Meta limitou o envio', problems: [{ where: 'Número (21) da loja', title: 'Qualidade baixa', explanation: 'Muitas pessoas bloquearam as mensagens.', action: 'Reduza o envio por alguns dias.' }] });
    expect(a!.budget.periods).toEqual([{ period: 'mes', label: 'Outubro', limit_cents: 30_000, spent_cents: 30_000, percent: 100, signal: 'cheio' }]);
    expect(a!.budget.notices).toEqual(['O teto do mês foi atingido: os envios estão pausados até a virada do mês.']);
  });

  it('ligada e sem RegemCast conectado: nenhuma conta, e nada é chamado', async () => {
    const e = await empresa({ conectar: false });
    const corpo = await lida(e);
    expect(corpo).toMatchObject({ enabled: true, accounts: [] });
    expect(ferramentasChamadas(e)).toEqual([]);
  });

  it('uma campanha de perto: os números, as falhas por motivo e o custo; e cada recusa com o motivo dela', async () => {
    const e = await empresa();
    const r = await detalhar(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = MessagingCampaignDetailResponse.parse(r.body);
    expect(d.connected_account_id).toBe(e.conta);
    expect(d.campaign).toMatchObject({ id: CAMPANHA, name: 'Sexta em dobro', delivered: 398, failed: 7 });
    expect(d.pause).toBeNull();
    expect(d.waiting).toBeNull();
    expect(d.failures).toEqual([{ messages: 7, title: 'Número sem WhatsApp', explanation: 'O número não tem conta no WhatsApp.', action: 'Confira o número no cadastro.' }]);
    expect(d.cost).toEqual({ currency: 'BRL', spent_cents: 12_736, to_spend_cents: 0, lines: [{ label: 'Gasto na Meta', value: 'R$ 127,36', detail: '398 mensagens entregues' }], notices: [] });
    expect(d.rest_days).toBe(7);
    expect(chamadas.filter((c) => c.token === e.token)).toEqual([{ token: e.token, ferramenta: 'campanha_detalhar', argumentos: { id: CAMPANHA } }]);

    // Pausada pelo teto de gasto: o motivo e quando volta.
    trocas.set(`${e.contaId}:campanha_detalhar`, {
      ...(RESPOSTAS.campanha_detalhar as object),
      campanha: { ...CAMPANHA_FEITA, situacao: 'pausada', pausaMotivo: 'teto_de_gasto', naFila: 232, enviadas: 180, concluidaEm: null },
      pausa: { motivo: 'teto_de_gasto', explicacao: 'O teto de gasto do mês foi atingido.', voltaEm: '2026-11-01T00:00:00.000-03:00' },
    });
    const pausada = MessagingCampaignDetailResponse.parse((await detalhar(e)).body);
    expect(pausada.campaign).toMatchObject({ status: 'pausada', pause_reason: 'teto_de_gasto', queued: 232, finished_at: null });
    expect(pausada.pause).toEqual({ reason: 'teto_de_gasto', explanation: 'O teto de gasto do mês foi atingido.', resumes_at: '2026-11-01T03:00:00.000Z' });

    // A campanha que o RegemCast não encontra nesta conta.
    const outra = await detalhar(e, '0199f1aa-9999-7222-8333-444455556666');
    expect(outra.status).toBe(422);
    expect(outra.body.type).toContain('plataforma-recusou');
    // O id fora do formato nem sai do Liame.
    chamadas.length = 0;
    const torto = await detalhar(e, 'a%20b');
    expect(torto.status).toBe(400);
    expect(ferramentasChamadas(e)).toEqual([]);
    // O RegemCast fora do ar.
    foraDoAr.set(`${e.contaId}:campanha_detalhar`, 503);
    const caiu = await detalhar(e);
    expect(caiu.status).toBe(502);
    expect(caiu.body.type).toContain('plataforma-indisponivel');
    // A conta que não é desta empresa (um id qualquer).
    const semConta = await detalhar(e, CAMPANHA, randomUUID());
    expect(semConta.status).toBe(404);
  });

  it('o cupom da mensagem: o código e os pedidos confirmados no caixa com ele, desde que nasceu; a campanha sem cupom do Liame vem sem nada', async () => {
    const e = await empresa();
    // Sem pedido de mensagem do Liame para a campanha: nenhum cupom.
    expect((await lida(e)).accounts[0]!.campaigns.items[0]!.coupon).toBeNull();
    expect((await detalhar(e)).body.campaign.coupon).toBeNull();

    // A loja do Regem e o pedido de mensagem com o cupom, já criado no Regem.
    const loja = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'regem', $4, 'Loja Centro', 'BRL', 'America/Sao_Paulo')`, [
      loja,
      e.tenantId,
      e.brandId,
      `loja-${randomUUID().slice(0, 8)}`,
    ]);
    const pedidoDeMensagem = (campanha: string, codigo: string, nascido: string | null) =>
      ownerQuery(
        `insert into liame.message_request (id, tenant_id, brand_id, connected_account_id, campaign_id, name, template_name, template_language, template_body, audience, audience_name,
                                            people_can_receive, people_resting, window_days, window_start, window_end, coupon_account_id, coupon_code, coupon_rule, coupon_created_at, actor_type, agent_key)
         values (gen_random_uuid(), $1, $2, $3, $4, 'Combo de domingo', 'combo_domingo_v2', 'pt_BR', 'Peça com o cupom.', '{"origem":"publico","id":"p"}'::jsonb, 'Clientes de domingo',
                 412, 38, '{0,1,2,3,4,5,6}', '09:00', '20:00', $5, $6, '{"codigo":"X"}'::jsonb, $7::timestamptz, 'agent', 'crm')`,
        [e.tenantId, e.brandId, e.conta, campanha, loja, codigo, nascido],
      );
    await pedidoDeMensagem(CAMPANHA, 'COMBO10', '2026-10-08T14:00:00Z');
    // O cupom que ainda não nasceu (o pedido espera a aprovação) não aparece.
    await pedidoDeMensagem(randomUUID(), 'AINDANAO', null);
    const venda = (codigo: string | null, quando: string, status: 'confirmado' | 'cancelado', receita: number, devolvido = 0, conta = loja) =>
      ownerQuery(
        `insert into liame.order_fact (id, tenant_id, brand_id, connected_account_id, provider, external_id, channel, channel_group, status, currency, timezone, revenue_micros, refunded_micros, coupon_code,
                                       confirmed_at, cancelled_at, source_version, source_updated_at)
         values (gen_random_uuid(), $1, $2, $3, 'regem', $4, 'cardapio', 'cardapio', $5::text, 'BRL', 'America/Sao_Paulo', $6, $7, $8, $9::timestamptz, case when $5::text = 'cancelado' then $9::timestamptz + interval '1 hour' end, 1, now())`,
        [e.tenantId, e.brandId, conta, `p-${randomUUID().slice(0, 12)}`, status, receita, devolvido, codigo, quando],
      );
    await venda('COMBO10', '2026-10-08T15:00:00Z', 'confirmado', 89_900_000);
    await venda('COMBO10', '2026-10-08T19:30:00Z', 'confirmado', 120_000_000, 20_000_000);
    // Não contam: o cancelado, o de antes de o cupom nascer, o de outro cupom, o sem cupom e o de outra loja.
    await venda('COMBO10', '2026-10-08T16:00:00Z', 'cancelado', 50_000_000);
    await venda('COMBO10', '2026-10-07T12:00:00Z', 'confirmado', 70_000_000);
    await venda('OUTRO15', '2026-10-08T15:00:00Z', 'confirmado', 60_000_000);
    await venda(null, '2026-10-08T15:00:00Z', 'confirmado', 40_000_000);
    const outraLoja = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'regem', $4, 'Loja Praia', 'BRL', 'America/Sao_Paulo')`, [
      outraLoja,
      e.tenantId,
      e.brandId,
      `loja-${randomUUID().slice(0, 8)}`,
    ]);
    await venda('COMBO10', '2026-10-08T15:00:00Z', 'confirmado', 99_000_000, 0, outraLoja);

    // Dois pedidos, R$ 89,90 + (R$ 120,00 − R$ 20,00 devolvidos) = R$ 189,90.
    const cupom = { code: 'COMBO10', orders: 2, revenue_cents: 18_990 };
    expect((await lida(e)).accounts[0]!.campaigns.items[0]!.coupon).toEqual(cupom);
    const perto = await detalhar(e);
    expect([perto.status, perto.body.campaign.coupon], JSON.stringify(perto.body)).toEqual([200, cupom]);
    // Outra empresa, com a mesma campanha no RegemCast falso, não vê o cupom desta.
    const outra = await empresa();
    expect((await lida(outra)).accounts[0]!.campaigns.items[0]!.coupon).toBeNull();
  });

  it('a conexão sem a leitura das campanhas diz isso ao abrir uma campanha', async () => {
    const e = await empresa({ permissoes: ['conversas.anuncio.ler', 'conta.ler'] });
    const d = await detalhar(e);
    expect(d.status).toBe(409);
    expect(d.body.type).toContain('regemcast-sem-permissao');
    const [a] = (await lida(e)).accounts;
    expect(a!.status).toBe('ok');
    expect(a!.campaigns.status).toBe('sem_permissao');
  });

  it('quem não vê campanhas não lê, e outra empresa não alcança a marca nem a conta', async () => {
    const e = await empresa();
    const relatorios = await membro(e, 'so_relatorios');
    expect((await ver(e, relatorios.cookie)).status).toBe(403);
    expect((await detalhar(e, CAMPANHA, e.conta, relatorios.cookie)).status).toBe(403);
    const leitor = await membro(e, 'somente_leitura');
    expect((await ver(e, leitor.cookie)).status).toBe(200);

    const vizinha = await empresa();
    chamadas.length = 0;
    expect((await ver(vizinha, vizinha.cookie, e.brandId)).status).toBe(404);
    expect((await detalhar(vizinha, CAMPANHA, e.conta)).status).toBe(404);
    // Nada foi lido com o token da primeira empresa a pedido da vizinha.
    expect(ferramentasChamadas(e)).toEqual([]);
    expect((await api.call('GET', `/v1/messaging?brand_id=${e.brandId}`, {})).status).toBe(401);
  });
});
