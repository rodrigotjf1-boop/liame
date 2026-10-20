import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { MessagingCampaignDetailResponse, MessagingResponse } from '@liame/contracts';
import { createDatabase, type Database, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { regemcastMensagemConnector } from '../../src/actions/regemcast-mensagem.js';
import { SincronizadorConversas } from '../../src/attribution/sincronizador-conversas.js';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { FLAG_REGEMCAST_POR_CLIQUE } from '../../src/connections/oauth.js';
import { SO_LEITURA_PELA_AUTORIZACAO } from '../../src/connectors/regemcast/credencial-da-conta.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { lerContaDoRegemcast } from '../../src/mensageria/conta-do-regemcast.js';
import { FLAG_MENSAGERIA } from '../../src/mensageria/mensageria.service.js';
import { FLAG_DO_ENVIO, PedidoDeMensagemService } from '../../src/mensageria/pedido-de-mensagem.service.js';
import { ESCOPOS_DE_ESCRITA_NO_REGEMCAST } from '../../src/mensageria/rotina-do-crm.js';
import { ResultsService } from '../../src/results/results.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { ModeloDoCrmService } from '../../src/worker/modelo-do-crm.service.js';
import { FLAG_DO_CRM } from '../../src/worker/rotina-do-crm.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { semearPropostaDoCrm } from '../helpers/mensagens-semeadas.js';
import { APP_URL, hasDb } from './env.js';

// Hub DMS (F2, parte B, B1, PR 3): a conta do RegemCast ligada pela autorização por clique é LIDA pela ligação (o token
// do DMS ID do aplicativo do Liame e o segredo da ligação no cabeçalho `DMS-Ligacao`): as conversas abertas por anúncio,
// a tela Mensagens e a campanha de perto. Gravar (o rascunho do funcionário de CRM, o pedido de envio, o disparo) fica
// fora até a F5 (decisão B1-3), com a frase de "só leitura". Desligar a conta ou revogar a conexão desliga a ligação no
// RegemCast. Contra um RegemCast de mentira que segue o de verdade (RegemCast #123 e #124): o `rct_it_` recusado volta
// 401 com `{ mensagem }` (o filtro geral de lá, sem o nome do problema); pela via nova, o token do DMS ID recusado volta
// `token-invalido` e a ligação que não vale mais, `ligacao-invalida` (problem+json); e um DMS ID de mentira
// (`/oidc/token`, client credentials).

const FIX = resolve(import.meta.dirname, '../fixtures/regemcast/v2');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as Record<string, unknown>;
const situacao = fixture('situacao.json');
const API_PUBLICA = 'http://api.liame.test';
const APLICATIVO = 'aplicativo-do-liame-nas-leituras';
/** O segredo do aplicativo do Liame no DMS ID de mentira (nome neutro, V123). */
const VALOR_DO_APLICATIVO = 'valor-do-aplicativo-de-teste-1234509876';
const LEITURAS = ['conta.ler', 'campanhas.ler', 'publicos.ler', 'modelos.ler', 'orcamento.ler', 'conversas.anuncio.ler'];
const CAMPANHA = '0199f1aa-1111-7222-8333-444455556666';
const T0 = new Date('2026-09-28T12:00:00Z');
const mais = (min: number) => new Date(T0.getTime() + min * 60_000);
const ESCOPO_DA_FERRAMENTA: Record<string, string> = {
  conversas_anuncio_listar: 'conversas.anuncio.ler',
  conta_situacao: 'conta.ler',
  campanhas_listar: 'campanhas.ler',
  campanha_detalhar: 'campanhas.ler',
  publicos_listar: 'publicos.ler',
  modelos_listar: 'modelos.ler',
  orcamento_ler: 'orcamento.ler',
};
const LIDAS_PELA_TELA = ['campanhas_listar', 'conta_situacao', 'modelos_listar', 'orcamento_ler', 'publicos_listar'];
const DESCONECTADA = 'O RegemCast recusou a autorização desta conta: conecte de novo.';

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
  campanha_detalhar: { campanha: CAMPANHA_FEITA, pausa: null, espera: null, falhasPorMotivo: [], custo: null, descansoDias: 7 },
  publicos_listar: {
    listas: [{ id: 'l1', nome: 'Clientes do salão', regra: null, pessoas: 180, usadaEm: '2026-09-20T15:00:00.000Z' }],
    publicos: [{ id: 'recentes_30', nome: 'Quem pediu nos últimos 30 dias', regra: 'Pedido confirmado nos últimos 30 dias', pessoas: 450 }],
    perfis: [],
  },
  modelos_listar: { modelos: [MODELO] },
  orcamento_ler: {
    moeda: 'BRL',
    tetos: { dia: null, semana: null, mes: 30_000 },
    periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 12_736, percentual: 42.45, texto: 'R$ 127,36 de R$ 300,00 neste mês', sinal: 'ok' }],
    avisos: [],
  },
};

