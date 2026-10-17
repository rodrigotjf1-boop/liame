import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ComparacaoDmsIdLoop, FLAG_COMPARACAO } from '../../src/worker/comparacao-dms-id.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// Hub DMS (F2, A3, parte 2): a rotina que compara as 10 leituras do RegemCast pela credencial de hoje (`rct_it_`) e
// pela nova (o token do DMS ID do aplicativo do Liame com o segredo da ligação), contra um RegemCast de mentira que
// atende as duas vias (a nova como a porta do RegemCast #118: problem+json, `DMS-Ligacao`, a troca em
// `POST /dms-id/ligacao`) e um DMS ID de mentira (`/oidc/token`, client credentials). Fica guardado só como terminou
// cada comparação e o caminho do que difere, nunca o valor.

const FIX = resolve(import.meta.dirname, '../fixtures/regemcast/v2');
const fixture = (arquivo: string) => JSON.parse(readFileSync(resolve(FIX, arquivo), 'utf8')) as Record<string, unknown>;
const TOKEN = `rct_it_${'C'.repeat(43)}`;
const TOKEN_NOVO = `rct_it_${'N'.repeat(43)}`;
const APLICATIVO = 'aplicativo-do-liame-de-teste';
/** O segredo do aplicativo do Liame no DMS ID de mentira (nome neutro, V123). */
const VALOR_DO_APLICATIVO = 'valor-do-aplicativo-de-teste-0123456789';
const CAMPANHA = '0199f1aa-1111-7222-8333-444455556666';
const RASCUNHO = '0199f1aa-2222-7333-8444-555566667777';
const T0 = new Date('2026-10-16T12:00:00Z');
const mais = (min: number) => new Date(T0.getTime() + min * 60_000);

const CAMPANHA_BASE = {
  nome: 'Sexta em dobro',
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
const FEITA = { ...CAMPANHA_BASE, id: CAMPANHA, situacao: 'concluida' };
const EM_RASCUNHO = { ...CAMPANHA_BASE, id: RASCUNHO, situacao: 'rascunho', naFila: 412, enviadas: 0, entregues: 0, lidas: 0, falhas: 0, responderam: 0, iniciadaEm: null, concluidaEm: null };
const CUSTO = { moeda: 'BRL', gastoCentavos: 0, aSairCentavos: 13_184, linhas: [{ rotulo: 'Custo estimado na Meta', valor: 'até R$ 131,84', detalhe: '412 mensagens de marketing' }], avisos: [] };
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

/** As 10 leituras como o RegemCast responde (contrato v2), iguais pelas duas vias, salvo o que o teste mudar. */
function respostas(): Record<string, unknown> {
  return {
    integracao_situacao: { ...fixture('situacao.json'), permissoes: [{ id: 'conta.ler', rotulo: 'Situação da conta', descricao: 'Ver se a conta pode enviar agora.' }] },
    conversas_anuncio_listar: fixture('conversas-1.json'),
    conta_situacao: {
      conta: 'Mister Burgers',
      fuso: 'America/Sao_Paulo',
      whatsapp: { conectado: true, sinal: 'pode_enviar', titulo: 'Tudo certo para enviar', resumo: 'A conta do WhatsApp está saudável na Meta.', lidaEm: '2026-10-08T12:00:00.000Z', problemas: [] },
      plano: { nome: 'Essencial', assinatura: 'ativa', gratisPeloRegem: true, disparosNoCiclo: 412, tetoDoCiclo: 5000, restantes: 4588, cicloFim: '2026-10-31' },
    },
    campanhas_listar: { campanhas: [FEITA, EM_RASCUNHO], total: 2 },
    campanha_detalhar: { campanha: FEITA, pausa: null, espera: null, falhasPorMotivo: [], custo: CUSTO, descansoDias: 7 },
    publicos_listar: { listas: [], publicos: [{ id: 'recentes_30', nome: 'Quem pediu nos últimos 30 dias', regra: 'Pedido confirmado nos últimos 30 dias', pessoas: 450 }], perfis: [] },
    modelos_listar: { modelos: [MODELO] },
    orcamento_ler: {
      moeda: 'BRL',
      tetos: { dia: null, semana: null, mes: 30_000 },
      periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 12_736, percentual: 42.45, texto: 'R$ 127,36 de R$ 300,00 neste mês', sinal: 'ok' }],
      avisos: [],
    },
    publico_estimar: { pessoas: 450, emDescanso: 38, descansoDias: 7, custo: CUSTO },
    campanha_disparo_planejar: {
      campanha: EM_RASCUNHO,
      custo: CUSTO,
      orcamento: { definido: true, periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 12_736, texto: 'R$ 127,36 de R$ 300,00 neste mês', sinal: 'ok' }], aviso: null },
      podeDisparar: true,
      impedimentos: [],
      confirmacao: 'c0nf1rmacao-do-plano-0123456789ab',
    },
  };
}

