import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Database } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MotivoDaMensagem } from '../../src/ai/crm/mensagem.js';
import { proximaOlhada, type ResultadoDoOlhar } from '../../src/mensageria/rotina-do-crm.js';
import type { Escrita, EscritaDoCrmService } from '../../src/worker/escrita-do-crm.service.js';
import type { RotinaDoCrmLoop } from '../../src/worker/rotina-do-crm-loop.js';
import type { Olhada, RotinaDoCrmService } from '../../src/worker/rotina-do-crm.service.js';
import type { TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// A5 · Y6, parte 6b: a rotina do funcionário de CRM e mensageria olha cada marca e abre a proposta quando há motivo
// (migration 0064, a fila do olhar), e depois ele escreve a mensagem da proposta, que o código confere. Contra um
// RegemCast falso que fala o MCP sem estado (os públicos, só com a contagem, e o teto de gasto de mensagens) e com o
// modelo de IA simulado (nenhum fornecedor é chamado). A conta do RegemCast entra pelo caminho de verdade (a conexão
// da distribuição e a rota de ligar a conta), o desconto e o dossiê pelas rotas; a loja do Regem entra direto no banco
// (a conexão de verdade está provada em `regem-conexao.spec.ts`). O app e os ajudantes entram por `import()` dentro do
// `beforeAll`, depois de o endereço do RegemCast falso estar no ambiente.

const TODAS = ['conta.ler', 'campanhas.ler', 'publicos.ler', 'modelos.ler', 'orcamento.ler'];
const OFERTAS = ['Combo sexta: smash, batata e refri por R$ 34,90', 'Milk-shake de 400 ml por R$ 16,90 na terça'];
const PERFIS = [
  { id: 'fieis', nome: 'Fiéis', regra: '4+ pedidos, última compra entre 31 e 90 dias.', pessoas: 120 },
  { id: 'novos', nome: 'Novos', regra: 'Fez o primeiro pedido nos últimos 30 dias.', pessoas: 310 },
  { id: 'em_risco', nome: 'Em risco', regra: '2 a 3 pedidos, sumiu há 91 a 180 dias.', pessoas: 75 },
  { id: 'nao_posso_perder', nome: 'Não posso perder', regra: '4+ pedidos, mas sumiu há 91 a 180 dias.', pessoas: 22 },
  { id: 'perdidos', nome: 'Perdidos', regra: 'Sem comprar há mais de 180 dias.', pessoas: 900 },
];
const HORA = 3_600_000;
const DIA = 24 * HORA;

type Perfil = { id: string; nome: string; regra: string | null; pessoas: number };
type ContaFalsa = { contaId: string; permissoes: string[]; perfis: Perfil[]; sinal: string; modo: 'ok' | 'erro_interno' };
type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; token: string; conta: string; loja: string };
type Proposta = {
  id: string;
  status: string;
  motive: string;
  destination: string;
  offer: string | null;
  dossier_version: number | null;
  audience: { origem: string; id: string };
  audience_name: string;
  audience_rule: string | null;
  people: number;
  coupon: Record<string, unknown>;
  agent_key: string;
  requested_by: string | null;
  connected_account_id: string;
  name: string | null;
};
type Linha = { motive: string; outcome: string | null; checked_at: Date | null; next_check_at: Date };
type Guardada = {
  id: string;
  status: string;
  motive: string;
  reason: string | null;
  barred_by: string[] | null;
  name: string | null;
  body: string | null;
  usage_id: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
};
const MIN = 60_000;
/** O que o funcionário escreve quando escreve certo: o preço da oferta, o benefício e a validade do cupom, como vieram. */
const BOA = 'Oi, {{1}}! Sexta é dia de combo: smash, batata e refri por R$ 34,90. Com o cupom {{2}} você ganha 10% de desconto, válido por 2 dias, contando hoje. Peça pelo cardápio.';
const VOLTE = 'Oi, {{1}}! Faz um tempo que a gente não se vê. Com o cupom {{2}} você ganha 10% de desconto, válido por 2 dias, contando hoje. Peça pelo cardápio.';