type Pedido = { numero: string; corpo: Record<string, string> };
type Chamada = { ferramenta: string; bearer: string; ligacao: string; argumentos: Record<string, unknown> };
type Resposta = { status: number; corpo: unknown; problema?: boolean; cabecalhos?: Record<string, string> };
type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string };
type PeloClique = { conexao: string; conta: string; contaId: string; ligacao: string };

describe.skipIf(!hasDb)('o RegemCast lido pela ligação da autorização por clique (Hub DMS, B1)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let sincronizador: SincronizadorConversas;
  let doModelo: ModeloDoCrmService;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const pedidos: Pedido[] = [];
  /** Código → o pedido de onde veio (o "dono autorizou na página"). */
  const codigos = new Map<string, Pedido>();
  /** Ligação → a conta dela (cada ligação, uma conta nova: cota e disjuntor de cada teste à parte). */
  const ligacoes = new Map<string, string>();
  const revogadas: string[] = [];
  /** `rct_it_` da distribuição → a conta dele. */
  const tokens = new Map<string, string>();
  const tokensRevogados = new Set<string>();
  const tokensDoDmsId = new Set<string>();
  /** Tokens do DMS ID que o RegemCast passou a recusar (vencidos lá): o pedido de outro é aceito. */
  const tokensRecusados = new Set<string>();
  const chamadas: Chamada[] = [];
  const chamadasAoRegem: string[] = [];
  /** O RegemCast recusa todo token do DMS ID (vencido, trocado lá): mesmo o pedido de novo. */
  let recusarOsTokensDoDmsId = false;
  /** O DMS ID recusa o aplicativo do Liame (o segredo trocado lá). */
  let dmsIdRecusaOAplicativo = false;
  let ultimaLigacao = '';

  const problema = (tipo: string, status: number): Resposta => ({
    status,
    corpo: { type: `https://dev.dmstecnologias.com/erros/${tipo}`, title: tipo, status, detail: `recusado: ${tipo}` },
    problema: true,
  });
  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const recusada = (texto: string) => ({ result: { content: [{ type: 'text', text: texto }], isError: true, resultType: 'complete' } });
  const bearerDe = (h: IncomingHttpHeaders) => (h.authorization ?? '').replace(/^Bearer /, '');

  /** Uma ferramenta, para a credencial que já passou pela porta (com as permissões e a conta dela). */
  function ferramenta(nome: string, args: Record<string, unknown>, contaId: string, revogar: () => void): object {
    if (nome === 'integracao_situacao') {
      return resultado({ ...situacao, contaId, produto: 'liame', classe: 'dms', token: 'Liame', permissoes: LEITURAS.map((id) => ({ id, rotulo: id, descricao: id })) });
    }
    if (nome === 'integracao_revogar') {
      if (args.confirmar !== true) return recusada('Input validation error: confirmar');
      revogar();
      return resultado({ revogado: true, revogadoEm: new Date().toISOString() });
    }
    // O RegemCast nem lista a ferramenta que a credencial não pode usar (as que gravam, pela ligação): "não encontrada".
    const escopo = ESCOPO_DA_FERRAMENTA[nome];
    if (!escopo || !LEITURAS.includes(escopo)) return { error: { code: -32602, message: `Tool ${nome} not found` } };
    if (nome === 'conversas_anuncio_listar') {
      const cursor = typeof args.cursor === 'string' ? args.cursor : null;
      if (!cursor) return resultado(fixture('conversas-1.json'));
      if (cursor === 'cv-c1') return resultado(fixture('conversas-2.json'));
      return resultado({ itens: [], proximo_cursor: cursor, tem_mais: false });
    }
    if (nome === 'campanha_detalhar' && args.id !== CAMPANHA) return recusada('Campanha não encontrada nesta conta.');
    return resultado(RESPOSTAS[nome]);
  }

  function responderMcp(h: IncomingHttpHeaders, corpo: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }): Resposta {
    const nome = corpo.params?.name ?? '';
    const args = corpo.params?.arguments ?? {};
    const bearer = bearerDe(h);
    const ligacao = String(h['dms-ligacao'] ?? '');
    chamadas.push({ ferramenta: nome, bearer, ligacao, argumentos: args });
    const comId = (r: object): Resposta => ({ status: 200, corpo: { jsonrpc: '2.0', id: corpo.id, ...r } });
    // O `rct_it_` da distribuição, como o guard e o filtro de erro do RegemCast: o revogado (ou desconhecido) volta 401
    // com `{ mensagem }` e o `WWW-Authenticate`, sem o nome do problema.
    if (bearer.startsWith('rct_it_')) {
      const contaId = tokens.get(bearer);
      if (!contaId || tokensRevogados.has(bearer)) {
        return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' }, cabecalhos: { 'www-authenticate': 'Bearer error="invalid_token"' } };
      }
      return comId(ferramenta(nome, args, contaId, () => tokensRevogados.add(bearer)));
    }
    // A via nova: o token do DMS ID primeiro, a ligação depois (a ordem das conferências do RegemCast).
    if (!tokensDoDmsId.has(bearer) || tokensRecusados.has(bearer) || recusarOsTokensDoDmsId) return problema('token-invalido', 401);
    const contaId = ligacoes.get(ligacao);
    if (!contaId) return problema('ligacao-invalida', 401);
    return comId(
      ferramenta(nome, args, contaId, () => {
        ligacoes.delete(ligacao);
        revogadas.push(ligacao);
      }),
    );
  }

  function responder(metodo: string, caminho: string, h: IncomingHttpHeaders, texto: string): Resposta {
    if (caminho.startsWith('/regem/')) {
      chamadasAoRegem.push(`${metodo} ${caminho}`);
      return problema('token-invalido', 401);
    }
    if (caminho === '/dmsid/oidc/token' && metodo === 'POST') {
      const esperado = `Basic ${Buffer.from(`${encodeURIComponent(APLICATIVO)}:${encodeURIComponent(VALOR_DO_APLICATIVO)}`).toString('base64')}`;
      if (dmsIdRecusaOAplicativo || h.authorization !== esperado || new URLSearchParams(texto).get('grant_type') !== 'client_credentials') return { status: 401, corpo: { error: 'invalid_client' } };
      const token = `tok-${tokensDoDmsId.size + 1}-${randomUUID()}`;
      tokensDoDmsId.add(token);
      return { status: 200, corpo: { access_token: token, token_type: 'Bearer', expires_in: 3600 } };
    }
    const doDmsId = tokensDoDmsId.has(bearerDe(h)) && !recusarOsTokensDoDmsId;
    if (caminho === '/cast/integracao/autorizacao/pedido' && metodo === 'POST') {
      if (!doDmsId) return problema('token-invalido', 401);
      const numero = `urn:ietf:params:oauth:request_uri:rct_${randomBytes(32).toString('base64url')}`;
      pedidos.push({ numero, corpo: JSON.parse(texto || '{}') as Record<string, string> });
      return { status: 201, corpo: { request_uri: numero, expires_in: 600 } };
    }
    if (caminho === '/cast/integracao/autorizacao/token' && metodo === 'POST') {
      if (!doDmsId) return problema('token-invalido', 401);
      const b = JSON.parse(texto || '{}') as Record<string, string>;
      const pedido = codigos.get(b.code ?? '');
      codigos.delete(b.code ?? '');
      const desafio = createHash('sha256').update(b.code_verifier ?? '').digest('base64url');
      if (!pedido || desafio !== pedido.corpo.code_challenge || b.redirect_uri !== pedido.corpo.redirect_uri || b.client_id !== APLICATIVO) return problema('autorizacao-invalida', 400);
      const ligacao = `dms_lg_regemcast_${randomBytes(32).toString('base64url')}_${randomBytes(4).toString('base64url').slice(0, 6)}`;
      const contaId = randomUUID();
      ligacoes.set(ligacao, contaId);
      ultimaLigacao = ligacao;
      return { status: 200, corpo: { ligacao, prefixo: ligacao.slice(0, 22), conta_id: contaId, conta: 'Mister Burgers', permissoes: LEITURAS, segredo_em: new Date().toISOString() } };
    }
    return { status: 404, corpo: {} };
  }

  async function ligarFlag(tenantId: string, flag: string) {
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, tenantId]);
    api.app.get(FlagService).invalidate();
  }

  async function empresa(nome: string): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    await ligarFlag(tenantId, FLAG_REGEMCAST_POR_CLIQUE);
    await ligarFlag(tenantId, FLAG_MENSAGERIA);
    return { cookie: s.cookie, tenantId, brandId: marca!.id, userId: s.me.user.id as string };
  }

  /** O caminho de verdade do clique: o pedido, a volta com o código, a troca pelo worker e a conta ligada à marca. */
  async function conectarPorClique(e: Empresa): Promise<PeloClique> {
    const inicio = await api.call('POST', '/v1/connections', { cookie: e.cookie, body: { provider: 'regemcast', brand_id: e.brandId } });
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
    const pedido = pedidos.at(-1)!;
    const codigo = `rct_ac_${randomBytes(32).toString('base64url')}`;
    codigos.set(codigo, pedido);
    const volta = await fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams({ state: pedido.corpo.state!, code: codigo, iss: new URL(base).origin })}`, {
      headers: { cookie: e.cookie },
      redirect: 'manual',
    });
    expect(volta.status).toBe(303);
    expect(await processador.processarLote(5, { tenantIds: [e.tenantId] })).toBe(1);
    const ligacao = ultimaLigacao;
    const contaId = ligacoes.get(ligacao)!;
    const ligar = await api.call('POST', `/v1/connections/${inicio.body.id}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: contaId }] } });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    chamadas.length = 0;
    return { conexao: inicio.body.id as string, conta: ligar.body.linked[0].id as string, contaId, ligacao };
  }

  const verMensagens = async (e: Empresa) => {
    const r = await api.call('GET', `/v1/messaging?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return MessagingResponse.parse(r.body).accounts[0]!;
  };
  const detalhar = (e: Empresa, conta: string) => api.call('GET', `/v1/messaging/campaigns/${CAMPANHA}?connected_account_id=${conta}`, { cookie: e.cookie });
  const situacaoDaConta = async (id: string) =>
    (await ownerQuery<{ status: string; status_reason: string | null }>(`select status, status_reason from liame.connected_account where id = $1`, [id]))[0];
  const pelaLigacao = (c: Chamada, ligacao: string) => tokensDoDmsId.has(c.bearer) && c.ligacao === ligacao;
  /** A revogação no RegemCast roda depois do commit: espera até 1 s por ela. */
  const ate = async (condicao: () => boolean) => {
    for (let i = 0; i < 50 && !condicao(); i++) await new Promise((ok) => setTimeout(ok, 20));
  };

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        let r: Resposta;
        try {
          const texto = Buffer.concat(partes).toString('utf8');
          const caminho = new URL(req.url ?? '/', base).pathname;
          if (caminho === '/cast/mcp' && req.method === 'POST') {
            const corpo = JSON.parse(texto || '{}') as { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
            // Como o servidor de verdade (especificação 2026-07-28): o cabeçalho tem de bater com o corpo.
            if (req.headers['mcp-method'] !== corpo.method || req.headers['mcp-name'] !== (corpo.params?.name ?? '')) {
              r = { status: 400, corpo: { jsonrpc: '2.0', id: corpo.id, error: { code: -32020, message: 'header mismatch' } } };
            } else r = responderMcp(req.headers, corpo);
          } else r = responder(req.method ?? 'GET', caminho, req.headers, texto);
        } catch {
          r = { status: 500, corpo: {} };
        }
        res.writeHead(r.status, { 'content-type': r.problema ? 'application/problem+json' : 'application/json', ...r.cabecalhos });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    for (const [nome, valor] of [
      ['API_URL', API_PUBLICA],
      ['REGEM_API_URL', `${base}/regem`],
      ['REGEMCAST_API_URL', `${base}/cast`],
      ['REGEMCAST_AUTH_URL', `${base}/castsite`],
      ['DMS_ID_EMISSOR', `${base}/dmsid/oidc`],
      ['DMS_ID_APLICATIVO', APLICATIVO],
      ['DMS_ID_SEGREDO', VALOR_DO_APLICATIVO],
    ] as const) {
      anterior[nome] = process.env[nome];
      process.env[nome] = valor;
    }
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    processador = new ConexaoProcessor(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
    sincronizador = new SincronizadorConversas(database.db, api.app.get(VaultService), loadConfig());
    doModelo = new ModeloDoCrmService(api.app.get<Database>(DATABASE), loadConfig(), api.app.get(FlagService), api.app.get(VaultService), api.app.get(ResultsService), api.app.get(PedidoDeMensagemService));
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((ok) => servidor?.close(ok));
    for (const [nome, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  });

  it('a tela Mensagens lê as cinco partes e a campanha pela ligação (o token do DMS ID e o segredo no cabeçalho); nada que grava, nada da ligação na resposta', async () => {
    const e = await empresa('Mister Burgers Mensagens Pela Ligação');
    const c = await conectarPorClique(e);
    const a = await verMensagens(e);
    expect(a).toMatchObject({ connected_account_id: c.conta, status: 'ok' });
    expect([a.whatsapp.status, a.budget.status, a.campaigns.status, a.ready.templates_status, a.ready.audiences_status]).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(a.campaigns.items.map((i) => i.id)).toEqual([CAMPANHA]);
    expect(chamadas.map((x) => x.ferramenta).sort()).toEqual(LIDAS_PELA_TELA);
    expect(chamadas.every((x) => pelaLigacao(x, c.ligacao))).toBe(true);

    const d = await detalhar(e, c.conta);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(MessagingCampaignDetailResponse.parse(d.body)).toMatchObject({ connected_account_id: c.conta, campaign: { id: CAMPANHA } });
    expect(chamadas.at(-1)!.ferramenta).toBe('campanha_detalhar');
    expect(pelaLigacao(chamadas.at(-1)!, c.ligacao)).toBe(true);
    expect(JSON.stringify([a, d.body])).not.toContain('dms_lg_');
    expect(chamadasAoRegem).toEqual([]);

    // O token do DMS ID guardado e recusado depois (vencido lá): cada leitura pede outro, uma vez, e a tela segue boa.
    const guardado = chamadas.at(-1)!.bearer;
    tokensRecusados.add(guardado);
    chamadas.length = 0;
    expect((await verMensagens(e)).status).toBe('ok');
    const comOutro = chamadas.filter((x) => x.bearer !== guardado);
    expect(comOutro.map((x) => x.ferramenta).sort()).toEqual(LIDAS_PELA_TELA);
    expect(comOutro.every((x) => pelaLigacao(x, c.ligacao))).toBe(true);
  });

  it('a recusa do DMS ID (o token recusado de novo, ou o aplicativo do Liame recusado) deixa a tela indisponível, sem "conecte de novo"; a ligação revogada lá, sim', async () => {
    const e = await empresa('Mister Burgers Recusas na Tela');
    const c = await conectarPorClique(e);
    const partes = (a: Awaited<ReturnType<typeof verMensagens>>) => [a.status, a.whatsapp.status, a.budget.status, a.campaigns.status, a.ready.templates_status, a.ready.audiences_status];
    const indisponivel = ['ok', 'indisponivel', 'indisponivel', 'indisponivel', 'indisponivel', 'indisponivel'];
    recusarOsTokensDoDmsId = true;
    try {
      expect(partes(await verMensagens(e))).toEqual(indisponivel);
      const d = await detalhar(e, c.conta);
      expect([d.status, d.body.type]).toEqual([502, expect.stringContaining('plataforma-indisponivel')]);
      dmsIdRecusaOAplicativo = true;
      expect(partes(await verMensagens(e))).toEqual(indisponivel);
    } finally {
      recusarOsTokensDoDmsId = false;
      dmsIdRecusaOAplicativo = false;
    }
    expect(await situacaoDaConta(c.conta)).toMatchObject({ status: 'ativa' });

    ligacoes.delete(c.ligacao);
    expect((await verMensagens(e)).status).toBe('sem_autorizacao');
    const d = await detalhar(e, c.conta);
    expect([d.status, d.body.type]).toEqual([409, expect.stringContaining('regemcast-sem-autorizacao')]);
  });

  it('as conversas abertas por anúncio pela ligação; a recusa do DMS ID é falha passageira (a conta segue ativa); a ligação revogada lá desconecta a conta', async () => {
    const e = await empresa('Mister Burgers Conversas Pela Ligação');
    const c = await conectarPorClique(e);
    const r = await sincronizador.sincronizar(c.conta, e.tenantId, T0);
    expect(r).toMatchObject({ status: 'ok', conversas: 4 });
    const listar = chamadas.filter((x) => x.ferramenta === 'conversas_anuncio_listar');
    expect(listar).toHaveLength(2);
    expect(listar.every((x) => pelaLigacao(x, c.ligacao))).toBe(true);
    const [toques] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.touchpoint where connected_account_id = $1 and kind = 'conversa'`, [c.conta]);
    expect(toques!.n).toBe('4');

    for (const [token, aplicativo] of [
      [true, false],
      [true, true],
    ] as const) {
      recusarOsTokensDoDmsId = token;
      dmsIdRecusaOAplicativo = aplicativo;
      try {
        // Cada rodada depois da espera da falha anterior.
        const f = await sincronizador.sincronizar(c.conta, e.tenantId, mais(aplicativo ? 24 * 60 : 60));
        expect(f.status).toBe('falhou');
      } finally {
        recusarOsTokensDoDmsId = false;
        dmsIdRecusaOAplicativo = false;
      }
      expect(await situacaoDaConta(c.conta)).toMatchObject({ status: 'ativa' });
    }

    ligacoes.delete(c.ligacao);
    expect((await sincronizador.sincronizar(c.conta, e.tenantId, mais(3 * 24 * 60))).status).toBe('falhou');
    expect(await situacaoDaConta(c.conta)).toEqual({ status: 'desconectada', status_reason: DESCONECTADA });
  });

  it('pelo token da distribuição, o 401 do rct_it_ revogado (com `{ mensagem }`, sem o nome do problema) segue sendo da conta: a tela diz "conecte de novo" e as conversas desconectam', async () => {
    const e = await empresa('Mister Burgers Token Revogado');
    const token = `rct_it_${randomBytes(33).toString('base64url').slice(0, 43)}`;
    const contaId = randomUUID();
    tokens.set(token, contaId);
    const conexao = await registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: loadConfig() }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regemcast', tokens: [token] });
    const ligada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: contaId }] } });
    expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
    const conta = ligada.body.linked[0].id as string;
    expect((await verMensagens(e)).status).toBe('ok');
    expect((await sincronizador.sincronizar(conta, e.tenantId, T0)).status).toBe('ok');

    tokensRevogados.add(token);
    expect((await verMensagens(e)).status).toBe('sem_autorizacao');
    expect((await sincronizador.sincronizar(conta, e.tenantId, mais(60))).status).toBe('falhou');
    expect(await situacaoDaConta(conta)).toEqual({ status: 'desconectada', status_reason: DESCONECTADA });
  });

  it('o funcionário de CRM: a conta pela ligação tem a credencial e não grava; a proposta de mensagem é recusada (409 `regemcast-so-leitura`) antes de chamar o RegemCast', async () => {
    const e = await empresa('Mister Burgers CRM Pela Ligação');
    const c = await conectarPorClique(e);
    // Nem com as permissões de escrita anotadas na conta (o que a autorização do dono não dá): pela ligação, não grava.
    await ownerQuery(`update liame.connected_account set provider_attributes = jsonb_set(coalesce(provider_attributes, '{}'::jsonb), '{escopos}', $2::jsonb) where id = $1`, [
      c.conta,
      JSON.stringify([...LEITURAS, ...ESCOPOS_DE_ESCRITA_NO_REGEMCAST]),
    ]);
    const conta = await withTenant(database.db, e.tenantId, (tx) => lerContaDoRegemcast(tx, api.app.get(VaultService), { tenantId: e.tenantId, brandId: e.brandId }));
    expect(conta).toMatchObject({ id: c.conta, external_id: c.contaId, credencial: { via: 'ligacao', ligacao: c.ligacao }, escreve: false });

    await ligarFlag(e.tenantId, FLAG_DO_ENVIO);
    const proposta = { marca: e.brandId, conta: c.conta, nome: 'Combo família de domingo', modelo: { nome: 'promo_sexta_v2' }, publico: { origem: 'publico', id: 'recentes_30' }, variaveis: [{ origem: 'primeiro_nome' }] };
    const recusa = await api.app
      .get(PedidoDeMensagemService)
      .propor({ tenantId: e.tenantId, agentKey: 'crm', agentLabel: 'CRM e mensageria', emNomeDe: e.userId }, proposta)
      .then(
        () => null,
        (err: unknown) => err as { status?: number; code?: string; detail?: string; getStatus?: () => number },
      );
    expect(recusa && [recusa.status ?? recusa.getStatus?.(), recusa.code, recusa.detail]).toEqual([409, 'regemcast-so-leitura', SO_LEITURA_PELA_AUTORIZACAO]);
    expect(chamadas).toEqual([]);
    const [pedidosDeEnvio] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.message_request where tenant_id = $1`, [e.tenantId]);
    expect(pedidosDeEnvio!.n).toBe('0');
  });

  it('as propostas do funcionário de CRM numa conta que passou a ser lida pela ligação (a que esperava o rascunho e a que esperava a Meta) são descartadas com `sem_permissao`, sem chamar o RegemCast', async () => {
    const e = await empresa('Mister Burgers Propostas Pela Ligação');
    const c = await conectarPorClique(e);
    await ligarFlag(e.tenantId, FLAG_DO_CRM);
    await ligarFlag(e.tenantId, FLAG_DO_ENVIO);
    const alvo = { tenantId: e.tenantId, brandId: e.brandId, userId: e.userId, conta: c.conta };
    const preparando = await semearPropostaDoCrm(alvo, { situacao: 'preparando', nome: 'Sexta em dobro' });
    await ownerQuery(`update liame.message_proposal set coupon = $2::jsonb where id = $1`, [
      preparando,
      JSON.stringify({ loja: randomUUID(), codigo: 'SEXTA10', tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: '2026-10-20', valido_ate: '2026-10-22' }),
    ]);
    expect(await doModelo.rascunhar({ tenantId: e.tenantId, id: preparando })).toEqual({ status: 'descartada', motivo: 'sem_permissao' });
    // Uma proposta em andamento por vez (`uq_message_proposal_andamento`): a segunda nasce depois de a primeira acabar.
    const noRascunho = await semearPropostaDoCrm(alvo, { situacao: 'rascunho' });
    expect(await doModelo.acompanhar({ tenantId: e.tenantId, id: noRascunho })).toEqual({ status: 'descartada', motivo: 'sem_permissao' });
    expect(chamadas).toEqual([]);
    const propostas = await ownerQuery<{ id: string; status: string; reason: string | null }>(`select id, status, reason from liame.message_proposal where tenant_id = $1 order by id`, [e.tenantId]);
    expect(propostas.map((p) => [p.id, p.status, p.reason])).toEqual(
      [
        [preparando, 'descartada', 'sem_permissao'],
        [noRascunho, 'descartada', 'sem_permissao'],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
  });

  it('o envio de uma conta que passou a ser lida pela ligação é recusado com a frase de só leitura, sem chamar o RegemCast', async () => {
    const e = await empresa('Mister Burgers Envio Pela Ligação');
    const c = await conectarPorClique(e);
    const ref = { tenantId: e.tenantId, accountId: c.conta, resourceId: `mensagem:${CAMPANHA}` };
    const r = await withTenant(database.db, e.tenantId, (tx) => regemcastMensagemConnector.apply(tx, ref, { situacao: 'disparando' }, 1));
    expect(r).toEqual({ ok: false, reason: 'recusado', mensagem: SO_LEITURA_PELA_AUTORIZACAO });
    expect(chamadas).toEqual([]);
  });

  it('desligar a conta desliga a ligação no RegemCast (`integracao_revogar` pelo token do DMS ID e a ligação, depois do commit), e a trilha diz que foi revogada lá', async () => {
    const e = await empresa('Mister Burgers Desligar Pela Ligação');
    const c = await conectarPorClique(e);
    const r = await api.call('DELETE', `/v1/connected-accounts/${c.conta}`, { cookie: e.cookie });
    expect(r.status).toBe(204);
    await ate(() => revogadas.includes(c.ligacao));
    expect(revogadas).toContain(c.ligacao);
    const revogacao = chamadas.find((x) => x.ferramenta === 'integracao_revogar')!;
    expect(pelaLigacao(revogacao, c.ligacao)).toBe(true);
    expect(revogacao.argumentos).toEqual({ confirmar: true });
    const [trilha] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'conta.desconectar' and resource_id = $2`, [
      e.tenantId,
      c.conta,
    ]);
    expect(trilha!.after).toMatchObject({ status: 'desconectada', provider: 'regemcast', external_id: c.contaId, revogada_no_regemcast: true });
  });

  it('revogar a conexão do clique desliga a ligação no RegemCast, depois do commit', async () => {
    const e = await empresa('Mister Burgers Revogar Pela Ligação');
    const c = await conectarPorClique(e);
    const r = await api.call('DELETE', `/v1/connections/${c.conexao}`, { cookie: e.cookie });
    expect(r.status).toBe(204);
    await ate(() => revogadas.includes(c.ligacao));
    expect(revogadas).toContain(c.ligacao);
    const revogacao = chamadas.find((x) => x.ferramenta === 'integracao_revogar')!;
    expect(pelaLigacao(revogacao, c.ligacao)).toBe(true);
    expect(await situacaoDaConta(c.conta)).toMatchObject({ status: 'desconectada' });
  });
});