type Chamada = { via: 'atual' | 'nova'; ferramenta: string; cabecalhos: IncomingHttpHeaders };

describe.skipIf(!hasDb)('comparação das duas credenciais do RegemCast (Hub DMS, A3 parte 2)', () => {
  let api: TestApi;
  let database: Database;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  const chamadas: Chamada[] = [];
  const pedidosDeToken: { autorizacao: string; corpo: URLSearchParams }[] = [];
  const tokensDoDmsId = new Set<string>();
  const tokensRecusados = new Set<string>();
  /** Segredo da ligação → o `rct_it_` de onde veio. */
  const ligacoes = new Map<string, string>();
  const ligacoesRecusadas = new Set<string>();
  let trocas = 0;
  /** A conta que a troca diz que a ligação abre (nulo = a do token; outra = o RegemCast errou). */
  let contaDaTroca: string | null = null;
  /** O que a via nova responde diferente (por ferramenta); `vezes` = só nas primeiras N chamadas. */
  const naNova = new Map<string, { resposta: unknown; vezes?: number }>();
  let contaRegemcast = '';
  const situacao = fixture('situacao.json');
  let e: { cookie: string; tenantId: string; brandId: string; conta: string; conexao: string };

  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const problema = (tipo: string, status: number) => ({ type: `https://dev.dmstecnologias.com/erros/${tipo}`, title: tipo, status, detail: `recusado: ${tipo}` });

  function mcp(cabecalhos: IncomingHttpHeaders, corpo: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }): { status: number; corpo: unknown; problema?: boolean } {
    const bearer = (cabecalhos.authorization ?? '').replace(/^Bearer /, '');
    const ferramenta = corpo.params?.name ?? '';
    const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
    if (bearer.startsWith('rct_it_')) {
      chamadas.push({ via: 'atual', ferramenta, cabecalhos });
      if (bearer !== TOKEN && bearer !== TOKEN_NOVO) return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
      if (ferramenta === 'integracao_revogar') return { status: 200, corpo: comId(resultado({ revogado: true, revogadoEm: new Date().toISOString() })) };
      return { status: 200, corpo: comId(resultado(respostas()[ferramenta] ?? {})) };
    }
    chamadas.push({ via: 'nova', ferramenta, cabecalhos });
    if (!tokensDoDmsId.has(bearer) || tokensRecusados.has(bearer)) return { status: 401, corpo: problema('token-invalido', 401), problema: true };
    const ligacao = String(cabecalhos['dms-ligacao'] ?? '');
    if (!ligacoes.has(ligacao) || ligacoesRecusadas.has(ligacao)) return { status: 401, corpo: problema('ligacao-invalida', 401), problema: true };
    const outra = naNova.get(ferramenta);
    if (outra && (outra.vezes === undefined || outra.vezes > 0)) {
      if (outra.vezes !== undefined) outra.vezes -= 1;
      return { status: 200, corpo: comId(resultado(outra.resposta)) };
    }
    const r = respostas()[ferramenta];
    // Pela via nova, a situação traz as permissões do token do DMS ID E da ligação: outra lista, a mesma conta.
    if (ferramenta === 'integracao_situacao') return { status: 200, corpo: comId(resultado({ ...(r as object), permissoes: [] })) };
    return { status: 200, corpo: comId(resultado(r)) };
  }

  function troca(cabecalhos: IncomingHttpHeaders, corpo: { token_integracao?: string }): { status: number; corpo: unknown; problema?: boolean } {
    const bearer = (cabecalhos.authorization ?? '').replace(/^Bearer /, '');
    if (!tokensDoDmsId.has(bearer) || tokensRecusados.has(bearer)) return { status: 401, corpo: problema('token-invalido', 401), problema: true };
    if (corpo.token_integracao !== TOKEN && corpo.token_integracao !== TOKEN_NOVO) return { status: 401, corpo: problema('ligacao-invalida', 401), problema: true };
    trocas += 1;
    const ligacao = `dms_lg_regemcast_${randomBytes(32).toString('base64url')}_abcdef`;
    ligacoes.set(ligacao, corpo.token_integracao);
    return {
      status: 200,
      corpo: { ligacao, prefixo: ligacao.slice(0, 22), conta_id: contaDaTroca ?? situacao.contaId, conta: 'Mister Burgers', permissoes: ['conta.ler', 'campanhas.ler'], segredo_em: new Date().toISOString() },
    };
  }

  function tokenDoDmsId(cabecalhos: IncomingHttpHeaders, corpo: string): { status: number; corpo: unknown } {
    const params = new URLSearchParams(corpo);
    pedidosDeToken.push({ autorizacao: String(cabecalhos.authorization ?? ''), corpo: params });
    const esperado = `Basic ${Buffer.from(`${encodeURIComponent(APLICATIVO)}:${encodeURIComponent(VALOR_DO_APLICATIVO)}`).toString('base64')}`;
    if (cabecalhos.authorization !== esperado || params.get('grant_type') !== 'client_credentials') return { status: 401, corpo: { error: 'invalid_client' } };
    const token = `tok-${tokensDoDmsId.size + 1}-${randomUUID()}`;
    tokensDoDmsId.add(token);
    return { status: 200, corpo: { access_token: token, token_type: 'Bearer', expires_in: 3600 } };
  }

  const loop = () => new ComparacaoDmsIdLoop(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
  const linhas = () =>
    ownerQuery<{ tool: string; outcome: string; differences: string[]; retried: boolean; failure: string | null }>(
      `select tool, outcome, differences, retried, failure from liame.credential_comparison where connected_account_id = $1 order by compared_at, tool`,
      [contaRegemcast],
    );
  const doUltimo = async (quando: Date) =>
    ownerQuery<{ tool: string; outcome: string; differences: string[]; retried: boolean; failure: string | null }>(
      `select tool, outcome, differences, retried, failure from liame.credential_comparison where connected_account_id = $1 and compared_at = $2 order by tool`,
      [contaRegemcast, quando.toISOString()],
    );
  const ligacaoNoCofre = async () =>
    (
      await ownerQuery<{ ligacao_secret_id: string | null; purpose: string | null; revogado: boolean | null }>(
        `select a.ligacao_secret_id, s.purpose, s.revoked_at is not null as revogado from liame.connected_account a left join liame.secret s on s.id = a.ligacao_secret_id where a.id = $1`,
        [contaRegemcast],
      )
    )[0]!;
  async function ligarFlag(valor: boolean) {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [FLAG_COMPARACAO, e.tenantId]);
    if (valor) {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [FLAG_COMPARACAO, e.tenantId]);
    }
    api.app.get(FlagService).invalidate();
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8');
        const url = new URL(req.url ?? '/', base);
        let r: { status: number; corpo: unknown; problema?: boolean };
        try {
          if (url.pathname === '/dmsid/oidc/token' && req.method === 'POST') r = tokenDoDmsId(req.headers, texto);
          else if (url.pathname === '/cast/dms-id/ligacao' && req.method === 'POST') r = troca(req.headers, JSON.parse(texto || '{}') as { token_integracao?: string });
          else if (url.pathname === '/cast/mcp' && req.method === 'POST') r = mcp(req.headers, JSON.parse(texto || '{}') as { id?: unknown; params?: { name?: string } });
          else r = { status: 404, corpo: {} };
        } catch {
          r = { status: 500, corpo: {} };
        }
        res.writeHead(r.status, { 'content-type': r.problema ? 'application/problem+json' : 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    for (const [nome, valor] of [
      ['REGEMCAST_API_URL', `${base}/cast`],
      ['DMS_ID_EMISSOR', `${base}/dmsid/oidc`],
      ['DMS_ID_APLICATIVO', APLICATIVO],
      ['DMS_ID_SEGREDO', VALOR_DO_APLICATIVO],
    ] as const) {
      anterior[nome] = process.env[nome];
      process.env[nome] = valor;
    }
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    const s = await signupAndLogin(api, undefined, 'Mister Burgers Comparação');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const conexao = await registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: loadConfig() }, { tenantId, brandId, produto: 'regemcast', tokens: [TOKEN] });
    const ligada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: s.cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
    contaRegemcast = ligada.body.linked[0].id as string;
    e = { cookie: s.cookie, tenantId, brandId, conta: contaRegemcast, conexao: conexao.connectionId };
    chamadas.length = 0;
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

  it('sem o aplicativo do Liame no DMS ID nas variáveis, a rotina não faz nada', async () => {
    const semDmsId = new ComparacaoDmsIdLoop(database, { ...loadConfig(), dmsId: null }, api.app.get(VaultService), api.app.get(FlagService));
    expect(await semDmsId.executarLote(5, { tenantIds: [e.tenantId] }, T0)).toEqual([]);
    expect(chamadas).toEqual([]);
    expect(pedidosDeToken).toEqual([]);
  });

  it('com a função desligada para a empresa, a conta passa sem chamada nenhuma e volta só no dia seguinte', async () => {
    const r = await loop().executarLote(5, { tenantIds: [e.tenantId] }, T0);
    expect(r).toEqual([{ status: 'desligada' }]);
    expect(chamadas).toEqual([]);
    expect(pedidosDeToken).toEqual([]);
    const [vez] = await ownerQuery<{ next_at: Date }>(`select next_at from liame.credential_comparison_state where connected_account_id = $1`, [contaRegemcast]);
    expect(new Date(vez!.next_at).toISOString()).toBe(mais(24 * 60).toISOString());
    // Antes do dia seguinte, nem reserva.
    expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(60))).toEqual([]);
  });

  it('ligada: pede o token ao DMS ID, troca o rct_it_ pela ligação (cofre e auditoria), e as 10 leituras saem pelas duas vias e dão igual', async () => {
    await ligarFlag(true);
    const agora = mais(24 * 60);
    const comparadora = loop();
    const r = await comparadora.executarLote(5, { tenantIds: [e.tenantId] }, agora);
    expect(r).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);

    // O token: client credentials, com o recurso do RegemCast e só as permissões das leituras.
    expect(pedidosDeToken).toHaveLength(1);
    expect(pedidosDeToken[0]!.corpo.get('resource')).toBe(`${base}/cast/mcp`);
    expect(pedidosDeToken[0]!.corpo.get('scope')!.split(' ').sort()).toEqual(['campanhas.disparar', 'campanhas.ler', 'conta.ler', 'conversas.anuncio.ler', 'modelos.ler', 'orcamento.ler', 'publicos.ler']);
    // A troca: uma vez; o segredo vai para o cofre, com a auditoria.
    expect(trocas).toBe(1);
    expect(await ligacaoNoCofre()).toMatchObject({ purpose: 'ligacao_regemcast', revogado: false });
    const [auditoria] = await ownerQuery<{ action: string; after: Record<string, unknown> }>(
      `select action, "after" from liame.audit_event where tenant_id = $1 and action = 'conexao.ligacao_dms_id'`,
      [e.tenantId],
    );
    expect(auditoria?.after).toMatchObject({ permissoes: ['conta.ler', 'campanhas.ler'] });
    // Na auditoria vai só o prefixo (o começo, para reconhecer qual é); o segredo inteiro, nunca.
    expect(String(auditoria?.after.ligacao)).toMatch(/^dms_lg_regemcast_.{5}$/);
    for (const segredo of ligacoes.keys()) expect(JSON.stringify(auditoria)).not.toContain(segredo);

    // Cada ferramenta, pelas duas vias: a de hoje com o rct_it_; a nova com o token do DMS ID e a ligação.
    const ferramentas = (via: 'atual' | 'nova') => [...new Set(chamadas.filter((c) => c.via === via).map((c) => c.ferramenta))].sort();
    expect(ferramentas('atual')).toHaveLength(10);
    expect(ferramentas('nova')).toEqual(ferramentas('atual'));
    for (const c of chamadas.filter((x) => x.via === 'nova')) {
      expect(c.cabecalhos.authorization).toMatch(/^Bearer tok-/);
      expect(String(c.cabecalhos['dms-ligacao'])).toMatch(/^dms_lg_regemcast_/);
    }
    for (const c of chamadas.filter((x) => x.via === 'atual')) expect(c.cabecalhos['dms-ligacao']).toBeUndefined();

    const desta = await doUltimo(agora);
    expect(desta.map((l) => [l.tool, l.outcome, l.retried])).toEqual(
      [
        'campanha_detalhar',
        'campanha_disparo_planejar',
        'campanhas_listar',
        'conta_situacao',
        'conversas_anuncio_listar',
        'integracao_situacao',
        'modelos_listar',
        'orcamento_ler',
        'publico_estimar',
        'publicos_listar',
      ].map((t) => [t, 'igual', false]),
    );

    // Na vez seguinte, usa a ligação e o token guardados: sem troca e sem pedir outro token.
    chamadas.length = 0;
    expect(await comparadora.executarLote(5, { tenantIds: [e.tenantId] }, mais(24 * 60 + 60))).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);
    expect([trocas, pedidosDeToken.length]).toEqual([1, 1]);
  });

  it('diferença de verdade: repete uma vez e fica "diferente", só com o caminho; o telefone da conversa nunca é guardado', async () => {
    const conversas = fixture('conversas-1.json') as { itens: Array<Record<string, unknown>> };
    naNova.set('conversas_anuncio_listar', { resposta: { ...conversas, itens: [{ ...conversas.itens[0], telefone: '+5521900000099' }, ...conversas.itens.slice(1)] } });
    try {
      const agora = mais(24 * 60 + 120);
      const r = await loop().executarLote(5, { tenantIds: [e.tenantId] }, agora);
      expect(r).toEqual([{ status: 'comparada', iguais: 9, diferentes: 1, outros: 0 }]);
      const linha = (await doUltimo(agora)).find((l) => l.tool === 'conversas_anuncio_listar')!;
      expect(linha).toMatchObject({ outcome: 'diferente', retried: true, differences: ['itens[0].telefone'] });
      const tudo = JSON.stringify(await ownerQuery(`select * from liame.credential_comparison where tenant_id = $1`, [e.tenantId]));
      expect(tudo).not.toContain('+5521900000099');
      expect(tudo).not.toContain('+5521988887777');
    } finally {
      naNova.delete('conversas_anuncio_listar');
    }
  });

  it('diferença que some na repetição (o dado mudou entre as duas leituras) conta como igual, marcada como repetida', async () => {
    const orcamento = respostas().orcamento_ler as Record<string, unknown>;
    naNova.set('orcamento_ler', { resposta: { ...orcamento, avisos: ['O teto do mês foi atingido.'] }, vezes: 1 });
    const agora = mais(24 * 60 + 180);
    expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, agora)).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);
    expect((await doUltimo(agora)).find((l) => l.tool === 'orcamento_ler')).toMatchObject({ outcome: 'igual', retried: true, differences: [] });
    naNova.delete('orcamento_ler');
  });

  it('o token do DMS ID recusado pelo RegemCast: a rotina esquece o guardado, pede outro uma vez e a comparação segue', async () => {
    const comparadora = loop();
    // Primeira vez: a rotina pede o token e o guarda.
    expect(await comparadora.executarLote(5, { tenantIds: [e.tenantId] }, mais(24 * 60 + 240))).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);
    // O RegemCast passa a recusar o token guardado (a chave do DMS ID trocou, por exemplo).
    for (const t of tokensDoDmsId) tokensRecusados.add(t);
    const antes = pedidosDeToken.length;
    const agora = mais(24 * 60 + 300);
    expect(await comparadora.executarLote(5, { tenantIds: [e.tenantId] }, agora)).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);
    expect(pedidosDeToken.length - antes).toBe(1);
    const desta = await doUltimo(agora);
    expect(desta.every((l) => l.outcome === 'igual')).toBe(true);
    // A leitura que esbarrou no token recusado repetiu com o novo.
    expect(desta.filter((l) => l.retried).length).toBeGreaterThan(0);
  });

  it('a ligação recusada pelo RegemCast sai do cofre e é trocada de novo na vez seguinte; a conta não é tocada', async () => {
    const guardada = await ligacaoNoCofre();
    for (const l of ligacoes.keys()) ligacoesRecusadas.add(l);
    const agora = mais(24 * 60 + 360);
    expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, agora)).toEqual([{ status: 'comparada', iguais: 0, diferentes: 10, outros: 0 }]);
    expect((await doUltimo(agora)).every((l) => l.outcome === 'nova_falhou' && l.failure === 'autenticacao:ligacao-invalida')).toBe(true);
    expect((await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [guardada.ligacao_secret_id]))[0]!.revogado).toBe(true);
    // A recusa da via nova não mexe na conta: ela segue conectada para a leitura de verdade.
    expect((await ownerQuery<{ status: string }>(`select status from liame.connected_account where id = $1`, [contaRegemcast]))[0]!.status).toBe('ativa');

    const trocasAntes = trocas;
    expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(24 * 60 + 420))).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);
    expect(trocas).toBe(trocasAntes + 1);
  });

  it('a troca que devolve a ligação de OUTRA conta não guarda nada: a comparação falha e conta como falha da troca', async () => {
    const guardada = await ligacaoNoCofre();
    // Sem ligação válida no cofre, a próxima vez troca; e o RegemCast de mentira responde com outra conta.
    await ownerQuery(`update liame.secret set revoked_at = now() where id = $1`, [guardada.ligacao_secret_id]);
    contaDaTroca = '00000000-0000-4000-8000-000000000999';
    try {
      const r = await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(24 * 60 + 480));
      expect(r).toEqual([{ status: 'falhou', erro: 'troca: definitivo' }]);
      expect((await ligacaoNoCofre()).ligacao_secret_id).toBe(guardada.ligacao_secret_id);
      const [estado] = await ownerQuery<{ last_error: string | null }>(`select last_error from liame.credential_comparison_state where connected_account_id = $1`, [contaRegemcast]);
      expect(estado!.last_error).toBe('troca: definitivo');
    } finally {
      contaDaTroca = null;
    }
  });

  it('reconectada com outro rct_it_, a ligação guardada não serve: a rotina troca de novo com o token novo e revoga a antiga', async () => {
    const antiga = await ligacaoNoCofre();
    const conexao = await registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: loadConfig() }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regemcast', tokens: [TOKEN_NOVO] });
    const religada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(religada.status, JSON.stringify(religada.body)).toBe(200);
    const trocasAntes = trocas;
    expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(24 * 60 + 540))).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);
    expect(trocas).toBe(trocasAntes + 1);
    expect([...ligacoes.values()].at(-1)).toBe(TOKEN_NOVO);
    expect((await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [antiga.ligacao_secret_id]))[0]!.revogado).toBe(true);
  });

  it('a conta que a plataforma recusou (desconectada, ainda ligada) não é comparada', async () => {
    await ownerQuery(`update liame.connected_account set status = 'desconectada' where id = $1`, [contaRegemcast]);
    chamadas.length = 0;
    try {
      expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(3 * 24 * 60))).toEqual([]);
      expect(chamadas).toEqual([]);
    } finally {
      await ownerQuery(`update liame.connected_account set status = 'ativa' where id = $1`, [contaRegemcast]);
    }
  });

  it('mudou depois da reserva (recusada pela plataforma ou desligada): a releitura usa o mesmo critério, não lê o cofre nem chama ninguém, e a vez volta no dia seguinte', async () => {
    await ownerQuery(`insert into liame.credential_comparison_state (connected_account_id, tenant_id) values ($1, $2) on conflict (connected_account_id) do nothing`, [contaRegemcast, e.tenantId]);
    const [segredos] = await ownerQuery<{ credential_secret_id: string; ligacao_secret_id: string | null }>(
      `select credential_secret_id, ligacao_secret_id from liame.connected_account where id = $1`,
      [contaRegemcast],
    );
    const mudancas = [`update liame.connected_account set status = 'desconectada' where id = $1`, `update liame.connected_account set disconnected_at = now() where id = $1`];
    const leitura = vi.spyOn(api.app.get(VaultService), 'readSecret');
    try {
      for (const [i, mudanca] of mudancas.entries()) {
        await ownerQuery(mudanca, [contaRegemcast]);
        chamadas.length = 0;
        leitura.mockClear();
        const tokensAntes = pedidosDeToken.length;
        const agora = mais(3 * 24 * 60 + 60 * (i + 1));
        expect(await loop().compararConta(database.db, contaRegemcast, e.tenantId, agora)).toEqual({ status: 'ignorada' });
        expect(chamadas).toEqual([]);
        expect(pedidosDeToken.length).toBe(tokensAntes);
        expect(leitura.mock.calls.filter(([, id]) => id === segredos!.credential_secret_id || id === segredos!.ligacao_secret_id)).toEqual([]);
        const [estado] = await ownerQuery<{ last_error: string | null; dia_seguinte: boolean }>(
          `select last_error, next_at = $2::timestamptz + make_interval(mins => 1440) as dia_seguinte from liame.credential_comparison_state where connected_account_id = $1`,
          [contaRegemcast, agora.toISOString()],
        );
        expect(estado).toEqual({ last_error: 'a conta não está conectada', dia_seguinte: true });
        await ownerQuery(`update liame.connected_account set status = 'ativa', disconnected_at = null where id = $1`, [contaRegemcast]);
      }
    } finally {
      leitura.mockRestore();
      await ownerQuery(`update liame.connected_account set status = 'ativa', disconnected_at = null where id = $1`, [contaRegemcast]);
    }
  });

  it('as restrições das tabelas novas (V119): o que passa e o que não passa, pelo nome da restrição', async () => {
    const inserir = (over: Record<string, unknown>) =>
      ownerQuery(
        `insert into liame.credential_comparison (id, tenant_id, connected_account_id, tool, outcome, differences, failure, duration_ms)
         values (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [e.tenantId, contaRegemcast, over.tool ?? 'orcamento_ler', over.outcome ?? 'igual', JSON.stringify(over.differences ?? []), over.failure ?? null, over.duration_ms ?? 10],
      ).then(
        () => null,
        (err: { constraint?: string }) => err.constraint ?? 'outro erro',
      );
    expect(await inserir({})).toBeNull();
    expect(await inserir({ tool: 'Orcamento-Ler' })).toBe('credential_comparison_ferramenta');
    expect(await inserir({ outcome: 'talvez' })).toBe('credential_comparison_desfecho');
    expect(await inserir({ differences: Array.from({ length: 21 }, (_, i) => `c${i}`) })).toBe('credential_comparison_caminhos');
    expect(await inserir({ failure: 'x'.repeat(201) })).toBe('credential_comparison_falha_curta');
    expect(await inserir({ duration_ms: -1 })).toBe('credential_comparison_duracao');
    const estado = await ownerQuery(`update liame.credential_comparison_state set last_error = $2 where connected_account_id = $1`, [contaRegemcast, 'x'.repeat(301)]).then(
      () => null,
      (err: { constraint?: string }) => err.constraint ?? 'outro erro',
    );
    expect(estado).toBe('credential_comparison_state_erro_curto');
    // E a outra empresa não lê as comparações desta (RLS forçada).
    const outra = randomUUID();
    const vistas = await withTenant(database.db, outra, async (tx) => (await tx.execute(sql`select count(*)::int as n from liame.credential_comparison`)).rows[0] as { n: number });
    expect(vistas.n).toBe(0);
  });

  it('desligar a conta tira do cofre o segredo da ligação', async () => {
    const guardada = await ligacaoNoCofre();
    expect(guardada.ligacao_secret_id).not.toBeNull();
    const r = await api.call('DELETE', `/v1/connected-accounts/${contaRegemcast}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect((await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [guardada.ligacao_secret_id]))[0]!.revogado).toBe(true);
    expect((await linhas()).length).toBeGreaterThan(0);
  });

  it('revogar a autorização tira do cofre os segredos das ligações das contas dela', async () => {
    // A conta ligada de novo (outra linha, porque a anterior foi desligada) ganha a ligação na primeira comparação.
    const conexao = await registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: loadConfig() }, { tenantId: e.tenantId, brandId: e.brandId, produto: 'regemcast', tokens: [TOKEN] });
    const ligada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'regemcast', external_id: situacao.contaId }] } });
    expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
    contaRegemcast = ligada.body.linked[0].id as string;
    expect(await loop().executarLote(5, { tenantIds: [e.tenantId] }, mais(4 * 24 * 60))).toEqual([{ status: 'comparada', iguais: 10, diferentes: 0, outros: 0 }]);
    const guardada = await ligacaoNoCofre();
    expect(guardada).toMatchObject({ purpose: 'ligacao_regemcast', revogado: false });

    const r = await api.call('DELETE', `/v1/connections/${conexao.connectionId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect((await ownerQuery<{ revogado: boolean }>(`select revoked_at is not null as revogado from liame.secret where id = $1`, [guardada.ligacao_secret_id]))[0]!.revogado).toBe(true);
  });
});