describe.skipIf(!hasDb)('a rotina do CRM e mensageria olha a marca e abre a proposta (A5 · Y6, parte 6b)', () => {
  let api: TestApi;
  let database: Database;
  let regemcast: Server;
  let servico: RotinaDoCrmService;
  let escrita: EscritaDoCrmService;
  let loop: RotinaDoCrmLoop;
  let Loop: typeof import('../../src/worker/rotina-do-crm-loop.js').RotinaDoCrmLoop;
  let ia: typeof import('../helpers/ia.js');
  let modelos: import('../helpers/ia.js').ModelosDeTeste;
  let rota: { provider: string; model: string };
  let ajuda: typeof import('../helpers/api.js');
  let ownerQuery: typeof import('../helpers/api.js').ownerQuery;
  let registrar: typeof import('../../src/connections/distribuicao.js').registrarConexaoDaDistribuicao;
  let deps: Parameters<typeof import('../../src/connections/distribuicao.js').registrarConexaoDaDistribuicao>[0];
  let invalidarFlags: () => void;
  const anterior: Record<string, string | undefined> = {};

  // ---------------------------------------------------------------- o RegemCast falso
  const contas = new Map<string, ContaFalsa>();
  const chamadas: Array<{ token: string; ferramenta: string }> = [];
  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const recusada = (texto: string) => ({ result: { content: [{ type: 'text', text: texto }], isError: true, resultType: 'complete' } });

  function responder(credencial: string, corpo: { id?: unknown; params?: { name?: string } }): { status: number; corpo: unknown } {
    const conta = contas.get(credencial);
    if (!conta) return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
    const nome = corpo.params?.name ?? '';
    chamadas.push({ token: credencial, ferramenta: nome });
    const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
    const ok = (sc: unknown) => ({ status: 200, corpo: comId(resultado(sc)) });
    const semFerramenta = { status: 200, corpo: comId({ error: { code: -32602, message: `Tool ${nome} not found` } }) };
    if (nome === 'integracao_situacao') {
      return ok({ contaId: conta.contaId, conta: 'Mister Burgers', fuso: 'America/Sao_Paulo', produto: 'liame', classe: 'dms', token: 'Liame — piloto', permissoes: conta.permissoes.map((id) => ({ id, rotulo: id, descricao: '' })), limitePorMinuto: 60 });
    }
    if (nome === 'publicos_listar') {
      if (!conta.permissoes.includes('publicos.ler')) return semFerramenta;
      if (conta.modo === 'erro_interno') return { status: 200, corpo: comId(recusada('Erro interno ao ler os públicos.')) };
      return ok({ listas: [], publicos: [], perfis: conta.perfis });
    }
    if (nome === 'orcamento_ler') {
      if (!conta.permissoes.includes('orcamento.ler')) return semFerramenta;
      return ok({
        moeda: 'BRL',
        tetos: { dia: null, semana: null, mes: 30_000 },
        periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: conta.sinal === 'cheio' ? 30_000 : 12_736, percentual: conta.sinal === 'cheio' ? 100 : 42.5, texto: 'do teto do mês', sinal: conta.sinal }],
        avisos: [],
      });
    }
    return semFerramenta;
  }

  // ---------------------------------------------------------------- ajudantes
  async function ligarFlag(tenantId: string, flag: string, valor: boolean): Promise<void> {
    await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [flag, tenantId]);
    if (valor) await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, tenantId]);
    invalidarFlags();
  }
  const dossie = (ofertas: string[]) => ({
    identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
    voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
    products: { items: ['Smash Clássico R$ 29,90'] },
    offers: { items: ofertas },
    forbidden: { items: [] },
    competitors: { items: [] },
    region: { area: 'Centro e Lapa', pickup: true },
  });
  async function salvarDossie(e: Empresa, ofertas: string[], base = 0): Promise<void> {
    const r = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: base, content: dossie(ofertas) } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  async function definirDesconto(e: Empresa, corpo: Record<string, unknown> = { kind: 'percentual', percent: 10, valid_days: 2 }, cookie = e.cookie): Promise<void> {
    const r = await api.call('PUT', '/v1/messaging/discount', { cookie, body: { brand_id: e.brandId, ...corpo } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  /**
   * Uma empresa com o RegemCast conectado pelo caminho de verdade, uma loja do Regem que cria cupom, as cinco chaves
   * ligadas e, a pedido, o desconto e o dossiê. `sem` deixa de fora o que o teste quer ver faltando.
   */
  async function empresa(sem: Array<'regemcast' | 'loja' | 'desconto' | 'dossie' | 'cardapio' | 'crm'> = []): Promise<Empresa> {
    await ajuda.resetIpRateLimits();
    const s = await ajuda.signupAndLogin(api, undefined, 'Hamburgueria da Rotina do CRM');
    await ajuda.enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const token = `rct_it_${randomBytes(33).toString('base64url').slice(0, 43)}`;
    let conta = '';
    if (!sem.includes('regemcast')) {
      const contaId = randomUUID();
      contas.set(token, { contaId, permissoes: TODAS, perfis: PERFIS, sinal: 'ok', modo: 'ok' });
      const conexao = await registrar(deps, { tenantId, brandId, produto: 'regemcast', tokens: [token] });
      const ligada = await api.call('POST', `/v1/connections/${conexao.connectionId}/accounts`, { cookie: s.cookie, body: { accounts: [{ provider: 'regemcast', external_id: contaId }] } });
      expect(ligada.status, JSON.stringify(ligada.body)).toBe(200);
      conta = ligada.body.linked[0].id as string;
    }
    const loja = randomUUID();
    if (!sem.includes('loja')) {
      await ownerQuery(
        `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, provider_attributes)
         values ($1, $2, $3, 'regem', $4, 'Mister Burgers — Centro', 'BRL', 'America/Sao_Paulo', $5::jsonb)`,
        [loja, tenantId, brandId, randomUUID(), JSON.stringify({ escopos: ['pedidos.ler', 'cupons.ler', 'cupons.criar'], cardapio_url: sem.includes('cardapio') ? null : 'https://cardapio.exemplo.test/mister' })],
      );
    }
    const e: Empresa = { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, token, conta, loja };
    for (const flag of ['ia', 'crm', 'mensageria', 'whatsapp_campaign', 'regem_write']) if (!(flag === 'crm' && sem.includes('crm'))) await ligarFlag(tenantId, flag, true);
    if (!sem.includes('loja') && !sem.includes('desconto')) await definirDesconto(e);
    if (!sem.includes('dossie')) await salvarDossie(e, OFERTAS);
    chamadas.length = 0;
    return e;
  }
  const olhar = (e: Empresa, motivo: MotivoDaMensagem, agora = new Date()): Promise<Olhada> => servico.olhar({ tenantId: e.tenantId, brandId: e.brandId, motivo }, agora);
  const propostas = (e: Empresa) =>
    ownerQuery<Proposta>(
      `select id, status, motive, destination, offer, dossier_version, audience, audience_name, audience_rule, people, coupon, agent_key, requested_by, connected_account_id, name
         from liame.message_proposal where tenant_id = $1 order by created_at, id`,
      [e.tenantId],
    );
  const fila = (e: Empresa) => ownerQuery<Linha>(`select motive, outcome, checked_at, next_check_at from liame.message_routine where tenant_id = $1 order by motive`, [e.tenantId]);
  const doToken = (e: Empresa) => chamadas.filter((c) => c.token === e.token).map((c) => c.ferramenta).sort();
  /** O dia de hoje no fuso da marca, como o banco o calcula. */
  const hojeEm = async (fuso: string, mais = 0) => (await ownerQuery<{ dia: string }>(`select ((now() at time zone $1)::date + $2::int)::text as dia`, [fuso, mais]))[0]!.dia;

  // ---------------------------------------------------------------- a escrita: o modelo simulado e a fila
  const modelo = (mock: MockLanguageModelV4) => {
    modelos.porChave.set(`${rota.provider}/${rota.model}`, mock);
    return mock;
  };
  /** O modelo simulado passa a devolver esta resposta. */
  const comResposta = (resposta: Record<string, unknown>) => modelo(ia.responde(JSON.stringify(resposta), ia.uso(2000, 300)));
  const enviado = (mock: MockLanguageModelV4, n = 0) => JSON.stringify(mock.doGenerateCalls[n]!.prompt);
  const escrever = (e: Empresa, agora = new Date()) => loop.escreverLote(5, { tenantIds: [e.tenantId] }, agora);
  const guardadas = (e: Empresa) =>
    ownerQuery<Guardada>(
      `select id, status, motive, reason, barred_by, name, body, usage_id, attempts, next_attempt_at, created_at from liame.message_proposal where tenant_id = $1 order by created_at, id`,
      [e.tenantId],
    );
  const trilha = (e: Empresa, acao: string) => ownerQuery<{ resource_id: string; after: Record<string, unknown> }>(`select resource_id, "after" from liame.audit_event where tenant_id = $1 and action = $2 order by chain_seq`, [e.tenantId, acao]);
  const recusas = (e: Empresa) => ownerQuery<{ member: string; workflow: string; kind: string; rules: string[]; items: number }>(`select member, workflow, kind, rules, items from liame.ai_refusal where tenant_id = $1 order by created_at, id`, [e.tenantId]);

  beforeAll(async () => {
    const { runMigrations } = await import('@liame/database');
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    regemcast = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (d: Buffer) => partes.push(d));
      req.on('end', () => {
        let r: { status: number; corpo: unknown };
        try {
          const corpo = JSON.parse(Buffer.concat(partes).toString('utf8') || '{}') as { id?: unknown; method?: string; params?: { name?: string } };
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
    await new Promise<void>((ok) => regemcast.listen(0, '127.0.0.1', ok));
    anterior.REGEMCAST_API_URL = process.env.REGEMCAST_API_URL;
    process.env.REGEMCAST_API_URL = `http://127.0.0.1:${(regemcast.address() as AddressInfo).port}/cast`;

    ajuda = await import('../helpers/api.js');
    ({ ownerQuery } = ajuda);
    api = await ajuda.startApi();
    const [{ FlagService }, distribuicao, { VaultService }, { loadConfig }, { DATABASE }, { ResultsService }, { RotinaDoCrmService: Servico }, doLoop, { EscritaDoCrmService: DaEscrita }, { AiGateway }, { ModelosIa }, doTeste] =
      await Promise.all([
        import('../../src/flags/flag.service.js'),
        import('../../src/connections/distribuicao.js'),
        import('../../src/vault/vault.service.js'),
        import('../../src/config.js'),
        import('../../src/database/database.module.js'),
        import('../../src/results/results.service.js'),
        import('../../src/worker/rotina-do-crm.service.js'),
        import('../../src/worker/rotina-do-crm-loop.js'),
        import('../../src/worker/escrita-do-crm.service.js'),
        import('../../src/ai/gateway.js'),
        import('../../src/ai/modelos.js'),
        import('../helpers/ia.js'),
      ]);
    ia = doTeste;
    database = api.app.get<Database>(DATABASE);
    const flags = api.app.get(FlagService);
    invalidarFlags = () => flags.invalidate();
    registrar = distribuicao.registrarConexaoDaDistribuicao;
    deps = { db: database.db, vault: api.app.get(VaultService), config: loadConfig() };
    // O modelo de IA é o simulado: nenhum fornecedor é chamado.
    modelos = new ia.ModelosDeTeste(loadConfig());
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    servico = new Servico(database, loadConfig(), flags, api.app.get(VaultService), api.app.get(ResultsService));
    escrita = new DaEscrita(database, flags, api.app.get(AiGateway), api.app.get(ResultsService));
    Loop = doLoop.RotinaDoCrmLoop;
    loop = new Loop(database, servico, escrita);
    // A rota desta tarefa pode ser dividida com outro arquivo de teste: nome fixo, ninguém apaga (V76).
    rota = await ia.rotaCompartilhada(modelos, 'crm_mensagem', new MockLanguageModelV4({ doGenerate: [] }));
  }, 120_000);
  beforeEach(() => {
    chamadas.length = 0;
  });
  afterAll(async () => {
    for (const [nome, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
    await api?.close();
    await new Promise((ok) => regemcast?.close(ok));
  });

  it('com motivo, ele abre a proposta: a oferta da vez, o perfil com mais gente, o cupom do desconto padrão e a auditoria; nada vai para o RegemCast', async () => {
    const e = await empresa();
    const olhada = await olhar(e, 'promocao');
    expect(olhada.resultado).toBe('proposta_aberta');
    const [p] = await propostas(e);
    expect(p).toMatchObject({
      id: olhada.proposta,
      status: 'preparando',
      motive: 'promocao',
      // A loja do Regem tem cardápio online: a mensagem manda pedir por ele.
      destination: 'cardapio',
      offer: OFERTAS[0],
      dossier_version: 1,
      audience: { origem: 'perfil', id: 'novos' },
      audience_name: 'Novos',
      audience_rule: 'Fez o primeiro pedido nos últimos 30 dias.',
      people: 310,
      agent_key: 'crm',
      // Quem responde pela proposta é quem definiu o desconto.
      requested_by: e.userId,
      connected_account_id: e.conta,
      // Ele ainda não escreveu nada.
      name: null,
    });
    // O cupom: o desconto padrão (10%, 2 dias contando hoje), na loja que cria cupom, com o código sorteado.
    const codigo = String(p!.coupon.codigo);
    expect(codigo).toMatch(/^PROMO[A-HJ-NP-Z2-9]{4}$/);
    expect(p!.coupon).toEqual({ loja: e.loja, codigo, tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: await hojeEm('America/Sao_Paulo'), valido_ate: await hojeEm('America/Sao_Paulo', 1) });
    // Do RegemCast, só leituras: os públicos e o teto. Nenhuma ferramenta de escrita.
    expect(doToken(e)).toEqual(['orcamento_ler', 'publicos_listar']);
    // A auditoria, em nome do funcionário, sem a oferta e sem o nome do público.
    const trilha = await ownerQuery<{ actor_type: string; actor_label: string; resource_id: string; after: Record<string, unknown> }>(
      `select actor_type, actor_label, resource_id, "after" from liame.audit_event where tenant_id = $1 and action = 'mensagem.preparar'`,
      [e.tenantId],
    );
    expect(trilha).toEqual([
      {
        actor_type: 'agent',
        actor_label: 'CRM e mensageria',
        resource_id: p!.id,
        after: { motive: 'promocao', destination: 'cardapio', dossier_version: 1, audience: 'novos', people: 310, coupon_code: codigo, agent_key: 'crm', on_behalf_of: e.userId },
      },
    ]);

    // De novo, no dia seguinte: a marca tem uma proposta de promoção no caminho, e ele nem chama o RegemCast.
    chamadas.length = 0;
    expect(await olhar(e, 'promocao', new Date(Date.now() + DIA))).toEqual({ resultado: 'em_andamento' });
    expect(doToken(e)).toEqual([]);

    // O "volte a pedir" é outra proposta: sem oferta, para quem sumiu, com outro código.
    expect((await olhar(e, 'volte_a_pedir')).resultado).toBe('proposta_aberta');
    const volte = (await propostas(e)).find((x) => x.motive === 'volte_a_pedir')!;
    expect(volte).toMatchObject({ status: 'preparando', offer: null, dossier_version: null, audience: { origem: 'perfil', id: 'em_risco' }, audience_name: 'Em risco', people: 75, requested_by: e.userId });
    expect(String(volte.coupon.codigo)).toMatch(/^VOLTE[A-HJ-NP-Z2-9]{4}$/);
    expect(await propostas(e)).toHaveLength(2);
  });

  it('o intervalo conta da última proposta, e a oferta que já virou mensagem dá a vez à seguinte', async () => {
    const e = await empresa(['cardapio']);
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
    const [primeira] = await propostas(e);
    // Sem cardápio online na loja, a pessoa pede respondendo a mensagem.
    expect(primeira).toMatchObject({ offer: OFERTAS[0], destination: 'whatsapp' });
    // A proposta acabou (descartada). Dois dias depois, ainda não passou uma semana: ele não propõe, e diz até quando.
    await ownerQuery(`update liame.message_proposal set status = 'descartada', reason = 'prazo', finished_at = now() where id = $1`, [primeira!.id]);
    const nascida = (await ownerQuery<{ created_at: Date }>(`select created_at from liame.message_proposal where id = $1`, [primeira!.id]))[0]!.created_at;
    chamadas.length = 0;
    const cedo = await olhar(e, 'promocao', new Date(nascida.getTime() + 2 * DIA));
    expect(cedo).toEqual({ resultado: 'intervalo', ate: new Date(nascida.getTime() + 7 * DIA) });
    expect(doToken(e)).toEqual([]);
    // O "volte a pedir" tem o intervalo dele: a promoção recente não o segura.
    expect((await olhar(e, 'volte_a_pedir', new Date(nascida.getTime() + 2 * DIA))).resultado).toBe('proposta_aberta');
    // Passada a semana, ele propõe de novo, com a oferta seguinte: a primeira virou mensagem há menos de 30 dias.
    const depois = await olhar(e, 'promocao', new Date(nascida.getTime() + 7 * DIA));
    expect(depois.resultado).toBe('proposta_aberta');
    const segunda = (await propostas(e)).find((p) => p.id === depois.proposta)!;
    expect(segunda).toMatchObject({ motive: 'promocao', offer: OFERTAS[1], status: 'preparando' });
    expect(segunda.coupon.codigo).not.toBe(primeira!.coupon.codigo);
    // As duas ofertas viraram mensagem há pouco: depois de mais uma semana, não há o que divulgar.
    await ownerQuery(`update liame.message_proposal set status = 'descartada', reason = 'prazo', finished_at = now() where id = $1`, [segunda.id]);
    expect(await olhar(e, 'promocao', new Date(Date.now() + 8 * DIA))).toEqual({ resultado: 'sem_oferta' });
  });

  it('com uma chave desligada, o funcionário desligado ou a marca arquivada, ele nem olha', async () => {
    const e = await empresa();
    const caso = async (flag: string, esperado: ResultadoDoOlhar) => {
      await ligarFlag(e.tenantId, flag, false);
      expect(await olhar(e, 'promocao'), flag).toEqual({ resultado: esperado });
      await ligarFlag(e.tenantId, flag, true);
    };
    await caso('ia', 'ia_desligada');
    await caso('crm', 'crm_desligado');
    await caso('mensageria', 'mensageria_desligada');
    await caso('whatsapp_campaign', 'envio_desligado');
    // A escrita no Regem desligada: o cupom nunca nasceria, e a mensagem com cupom não sairia.
    await caso('regem_write', 'sem_loja_do_cupom');
    // Desligado pela empresa, em Sua equipe.
    const pausa = await api.call('POST', '/v1/team/members/crm/pause', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(pausa.status, JSON.stringify(pausa.body)).toBe(200);
    expect(await olhar(e, 'volte_a_pedir')).toEqual({ resultado: 'funcionario_desligado' });
    const volta = await api.call('POST', '/v1/team/members/crm/resume', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(volta.status, JSON.stringify(volta.body)).toBe(200);
    // Nada disso chamou o RegemCast nem abriu proposta.
    expect(doToken(e)).toEqual([]);
    expect(await propostas(e)).toEqual([]);
    await ownerQuery(`update liame.brand set archived_at = now() where id = $1`, [e.brandId]);
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'marca_arquivada' });
  });

  it('o que falta para propor, um de cada vez: o desconto, a loja do cupom, o dossiê, a oferta e o RegemCast', async () => {
    const e = await empresa(['desconto', 'dossie']);
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'sem_desconto' });
    await definirDesconto(e);
    // Minha marca ainda sem dossiê: ele não tem como escrever na voz da marca.
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'sem_dossie' });
    expect(await olhar(e, 'volte_a_pedir')).toEqual({ resultado: 'sem_dossie' });
    // Só uma oferta de bebida alcoólica: não há o que divulgar, e ela não vira proposta para ser recusada depois.
    await salvarDossie(e, ['Chope em dobro na quinta']);
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'sem_oferta' });
    expect(doToken(e)).toEqual([]);
    // A loja do cupom deixou de criar cupom (a autorização mudou no Regem), ou foi desconectada.
    await ownerQuery(`update liame.connected_account set provider_attributes = jsonb_set(provider_attributes, '{escopos}', '["pedidos.ler"]'::jsonb) where id = $1`, [e.loja]);
    expect(await olhar(e, 'volte_a_pedir')).toEqual({ resultado: 'sem_loja_do_cupom' });
    await ownerQuery(`update liame.connected_account set provider_attributes = jsonb_set(provider_attributes, '{escopos}', '["pedidos.ler","cupons.criar"]'::jsonb), disconnected_at = now() where id = $1`, [e.loja]);
    expect(await olhar(e, 'volte_a_pedir')).toEqual({ resultado: 'sem_loja_do_cupom' });
    await ownerQuery(`update liame.connected_account set disconnected_at = null where id = $1`, [e.loja]);
    // O RegemCast desconectado.
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.conta]);
    expect(await olhar(e, 'volte_a_pedir')).toEqual({ resultado: 'sem_regemcast' });
    expect(doToken(e)).toEqual([]);
    expect(await propostas(e)).toEqual([]);
  });

  it('o que o RegemCast diz: sem público, o teto cheio, fora do ar, sem autorização e sem permissão', async () => {
    const e = await empresa();
    const conta = contas.get(e.token)!;
    // Nenhum perfil do motivo chega a 10 pessoas ("Perdidos" tem 900 e não entra).
    conta.perfis = PERFIS.map((p) => (p.id === 'perdidos' ? p : { ...p, pessoas: 9 }));
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'sem_publico' });
    expect(await olhar(e, 'volte_a_pedir')).toEqual({ resultado: 'sem_publico' });
    conta.perfis = PERFIS;
    // O teto de gasto de mensagens do mês está cheio: ele não propõe (P16).
    conta.sinal = 'cheio';
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'teto_cheio' });
    conta.sinal = 'atencao';
    conta.modo = 'erro_interno';
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'regemcast_fora' });
    conta.modo = 'ok';
    conta.permissoes = TODAS.filter((p) => p !== 'publicos.ler');
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'sem_permissao' });
    conta.permissoes = TODAS;
    // O token foi revogado no RegemCast.
    contas.delete(e.token);
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'sem_autorizacao' });
    expect(await propostas(e)).toEqual([]);
    // Com tudo de volta (o teto em "atenção" não impede), ele propõe.
    contas.set(e.token, conta);
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
  });

  it('quem responde pela proposta é quem definiu o desconto: se essa pessoa saiu ou não pode mais, ele não propõe', async () => {
    const e = await empresa(['desconto']);
    // Um Administrador define o desconto.
    const email = ajuda.uniqueEmail('admin');
    const convite = await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: 'administrador', approve_limit_micros: 50_000_000 } });
    expect(convite.status, JSON.stringify(convite.body)).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: ajuda.tokenFrom(api.mailer, email), name: 'Pessoa Administradora', password: ajuda.PASSWORD, terms_version: ajuda.TERMOS } });
    expect(s.status, JSON.stringify(s.body)).toBeLessThan(300);
    await ajuda.enableMfa(api, s.cookie!);
    await definirDesconto(e, { kind: 'frete_gratis', min_order_cents: 4000, valid_days: 3 }, s.cookie!);
    const admin = (await ownerQuery<{ updated_by: string }>(`select updated_by from liame.message_discount where tenant_id = $1`, [e.tenantId]))[0]!.updated_by;
    expect(admin).not.toBe(e.userId);
    // O vínculo dela foi revogado: a proposta não tem quem responda.
    await ownerQuery(`update liame.membership set revoked_at = now() where tenant_id = $1 and user_id = $2`, [e.tenantId, admin]);
    expect(await olhar(e, 'promocao')).toEqual({ resultado: 'sem_responsavel' });
    expect(doToken(e)).toEqual([]);
    // De volta à empresa, a proposta sai em nome dela, com o desconto que ela definiu.
    await ownerQuery(`update liame.membership set revoked_at = null where tenant_id = $1 and user_id = $2`, [e.tenantId, admin]);
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
    const [p] = await propostas(e);
    expect(p).toMatchObject({ requested_by: admin });
    expect(p!.coupon).toMatchObject({ tipo: 'frete_gratis', pedido_minimo_centavos: 4000, valido_de: await hojeEm('America/Sao_Paulo'), valido_ate: await hojeEm('America/Sao_Paulo', 2) });
    expect(p!.coupon).not.toHaveProperty('percentual');
  });

  it('a fila do olhar: a marca com o RegemCast ganha as duas linhas, cada olhada deixa registro e marca a próxima', async () => {
    const e = await empresa(['crm']);
    const semRegemcast = await empresa(['regemcast']);
    const escopo = { tenantIds: [e.tenantId, semRegemcast.tenantId] };
    const agora = new Date();
    const vezes = await loop.olharLote(10, escopo, agora);
    // Só a marca com o RegemCast conectado entra na fila, uma linha por tipo de mensagem.
    expect(vezes.map((v) => [v.tenantId, v.motivo, v.resultado]).sort()).toEqual([
      [e.tenantId, 'promocao', 'crm_desligado'],
      [e.tenantId, 'volte_a_pedir', 'crm_desligado'],
    ]);
    expect(await fila(semRegemcast)).toEqual([]);
    const amanha = proximaOlhada('crm_desligado', agora);
    expect(await fila(e)).toEqual([
      { motive: 'promocao', outcome: 'crm_desligado', checked_at: agora, next_check_at: amanha },
      { motive: 'volte_a_pedir', outcome: 'crm_desligado', checked_at: agora, next_check_at: amanha },
    ]);
    // Antes da hora, nada é reservado; e a volta não cria linha de novo.
    expect(await loop.olharLote(10, escopo, new Date(agora.getTime() + 23 * HORA))).toEqual([]);
    expect(await fila(e)).toHaveLength(2);

    // No dia seguinte, com a chave ligada: as duas propostas, pela fila.
    await ligarFlag(e.tenantId, 'crm', true);
    const depois = new Date(agora.getTime() + DIA);
    const segunda = await loop.olharLote(10, escopo, depois);
    expect(segunda.map((v) => [v.motivo, v.resultado]).sort()).toEqual([
      ['promocao', 'proposta_aberta'],
      ['volte_a_pedir', 'proposta_aberta'],
    ]);
    expect((await propostas(e)).map((p) => p.id).sort()).toEqual(segunda.map((v) => v.proposta).sort());
    expect((await fila(e)).map((l) => [l.outcome, l.next_check_at])).toEqual([
      ['proposta_aberta', new Date(depois.getTime() + DIA)],
      ['proposta_aberta', new Date(depois.getTime() + DIA)],
    ]);
  });

  it('quatro voltas ao mesmo tempo olham cada linha uma vez só, e o limite do lote é respeitado', async () => {
    const e = await empresa(['crm']);
    const escopo = { tenantIds: [e.tenantId] };
    const agora = new Date();
    const voltas = await Promise.all([1, 2, 3, 4].map(() => loop.olharLote(10, escopo, agora)));
    expect(voltas.flat().map((v) => v.motivo).sort()).toEqual(['promocao', 'volte_a_pedir']);
    // Um lote de uma linha pega a mais atrasada; a outra fica para a volta seguinte.
    const depois = new Date(agora.getTime() + 2 * DIA);
    await ownerQuery(`update liame.message_routine set next_check_at = $2 where tenant_id = $1 and motive = 'volte_a_pedir'`, [e.tenantId, new Date(agora.getTime() + HORA)]);
    const uma = await loop.olharLote(1, escopo, depois);
    expect(uma.map((v) => v.motivo)).toEqual(['volte_a_pedir']);
    expect((await loop.olharLote(1, escopo, depois)).map((v) => v.motivo)).toEqual(['promocao']);
    expect(await loop.olharLote(1, escopo, depois)).toEqual([]);
    // O escopo vazio não olha ninguém.
    expect(await loop.olharLote(10, { tenantIds: [] }, new Date(depois.getTime() + 3 * DIA))).toEqual([]);
  });

  it('a olhada que falha fica registrada como erro e volta em 1 hora; o RegemCast fora do ar também', async () => {
    const e = await empresa();
    const escopo = { tenantIds: [e.tenantId] };
    const agora = new Date();
    const quebrado = new Loop(database, { olhar: () => Promise.reject(new Error('falha de propósito')) } as unknown as RotinaDoCrmService, escrita);
    const vezes = await quebrado.olharLote(10, escopo, agora);
    expect(vezes.map((v) => v.resultado)).toEqual(['erro', 'erro']);
    const emUmaHora = new Date(agora.getTime() + HORA);
    expect((await fila(e)).map((l) => [l.outcome, l.checked_at, l.next_check_at])).toEqual([
      ['erro', agora, emUmaHora],
      ['erro', agora, emUmaHora],
    ]);
    // Uma hora depois, o RegemCast responde com erro interno: de novo em 1 hora, e nenhuma proposta.
    contas.get(e.token)!.modo = 'erro_interno';
    expect((await loop.olharLote(10, escopo, emUmaHora)).map((v) => v.resultado)).toEqual(['regemcast_fora', 'regemcast_fora']);
    expect((await fila(e)).map((l) => l.next_check_at)).toEqual([new Date(emUmaHora.getTime() + HORA), new Date(emUmaHora.getTime() + HORA)]);
    expect(await propostas(e)).toEqual([]);
  });

  it('ele escreve a mensagem da proposta e o código confere: o texto que passa fica guardado; o que a conferência barra, não', async () => {
    const e = await empresa();
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
    const codigo = String((await propostas(e))[0]!.coupon.codigo);
    const mock = comResposta({ recusa: null, mensagem: { nome: 'Combo da sexta', corpo: BOA } });
    const vez = await escrever(e);
    const [p] = await guardadas(e);
    expect(vez).toEqual([{ id: p!.id, tenantId: e.tenantId, feito: { status: 'escrita', situacao: 'passou' } }]);
    // O texto conferido fica na proposta, que segue no preparo (o rascunho do modelo é o passo seguinte), sem espera.
    expect(p).toMatchObject({ status: 'preparando', name: 'Combo da sexta', body: BOA, attempts: 0, next_attempt_at: null, reason: null, barred_by: null });
    expect(p!.usage_id).toEqual(expect.any(String));
    // O que ele recebeu: a oferta, o público só com o nome e a contagem, e o cupom em palavras, com a validade em dias.
    const pedido = enviado(mock);
    for (const trecho of [OFERTAS[0]!, 'Nome: Novos', 'Pessoas que podem receber: 310', 'Benefício: 10% de desconto', 'Validade: válido por 2 dias, contando hoje', 'pelo cardápio online da loja']) expect(pedido, trecho).toContain(trecho);
    // O código do cupom não vai ao modelo (ele escreve `{{2}}`), nem quem responde pela proposta.
    expect(pedido).not.toContain(codigo);
    expect(pedido).not.toContain(e.userId);
    // A chamada é da rotina (sem pessoa), no fluxo dele, e conta como resposta.
    expect(await ownerQuery(`select workflow, prompt_version, user_id is null as do_sistema, answered from liame.ai_usage where tenant_id = $1 and task = 'crm_mensagem'`, [e.tenantId])).toEqual([
      { workflow: 'crm.mensagem', prompt_version: 'crm.mensagem@1', do_sistema: true, answered: true },
    ]);
    // Na trilha, só números: o texto fica na proposta.
    expect(await trilha(e, 'mensagem.escrever')).toEqual([
      { resource_id: p!.id, after: { review: 'passou', characters: { nome: 14, corpo: Array.from(BOA).length }, cites_value: true, usage_id: p!.usage_id, agent_key: 'crm' } },
    ]);
    // A proposta com texto saiu da fila da escrita: o modelo não é chamado de novo.
    expect(await escrever(e)).toEqual([]);
    expect(mock.doGenerateCalls).toHaveLength(1);

    // O "volte a pedir", com um desconto que não é o do cupom: a conferência barra, e o texto não é guardado.
    expect((await olhar(e, 'volte_a_pedir')).resultado).toBe('proposta_aberta');
    comResposta({ recusa: null, mensagem: { nome: 'Volte a pedir', corpo: VOLTE.replace('10% de desconto', '20% de desconto') } });
    const barrada = await escrever(e);
    expect(barrada.map((v) => v.feito)).toEqual([{ status: 'barrada', itens: ['oferta'] }]);
    const volte = (await guardadas(e)).find((x) => x.motive === 'volte_a_pedir')!;
    expect(volte).toMatchObject({ status: 'barrada', barred_by: ['oferta'], name: null, body: null, next_attempt_at: null });
    expect(await trilha(e, 'mensagem.barrar')).toEqual([{ resource_id: volte.id, after: { barred_by: ['oferta'], findings: ['preco_fora'], usage_id: expect.any(String), agent_key: 'crm' } }]);
    // A barrada já está na fila dele, com o que barrou: não entra também como texto retirado (apareceria duas vezes na ficha).
    expect(await recusas(e)).toEqual([]);
    // A de promoção segue como estava.
    expect((await guardadas(e)).find((x) => x.motive === 'promocao')).toMatchObject({ status: 'preparando', body: BOA });
  });

  it('o que ele não escreve: a recusa dele e o pedido que as regras de agora não deixam ir fecham a proposta, com o motivo', async () => {
    const e = await empresa();
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
    expect((await olhar(e, 'volte_a_pedir')).resultado).toBe('proposta_aberta');
    // A proposta de "volte a pedir" ganha, direto no banco, uma oferta que as regras não deixam divulgar.
    await ownerQuery(`update liame.message_proposal set offer = 'Chope em dobro na quinta' where tenant_id = $1 and motive = 'volte_a_pedir'`, [e.tenantId]);
    const mock = comResposta({ recusa: 'politica', mensagem: null });
    const vezes = await escrever(e);
    const [promo, volte] = await guardadas(e);
    expect(vezes).toEqual([
      { id: promo!.id, tenantId: e.tenantId, feito: { status: 'descartada', motivo: 'politica' } },
      { id: volte!.id, tenantId: e.tenantId, feito: { status: 'descartada', motivo: 'bebida_alcoolica' } },
    ]);
    expect(promo).toMatchObject({ status: 'descartada', reason: 'politica', body: null, next_attempt_at: null });
    expect(volte).toMatchObject({ status: 'descartada', reason: 'bebida_alcoolica', body: null });
    // O modelo só foi chamado para a primeira: a segunda nem chegou a ele.
    expect(mock.doGenerateCalls).toHaveLength(1);
    expect((await trilha(e, 'mensagem.descartar')).map((t) => [t.resource_id, t.after.reason])).toEqual([
      [promo!.id, 'politica'],
      [volte!.id, 'bebida_alcoolica'],
    ]);
    expect(await escrever(e, new Date(Date.now() + DIA))).toEqual([]);
  });

  it('quando não sai texto: a IA fora do ar e o texto que nem chega à conferência contam tentativa; na terceira, a proposta falha', async () => {
    const e = await empresa();
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
    const agora = new Date();
    modelo(ia.recusa(500));
    expect((await escrever(e, agora)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: false }]);
    const em15 = new Date(agora.getTime() + 15 * MIN);
    expect((await guardadas(e))[0]).toMatchObject({ status: 'preparando', attempts: 1, next_attempt_at: em15, body: null });
    // Antes da hora, a fila não a pega.
    expect(await escrever(e, new Date(em15.getTime() - MIN))).toEqual([]);
    expect((await escrever(e, em15)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: false }]);
    const em45 = new Date(em15.getTime() + 30 * MIN);
    expect((await guardadas(e))[0]).toMatchObject({ status: 'preparando', attempts: 2, next_attempt_at: em45 });
    // A terceira fecha a proposta.
    expect((await escrever(e, em45)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'ia_fora_do_ar', deVez: true }]);
    const [promo] = await guardadas(e);
    expect(promo).toMatchObject({ status: 'falhou', reason: 'ia_fora_do_ar', next_attempt_at: null, body: null });
    expect(await trilha(e, 'mensagem.falhar')).toEqual([{ resource_id: promo!.id, after: { reason: 'ia_fora_do_ar', attempts: 3, agent_key: 'crm' } }]);
    expect(await escrever(e, new Date(em45.getTime() + DIA))).toEqual([]);

    // O texto com um telefone nem chega à conferência: conta em Sua equipe como barrado pelo Compliance, sem o texto,
    // e a proposta tenta de novo. O gateway já trocou o telefone pela marca da limpeza.
    expect((await olhar(e, 'volte_a_pedir')).resultado).toBe('proposta_aberta');
    comResposta({ recusa: null, mensagem: { nome: 'Volte a pedir', corpo: 'Oi, {{1}}! Ligue para (21) 99999-0000 e use o cupom {{2}} no pedido.' } });
    const depois = new Date();
    expect((await escrever(e, depois)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'dado_pessoal', deVez: false }]);
    expect(await recusas(e)).toEqual([{ member: 'crm', workflow: 'crm.mensagem', kind: 'compliance', rules: ['dado_pessoal'], items: 1 }]);
    const volte = (await guardadas(e)).find((x) => x.motive === 'volte_a_pedir')!;
    expect(volte).toMatchObject({ status: 'preparando', attempts: 1, body: null, name: null });
    // A marca foi arquivada no meio: a proposta não vira mensagem.
    await ownerQuery(`update liame.brand set archived_at = now() where id = $1`, [e.brandId]);
    expect((await escrever(e, new Date(depois.getTime() + 15 * MIN))).map((v) => v.feito)).toEqual([{ status: 'descartada', motivo: 'marca_arquivada' }]);
  });

  it('sem IA agora, ou com ele desligado, a proposta espera sem contar tentativa; passado o prazo de escrever, é descartada', async () => {
    const e = await empresa();
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
    const [p] = await guardadas(e);
    const alvo = { tenantId: e.tenantId, id: p!.id };
    const mock = comResposta({ recusa: null, mensagem: { nome: 'Combo da sexta', corpo: BOA } });
    const agora = new Date();
    const emUmaHora = new Date(agora.getTime() + HORA);
    const espera = async (motivo: string) => {
      expect(await escrita.escrever(alvo, agora), motivo).toEqual({ status: 'esperando', motivo } satisfies Escrita);
      expect((await guardadas(e))[0], motivo).toMatchObject({ status: 'preparando', attempts: 0, next_attempt_at: emUmaHora, body: null });
    };
    // A flag `ia` quem confere é o gateway; as outras três, o serviço, antes de montar o pedido.
    for (const [flag, motivo] of [
      ['ia', 'ia_desligada'],
      ['crm', 'crm_desligado'],
      ['mensageria', 'mensageria_desligada'],
      ['whatsapp_campaign', 'envio_desligado'],
    ] as const) {
      await ligarFlag(e.tenantId, flag, false);
      await espera(motivo);
      await ligarFlag(e.tenantId, flag, true);
    }
    // Desligado pela empresa, em Sua equipe.
    const pausa = await api.call('POST', '/v1/team/members/crm/pause', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(pausa.status, JSON.stringify(pausa.body)).toBe(200);
    await espera('funcionario_desligado');
    expect(mock.doGenerateCalls).toHaveLength(0);
    // A fila respeita a espera.
    expect(await escrever(e, new Date(emUmaHora.getTime() - MIN))).toEqual([]);
    // Três dias depois de aberta, ainda sem texto: a oferta e a contagem envelheceram, e a proposta é descartada.
    const prazo = new Date(p!.created_at.getTime() + 3 * DIA);
    expect((await escrever(e, prazo)).map((v) => v.feito)).toEqual([{ status: 'descartada', motivo: 'prazo_de_escrever' }]);
    expect((await guardadas(e))[0]).toMatchObject({ status: 'descartada', reason: 'prazo_de_escrever', next_attempt_at: null });
    expect(mock.doGenerateCalls).toHaveLength(0);
    // Quem acabou não é escrita de novo.
    expect(await escrita.escrever(alvo)).toEqual({ status: 'fora' });
    expect(await escrita.falhou(alvo, 'erro')).toEqual({ status: 'fora' });
  });

  it('quatro voltas ao mesmo tempo escrevem cada proposta uma vez só; a falha fora do previsto conta como tentativa', async () => {
    const e = await empresa();
    expect((await olhar(e, 'promocao')).resultado).toBe('proposta_aberta');
    const mock = comResposta({ recusa: null, mensagem: { nome: 'Combo da sexta', corpo: BOA } });
    const voltas = await Promise.all([1, 2, 3, 4].map(() => escrever(e)));
    expect(voltas.flat().map((v) => v.feito)).toEqual([{ status: 'escrita', situacao: 'passou' }]);
    expect(mock.doGenerateCalls).toHaveLength(1);

    // O serviço que quebra de um jeito que ninguém previu: a tentativa conta, e a proposta volta mais tarde.
    expect((await olhar(e, 'volte_a_pedir')).resultado).toBe('proposta_aberta');
    const quebrada = new Loop(database, servico, { escrever: () => Promise.reject(new Error('falha de propósito')), falhou: escrita.falhou.bind(escrita) } as unknown as EscritaDoCrmService);
    const agora = new Date();
    expect((await quebrada.escreverLote(5, { tenantIds: [e.tenantId] }, agora)).map((v) => v.feito)).toEqual([{ status: 'falhou', motivo: 'erro', deVez: false }]);
    expect((await guardadas(e)).find((x) => x.motive === 'volte_a_pedir')).toMatchObject({ status: 'preparando', attempts: 1, next_attempt_at: new Date(agora.getTime() + 15 * MIN) });
  });

  it('a tabela da fila (migration 0064): uma linha por marca e tipo, o resultado em código, e só quem olhou diz o que decidiu', async () => {
    const e = await empresa(['regemcast', 'loja', 'dossie']);
    const inserir = (colunas: string, valores: string) => ownerQuery(`insert into liame.message_routine (id, tenant_id, brand_id, ${colunas}) values (gen_random_uuid(), $1, $2, ${valores})`, [e.tenantId, e.brandId]);
    await inserir('motive', `'promocao'`);
    await expect(inserir('motive', `'promocao'`)).rejects.toThrow(/message_routine_uma_por_motivo/);
    await expect(inserir('motive', `'carrinho'`)).rejects.toThrow(/message_routine_motive_check/);
    // O resultado é um código: nem frase, nem maiúscula, nem número.
    await expect(inserir('motive, checked_at, outcome', `'volte_a_pedir', now(), 'Sem oferta'`)).rejects.toThrow(/message_routine_resultado/);
    await expect(inserir('motive, checked_at, outcome', `'volte_a_pedir', now(), 'x'`)).rejects.toThrow(/message_routine_resultado/);
    // Quem olhou diz o que decidiu, e só quem olhou.
    await expect(inserir('motive, outcome', `'volte_a_pedir', 'sem_oferta'`)).rejects.toThrow(/message_routine_olhada/);
    await expect(inserir('motive, checked_at', `'volte_a_pedir', now()`)).rejects.toThrow(/message_routine_olhada/);
    await inserir('motive, checked_at, outcome', `'volte_a_pedir', now(), 'sem_oferta'`);
    expect((await fila(e)).map((l) => [l.motive, l.outcome])).toEqual([
      ['promocao', null],
      ['volte_a_pedir', 'sem_oferta'],
    ]);
    // Outra empresa não vê a fila desta (a RLS isola a empresa).
    const { withTenant } = await import('@liame/database');
    const { sql } = await import('drizzle-orm');
    const outra = await empresa(['regemcast', 'loja', 'dossie']);
    const vistas = async (tenantId: string) => (await withTenant(database.db, tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from liame.message_routine`))).rows[0]!.n;
    expect([await vistas(e.tenantId), await vistas(outra.tenantId)]).toEqual([2, 0]);
  });
});
