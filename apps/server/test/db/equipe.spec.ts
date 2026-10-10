import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { TeamResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, uuidv7, withTenant } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActionService } from '../../src/actions/action.service.js';
import { funcionarioAtivo } from '../../src/ai/registro/ativacao.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
import { ResultsService } from '../../src/results/results.service.js';
import { PedidosDoGestor } from '../../src/worker/pedidos-do-gestor.js';
import { SombraLoop } from '../../src/worker/sombra-loop.js';
import { SombraService } from '../../src/worker/sombra.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarCriativo, ligarIa } from '../helpers/ia.js';
import { contaDoRegemcast, semearMensagemDoCrm, semearPropostaDoCrm } from '../helpers/mensagens-semeadas.js';
import { pecaEscrita, pedidoDePecas, versaoDaPeca } from '../helpers/pecas-semeadas.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · I13b: Sua equipe. A leitura mostra a situação de cada membro (pelas chaves da empresa, do plano, das flags e da
// parada), o custo de IA e o que fez no mês; a empresa desliga e liga um membro numa marca, e quem está desligado
// não trabalha (a IA, a sombra).

const FUSO = 'America/Sao_Paulo';
const hoje = diaNoFuso(new Date(), FUSO);

describe.skipIf(!hasDb)('Sua equipe: situação, custo, números do mês e desligar (A3, I13b)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;

  type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; conta: string; campanha: string };

  async function empresa(): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria da Equipe');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [conta, campanha] = [randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Equipe', 'BRL', $5)`,
      [conta, tenantId, brandId, `act_${randomUUID().slice(0, 8)}`, FUSO],
    );
    await ownerQuery(
      `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status, daily_budget_micros) values ($1, $2, $3, 'meta_ads', 'c1', 'Delivery noite', 'ativa', 30000000)`,
      [campanha, tenantId, conta],
    );
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, conta, campanha };
  }

  async function membro(e: Empresa, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  async function ligarSombra(tenantId: string): Promise<void> {
    await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'sombra', 'tenant', $1, 'true'::jsonb, 'testes')`, [tenantId]);
    flags.invalidate();
  }

  /**
   * Uma chamada ao modelo registrada no mês, como o AI Gateway grava. `respondeu`: a chamada que entregou a resposta do
   * pedido (a atendida, se o teste não disser outra coisa); a rodada em que o modelo só pediu uma leitura não respondeu.
   */
  async function chamada(e: Empresa, workflow: string, custo: number, o: { outcome?: string; respondeu?: boolean } = {}): Promise<string> {
    const id = uuidv7();
    const outcome = o.outcome ?? 'ok';
    const respondeu = o.respondeu ?? outcome === 'ok';
    await ownerQuery(
      `insert into liame.ai_usage (id, tenant_id, brand_id, user_id, workflow, task, provider, model, served_by, cost_usd_micros, outcome, tool_calls, answered)
       values ($1, $2, $3, $4, $5, 'teste', 'teste', 'modelo', 'principal', $6, $7, $8, $9)`,
      [id, e.tenantId, e.brandId, e.userId, workflow, custo, outcome, outcome === 'ok' && !respondeu ? 1 : 0, respondeu],
    );
    return id;
  }

  const ver = async (e: { cookie: string }, brandId: string) => {
    const r = await api.call('GET', `/v1/team?brand_id=${brandId}`, { cookie: e.cookie });
    expect(r.status).toBe(200);
    return TeamResponse.parse(r.body);
  };
  const situacoes = (t: TeamResponse) => Object.fromEntries(t.members.map((m) => [m.key, m.status]));
  const doMembro = (t: TeamResponse, key: string) => t.members.find((m) => m.key === key)!;
  const numeros = (t: TeamResponse, key: string) => Object.fromEntries(doMembro(t, key).stats.map((s) => [s.key, s.value]));

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    flags = api.app.get(FlagService);
  });
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('a situação de cada um segue as flags da distribuição e a parada da empresa', async () => {
    const e = await empresa();
    let t = await ver(e, e.brandId);
    // Nasce tudo desligado pela distribuição (IA e sombra), menos quem trabalha por regra.
    expect(situacoes(t)).toEqual({
      lia: 'desligado_pela_liame',
      analista: 'desligado_pela_liame',
      relatorios: 'ativo',
      compliance: 'ativo',
      estrategista: 'desligado_pela_liame',
      pesquisador: 'desligado_pela_liame',
      trafego: 'desligado_pela_liame',
      criativo: 'desligado_pela_liame',
      crm: 'desligado_pela_liame',
    });
    expect(t).toMatchObject({ ai: { enabled: false, spent_usd_micros: '0', band: 'livre' }, stop: null, can_manage: true, can_stop: true });
    expect(t.month.from <= hoje && hoje <= t.month.to).toBe(true);
    // O Compliance trabalha por regra e não desliga; os números dele são contagens (D-A3-15), zeradas sem nada no mês.
    expect(doMembro(t, 'compliance')).toMatchObject({ kind: 'regra', can_pause: false });
    expect(numeros(t, 'compliance')).toEqual({ textos_conferidos: '0', textos_barrados: '0' });

    await ligarIa(flags, e.tenantId);
    await ligarSombra(e.tenantId);
    t = await ver(e, e.brandId);
    // O Criativo precisa da flag dele além da IA: sem ela, segue desligado pela distribuição.
    expect(situacoes(t)).toEqual({ lia: 'ativo', analista: 'ativo', relatorios: 'ativo', compliance: 'ativo', estrategista: 'ativo', pesquisador: 'ativo', trafego: 'sombra', criativo: 'desligado_pela_liame', crm: 'desligado_pela_liame' });
    await ligarCriativo(flags, e.tenantId);
    t = await ver(e, e.brandId);
    expect(situacoes(t).criativo).toBe('ativo');

    // A parada da empresa (a mesma da A1) trava quem usa IA; quem trabalha por regra segue.
    const parada = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'Revisando os textos da semana' } });
    expect(parada.status).toBe(201);
    t = await ver(e, e.brandId);
    expect(t.stop).toMatchObject({ id: parada.body.id, level: 'tenant', by_company: true, reason: 'Revisando os textos da semana', by: { id: e.userId } });
    expect(situacoes(t)).toEqual({ lia: 'parado', analista: 'parado', relatorios: 'ativo', compliance: 'ativo', estrategista: 'parado', pesquisador: 'parado', trafego: 'sombra', criativo: 'parado', crm: 'desligado_pela_liame' });
    expect((await api.call('DELETE', `/v1/kill-switches/${parada.body.id}`, { cookie: e.cookie })).status).toBe(204);
    expect((await ver(e, e.brandId)).stop).toBeNull();
  });

  it('o Criativo (A4 · P12): só trabalha a pedido; as peças do mês, o que espera a pessoa, o que escreve agora, por que não pode escrever, e desligar', async () => {
    const e = await empresa();
    await ligarIa(flags, e.tenantId);
    await ligarCriativo(flags, e.tenantId);
    const criativo = async (quem: { cookie: string } = e) => doMembro(await ver(quem, e.brandId), 'criativo');
    const zerado = { pedidos: '0', pecas_escritas: '0', pecas_aprovadas: '0', pecas_recusadas: '0', versoes_refeitas: '0', pecas_hoje: '0', pecas_esperando: '0', pecas_barradas: '0', retiradas_na_conferencia: '0' };

    // Ligado, sem oferta em Minha marca: ele não tem do que partir (não inventa oferta nem preço).
    let t = await ver(e, e.brandId);
    expect(doMembro(t, 'criativo')).toMatchObject({ kind: 'ia', status: 'ativo', working_now: false, can_pause: true, paused: null, in_progress: null, blocked_by: 'sem_oferta', cost: { usd_micros: '0', calls: 0 } });
    expect(numeros(t, 'criativo')).toEqual(zerado);
    // Só o Criativo traz os dois campos: os outros seguem como eram.
    expect(doMembro(t, 'lia')).not.toHaveProperty('blocked_by');
    expect(doMembro(t, 'estrategista')).not.toHaveProperty('in_progress');

    const dossie = {
      identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
      voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
      products: { items: ['Smash Clássico R$ 29,90'] },
      offers: { items: ['Combo sexta: smash, batata e refri por R$ 34,90'] },
      forbidden: { items: [] },
      competitors: { items: [] },
      region: { area: 'Centro e Lapa', pickup: true },
    };
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: dossie } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    expect(await criativo()).toMatchObject({ status: 'ativo', blocked_by: null, in_progress: null });

    // Um pedido atendido hoje, com três peças (uma aprovada, uma esperando, uma barrada), uma versão refeita e o custo.
    const dono = { tenantId: e.tenantId, brandId: e.brandId, userId: e.userId };
    const uso = await chamada(e, 'criativo.peca', 90_000);
    const lote = await pedidoDePecas(dono, { pecas: 3, uso });
    const aprovada = await pecaEscrita(dono, lote, { titulo: 'Sexta é dia de combo', status: 'aprovada' });
    await pecaEscrita(dono, lote, { titulo: 'Combo sexta no capricho', conferencia: 'aviso' });
    await pecaEscrita(dono, lote, { titulo: 'Entrega em 20 minutos', conferencia: 'barrou' });
    const outra = await pedidoDePecas(dono, { peca: aprovada, pecas: 0, uso: await chamada(e, 'criativo.peca', 30_000) });
    await versaoDaPeca(dono, aprovada, { versao: 2, titulo: 'Sexta é dia de combo, mais curto', pedido: outra });
    // Um pedido que ele recusou e uma peça de outro mês não entram nas contas do mês.
    await pedidoDePecas(dono, { status: 'recusado', motivo: 'sem_peca' });
    const antigo = await pedidoDePecas(dono, { pecas: 1, criadoEm: '2026-01-10T12:00:00Z', terminouEm: '2026-01-10T12:01:00Z' });
    await pecaEscrita(dono, antigo, { titulo: 'Peça de janeiro', status: 'recusada', criadaEm: '2026-01-10T12:01:00Z' });
    t = await ver(e, e.brandId);
    expect(numeros(t, 'criativo')).toEqual({ ...zerado, pedidos: '1', pecas_escritas: '3', pecas_aprovadas: '1', versoes_refeitas: '1', pecas_hoje: '3', pecas_esperando: '1', pecas_barradas: '1' });
    expect(doMembro(t, 'criativo')).toMatchObject({ working_now: false, in_progress: null, blocked_by: null, cost: { usd_micros: '120000', calls: 2 } });

    // Um pedido na fila: ele está trabalhando, e a tela sabe o quê (a oferta, quantas peças, quem pediu e quando).
    const naFila = await pedidoDePecas(dono, { status: 'gerando', variacoes: 2, oferta: 'Combo sexta: smash, batata e refri por R$ 34,90' });
    expect(await criativo()).toMatchObject({ working_now: true, in_progress: { subject: 'Combo sexta: smash, batata e refri por R$ 34,90', count: 2, by: { id: e.userId }, since: expect.any(String) } });
    await ownerQuery(`update liame.ad_piece_request set status = 'concluido', finished_at = now() where id = $1`, [naFila]);
    // Outra versão de uma peça na fila: trabalha do mesmo jeito, sem oferta nem quantidade para dizer.
    const refazendo = await pedidoDePecas(dono, { status: 'pendente', peca: aprovada });
    expect(await criativo()).toMatchObject({ working_now: true, in_progress: { subject: null, count: null, by: { id: e.userId } } });
    await ownerQuery(`update liame.ad_piece_request set status = 'falhou', reason = 'ia_fora_do_ar', finished_at = now() where id = $1`, [refazendo]);

    // O limite de IA do dia acabou: ligado, mas um pedido novo não cabe (e a tela diz qual limite aperta).
    await ownerQuery(`insert into liame.ai_budget (tenant_id, daily_usd_micros, monthly_usd_micros, set_by, reason) values ($1, 100000, 100000000, 'testes', 'teste do Criativo na equipe')`, [e.tenantId]);
    expect(await criativo()).toMatchObject({ status: 'ativo', blocked_by: 'limite_de_ia_do_dia' });
    await ownerQuery(`delete from liame.ai_budget where tenant_id = $1`, [e.tenantId]);
    expect((await criativo()).blocked_by).toBeNull();

    // A empresa desliga: ninguém pede peça nova (o serviço das peças confere a mesma chave), e o motivo de não
    // escrever deixa de ser o limite ou a oferta.
    const desligado = await api.call('POST', '/v1/team/members/criativo/pause', { cookie: e.cookie, body: { brand_id: e.brandId, reason: 'Vamos rever os textos' } });
    expect(desligado.status, JSON.stringify(desligado.body)).toBe(200);
    expect(doMembro(TeamResponse.parse(desligado.body), 'criativo')).toMatchObject({ status: 'desligado', blocked_by: null, paused: { by: { id: e.userId }, reason: 'Vamos rever os textos' } });
    const opcoes = await api.call('GET', `/v1/ad-pieces/options?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(opcoes.body).toMatchObject({ available: false, reason: 'criativo_desligado' });
    const pedido = await api.call('POST', '/v1/ad-pieces/requests', { cookie: e.cookie, body: { brand_id: e.brandId, offer: 'Combo sexta: smash, batata e refri por R$ 34,90', destination: 'cardapio', variations: 2 } });
    expect([pedido.status, pedido.body.code], JSON.stringify(pedido.body)).toEqual([409, 'criativo-desligado']);
    // As peças que já existem seguem valendo: os números não mudam por ele estar desligado.
    expect(numeros(await ver(e, e.brandId), 'criativo')).toMatchObject({ pecas_escritas: '3', pecas_esperando: '1', pecas_barradas: '1' });
    const ligado = await api.call('POST', '/v1/team/members/criativo/resume', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(doMembro(TeamResponse.parse(ligado.body), 'criativo')).toMatchObject({ status: 'ativo', paused: null });
    expect((await api.call('GET', `/v1/ad-pieces/options?brand_id=${e.brandId}`, { cookie: e.cookie })).body).toMatchObject({ available: true, reason: null });

    // Com a parada da empresa ele para com os outros de IA, e não há motivo próprio para mostrar.
    const parada = await api.call('POST', '/v1/kill-switches', { cookie: e.cookie, body: { level: 'tenant', reason: 'Revisando tudo' } });
    expect(await criativo()).toMatchObject({ status: 'parado', blocked_by: null });
    expect((await api.call('DELETE', `/v1/kill-switches/${parada.body.id}`, { cookie: e.cookie })).status).toBe(204);
  });

  it('o CRM e mensageria (A5 · P16): ainda não ligado sem as flags dele; ligado, diz o que falta para propor; as mensagens do mês e o que os cupons trouxeram; e desligar', async () => {
    const e = await empresa();
    await ligarIa(flags, e.tenantId);
    const crm = async (quem: { cookie: string } = e) => doMembro(await ver(quem, e.brandId), 'crm');
    const ligar = async (flag: string) => {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, e.tenantId]);
      flags.invalidate();
    };
    const zerado = {
      mensagens_propostas: '0',
      mensagens_enviadas: '0',
      mensagens_recusadas: '0',
      mensagens_esperando: '0',
      rascunhos_esperando_o_modelo: '0',
      pedidos_com_cupom: '0',
      caixa_com_cupom: '0',
      retiradas_na_conferencia: '0',
    };

    // Com a IA ligada e sem as flags dele: ainda não está ligado para a empresa, e não há o que dizer do que falta.
    let t = await ver(e, e.brandId);
    expect(doMembro(t, 'crm')).toMatchObject({ kind: 'ia', status: 'desligado_pela_liame', working_now: false, can_pause: true, paused: null, in_progress: null, blocked_by: null, cost: { usd_micros: '0', calls: 0 } });
    expect(numeros(t, 'crm')).toEqual(zerado);
    // Só a flag dele não basta: sem as duas do envio de mensagens ele não tem como propor.
    await ligar('crm');
    expect((await crm()).status).toBe('desligado_pela_liame');
    await ligar('mensageria');
    expect((await crm()).status).toBe('desligado_pela_liame');
    await ligar('whatsapp_campaign');

    // Ligado, sem o RegemCast conectado nesta marca: não há para quem propor.
    expect(await crm()).toMatchObject({ status: 'ativo', blocked_by: 'sem_regemcast', in_progress: null });
    const conta = await contaDoRegemcast(e);
    // Com o RegemCast, falta a oferta de Minha marca (ele não inventa oferta nem preço).
    expect(await crm()).toMatchObject({ status: 'ativo', blocked_by: 'sem_oferta' });
    const dossie = {
      identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
      voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
      products: { items: ['Smash Clássico R$ 29,90'] },
      offers: { items: ['Combo sexta: smash, batata e refri por R$ 34,90'] },
      forbidden: { items: [] },
      competitors: { items: [] },
      region: { area: 'Centro e Lapa', pickup: true },
    };
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: e.cookie, body: { brand_id: e.brandId, base_version: 0, content: dossie } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    expect(await crm()).toMatchObject({ status: 'ativo', blocked_by: null, in_progress: null, working_now: false });

    // Três mensagens propostas por ele no mês: uma enviada (com o cupom já criado no Regem), uma esperando a decisão e
    // uma recusada. E duas chamadas ao modelo para escrever.
    const loja = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'regem', $4, 'Loja Centro', 'BRL', $5)`, [
      loja,
      e.tenantId,
      e.brandId,
      `loja-${randomUUID().slice(0, 8)}`,
      FUSO,
    ]);
    const ha = (minutos: number) => new Date(Date.now() - minutos * 60_000).toISOString();
    const alvo = { tenantId: e.tenantId, brandId: e.brandId, userId: e.userId, conta };
    await semearMensagemDoCrm(alvo, { situacao: 'executada', nome: 'Sobremesa por nossa conta', pessoas: 176, cupom: { loja, codigo: 'DOCE10', nascido: ha(120) }, aprovadaPor: e.userId, haMinutos: 3 });
    await semearMensagemDoCrm(alvo, { situacao: 'aguardando', nome: 'Sexta em dobro', cupom: { loja, codigo: 'SEXTA10', nascido: null }, haMinutos: 2 });
    await semearMensagemDoCrm(alvo, { situacao: 'recusada', nome: 'Combo kids', haMinutos: 1 });
    // Contam como propostas do mês, e em mais nada: a que quem opera tirou da fila (não é recusa de quem aprova) e a
    // que passou do prazo antes de a rotina de expirar chegar nela (já não espera ninguém).
    await semearMensagemDoCrm(alvo, { situacao: 'cancelada', nome: 'Tirada da fila', haMinutos: 4 });
    await semearMensagemDoCrm(alvo, { situacao: 'aguardando', nome: 'Passou do prazo', haMinutos: 6, venceuHaMinutos: 5 });
    // Não contam em nada: a mensagem de outro mês (quarenta dias atrás é sempre antes deste mês), mesmo com o cupom
    // rendendo agora, e o pedido de mensagem que não é dele.
    await semearMensagemDoCrm(alvo, { situacao: 'executada', nome: 'Do mês passado', cupom: { loja, codigo: 'ANTIGO10', nascido: ha(60 * 24 * 40) }, aprovadaPor: e.userId, haMinutos: 60 * 24 * 40 });
    await semearMensagemDoCrm(alvo, { situacao: 'aguardando', nome: 'De outro funcionário', funcionario: 'trafego', haMinutos: 2 });
    await chamada(e, 'crm.mensagem', 40_000);
    await chamada(e, 'crm.mensagem', 50_000);
    const venda = (codigo: string | null, quando: string, status: 'confirmado' | 'cancelado', receita: number, devolvido = 0) =>
      ownerQuery(
        `insert into liame.order_fact (id, tenant_id, brand_id, connected_account_id, provider, external_id, channel, channel_group, status, currency, timezone, revenue_micros, refunded_micros, coupon_code,
                                       confirmed_at, cancelled_at, source_version, source_updated_at)
         values (gen_random_uuid(), $1, $2, $3, 'regem', $4, 'cardapio', 'cardapio', $5::text, 'BRL', $6, $7, $8, $9, $10::timestamptz, case when $5::text = 'cancelado' then $10::timestamptz + interval '10 minutes' end, 1, now())`,
        [e.tenantId, e.brandId, loja, `p-${randomUUID().slice(0, 12)}`, status, FUSO, receita, devolvido, codigo, quando],
      );
    await venda('DOCE10', ha(60), 'confirmado', 30_000_000);
    await venda('DOCE10', ha(50), 'confirmado', 24_000_000, 4_000_000);
    // Não contam: o cancelado, o de antes de o cupom nascer, o de outro cupom e o do cupom que ainda não nasceu.
    await venda('DOCE10', ha(40), 'cancelado', 50_000_000);
    await venda('DOCE10', ha(180), 'confirmado', 70_000_000);
    await venda('OUTRO15', ha(60), 'confirmado', 60_000_000);
    await venda('SEXTA10', ha(60), 'confirmado', 45_000_000);
    // Nem o pedido de agora com o cupom da mensagem do mês passado: o bloco é das mensagens deste mês.
    await venda('ANTIGO10', ha(30), 'confirmado', 80_000_000);

    t = await ver(e, e.brandId);
    // Cinco propostas no mês (a enviada, a que espera, a recusada, a tirada da fila e a que passou do prazo); dois
    // pedidos com o cupom, R$ 30,00 + (R$ 24,00 − R$ 4,00 devolvidos) = R$ 50,00.
    expect(numeros(t, 'crm')).toEqual({ ...zerado, mensagens_propostas: '5', mensagens_enviadas: '1', mensagens_recusadas: '1', mensagens_esperando: '1', pedidos_com_cupom: '2', caixa_com_cupom: '50000000' });
    expect(doMembro(t, 'crm')).toMatchObject({ status: 'ativo', blocked_by: null, cost: { usd_micros: '90000', calls: 2 } });
    // Os outros funcionários seguem sem os números dele, e ele sem os deles.
    expect(numeros(t, 'criativo')).not.toHaveProperty('mensagens_propostas');
    expect(numeros(t, 'crm')).not.toHaveProperty('pecas_escritas');

    // A empresa desliga: ele para de propor; o pedido que já espera em Aprovações segue contado.
    const desligado = await api.call('POST', '/v1/team/members/crm/pause', { cookie: e.cookie, body: { brand_id: e.brandId, reason: 'Vamos rever as mensagens' } });
    expect(desligado.status, JSON.stringify(desligado.body)).toBe(200);
    expect(doMembro(TeamResponse.parse(desligado.body), 'crm')).toMatchObject({ status: 'desligado', blocked_by: null, paused: { by: { id: e.userId }, reason: 'Vamos rever as mensagens' } });
    expect(numeros(TeamResponse.parse(desligado.body), 'crm').mensagens_esperando).toBe('1');
    const ligado = await api.call('POST', '/v1/team/members/crm/resume', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(doMembro(TeamResponse.parse(ligado.body), 'crm')).toMatchObject({ status: 'ativo', paused: null });

    // Outra empresa não vê nada disto.
    const vizinha = await empresa();
    expect(numeros(await ver(vizinha, vizinha.brandId), 'crm')).toEqual(zerado);
  });

  it('o CRM e mensageria e a fila das propostas (A5 · P16): preparando é trabalho em andamento; o rascunho que espera o modelo diz o que falta', async () => {
    const e = await empresa();
    await ligarIa(flags, e.tenantId);
    for (const flag of ['crm', 'mensageria', 'whatsapp_campaign']) {
      await ownerQuery(`insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, 'testes')`, [flag, e.tenantId]);
    }
    flags.invalidate();
    const crm = async () => doMembro(await ver(e, e.brandId), 'crm');
    const conta = await contaDoRegemcast(e);
    const alvo = { tenantId: e.tenantId, brandId: e.brandId, userId: e.userId, conta };
    // Sem oferta em Minha marca e sem nada na fila: o que falta é a oferta.
    expect(await crm()).toMatchObject({ status: 'ativo', working_now: false, in_progress: null, blocked_by: 'sem_oferta' });
    // A proposta de outro funcionário na fila não é dele: nada muda. (Ela sai da fila em seguida: a marca tem uma
    // proposta em andamento por motivo.)
    const deOutro = await semearPropostaDoCrm(alvo, { situacao: 'rascunho', motivo: 'volte_a_pedir', funcionario: 'trafego', nome: 'De outro funcionário' });
    expect(await crm()).toMatchObject({ working_now: false, in_progress: null, blocked_by: 'sem_oferta' });
    expect(numeros(await ver(e, e.brandId), 'crm').rascunhos_esperando_o_modelo).toBe('0');
    await ownerQuery(`update liame.message_proposal set status = 'descartada', reason = 'prazo', finished_at = now() where id = $1`, [deOutro]);

    // Um "volte a pedir" cujo rascunho de modelo está no RegemCast e ninguém enviou ainda para a Meta: a ficha diz
    // isso (e não "sem oferta"), com o nome da mensagem, as pessoas e desde quando o rascunho existe.
    const rascunho = await semearPropostaDoCrm(alvo, { situacao: 'rascunho', motivo: 'volte_a_pedir', nome: 'Volte a pedir', pessoas: 96, haMinutos: 60, rascunhoHaMinutos: 50 });
    let m = await crm();
    expect(m).toMatchObject({ status: 'ativo', working_now: false, blocked_by: 'modelo_sem_envio', in_progress: { subject: 'Volte a pedir', count: 96, by: null, kind: 'volte_a_pedir' } });
    expect(Math.round((Date.now() - new Date(m.in_progress!.since).getTime()) / 60_000)).toBe(50);
    expect(numeros(await ver(e, e.brandId), 'crm').rascunhos_esperando_o_modelo).toBe('1');
    // Uma pessoa enviou o modelo, e a Meta analisa.
    await ownerQuery(`update liame.message_proposal set template_status = 'em análise' where id = $1`, [rascunho]);
    expect((await crm()).blocked_by).toBe('modelo_em_analise');

    // Ele começa a preparar uma promoção: é trabalho em andamento, sem impedimento, e vem antes do rascunho que espera.
    const preparando = await semearPropostaDoCrm(alvo, { situacao: 'preparando', motivo: 'promocao', oferta: 'Combo sexta: smash, batata e refri por R$ 34,90', pessoas: 412, haMinutos: 2 });
    m = await crm();
    expect(m).toMatchObject({ working_now: true, blocked_by: null, in_progress: { subject: 'Combo sexta: smash, batata e refri por R$ 34,90', count: 412, by: null, kind: 'promocao' } });
    // O rascunho segue contado; as propostas que acabaram não entram.
    await semearPropostaDoCrm(alvo, { situacao: 'barrada', motivo: 'promocao', acabouHaMinutos: 30 });
    await semearPropostaDoCrm(alvo, { situacao: 'descartada', motivo: 'promocao', porque: 'modelo_recusado', rascunhoHaMinutos: 300, acabouHaMinutos: 200 });
    expect(numeros(await ver(e, e.brandId), 'crm').rascunhos_esperando_o_modelo).toBe('1');

    // Acabou o preparo (a conferência barrou): volta a valer o rascunho que espera.
    await ownerQuery(`update liame.message_proposal set status = 'barrada', barred_by = '{oferta}', finished_at = now() where id = $1`, [preparando]);
    expect(await crm()).toMatchObject({ working_now: false, blocked_by: 'modelo_em_analise', in_progress: { subject: 'Volte a pedir' } });

    // A empresa desliga: nada disso se diz, e o rascunho segue contado.
    const desligado = await api.call('POST', '/v1/team/members/crm/pause', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(doMembro(TeamResponse.parse(desligado.body), 'crm')).toMatchObject({ status: 'desligado', working_now: false, in_progress: null, blocked_by: null });
    expect(numeros(TeamResponse.parse(desligado.body), 'crm').rascunhos_esperando_o_modelo).toBe('1');

    // Sem o RegemCast conectado, é só isso que a ficha diz, mesmo com o rascunho na fila.
    await api.call('POST', '/v1/team/members/crm/resume', { cookie: e.cookie, body: { brand_id: e.brandId } });
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [conta]);
    expect(await crm()).toMatchObject({ status: 'ativo', working_now: false, in_progress: null, blocked_by: 'sem_regemcast' });

    // Outra empresa não vê a fila desta.
    const vizinha = await empresa();
    expect(numeros(await ver(vizinha, vizinha.brandId), 'crm').rascunhos_esperando_o_modelo).toBe('0');
  });

  it('o custo de IA de cada um e o que fez no mês saem do banco, por marca', async () => {
    const e = await empresa();
    await ligarIa(flags, e.tenantId);
    const resposta = await chamada(e, 'conversa.lia', 120_000);
    await chamada(e, 'conversa.lia', 80_000);
    // A rodada em que a LIA só leu os dados custa e é uma chamada, mas a resposta é a chamada seguinte.
    await chamada(e, 'conversa.lia', 40_000, { respondeu: false });
    // A tentativa que falhou também custa, mas não conta como resposta.
    await chamada(e, 'conversa.lia', 10_000, { outcome: 'erro' });
    // As duas respostas que o Compliance barrou chegaram à conferência, não à pessoa.
    const barradas = [await chamada(e, 'conversa.lia', 15_000), await chamada(e, 'conversa.lia', 15_000)];
    const explicacao = await chamada(e, 'resultados.explicar', 50_000);
    await chamada(e, 'atencao.explicar', 30_000);
    // A explicação retirada pelos números, também.
    const retirada = await chamada(e, 'resultados.explicar', 25_000);
    await chamada(e, 'revisao.semanal', 20_000);
    // O revisor de IA do Compliance deu dois pareceres: custam, e não são texto para conferir.
    await chamada(e, 'compliance.revisor', 2_000);
    await chamada(e, 'compliance.revisor', 2_000);
    await ownerQuery(`insert into liame.ai_feedback (id, tenant_id, usage_id, user_id, verdict) values ($1, $2, $3, $4, 'fez_sentido'), ($5, $2, $6, $4, 'discordo')`, [
      uuidv7(),
      e.tenantId,
      resposta,
      e.userId,
      uuidv7(),
      explicacao,
    ]);
    await ownerQuery(
      `insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, assignee_agent, requested_by, opened_by_agent) values ($1, $2, $3, 'promocao', 'Promoção de sexta', 'Quero uma promoção.', 'estrategista', $4, 'lia')`,
      [uuidv7(), e.tenantId, e.brandId, e.userId],
    );
    // Duas recomendações da sombra no mês: uma comparável, na mesma direção da pessoa.
    for (const [dia, status, humana, agreement, label, regret] of [
      [hoje, 'aberta', null, null, null, null],
      [hoje, 'avaliada', 'reduziu_verba', 'mesma_direcao', 'teria_melhorado', -18_400_000],
    ] as const) {
      const campanha = randomUUID();
      await ownerQuery(
        `insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, 'Outra', 'ativa')`,
        [campanha, e.tenantId, e.conta, campanha.slice(0, 8)],
      );
      await ownerQuery(
        `insert into liame.shadow_decision (id, tenant_id, brand_id, connected_account_id, campaign_id, provider, source, tool, rule_key, rule_version, params, confidence,
                                            state_snapshot, decided_on, window_from, window_to, evaluate_on, status, human_action, agreement, regret_label, action_regret_micros, evaluated_at)
         values ($1, $2, $3, $4, $5, 'meta_ads', 'regra', 'orcamento_reduzir', 'prejuizo', 1, '{"percent":20}', 0.8, '{}', $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 case when $10 = 'avaliada' then now() end)`,
        [uuidv7(), e.tenantId, e.brandId, e.conta, campanha, dia, menosDias(dia, 7), menosDias(dia, 1), menosDias(dia, -7), status, humana, agreement, label, regret],
      );
    }

    // O que a conferência recusou no mês (D-A3-15): dois textos da LIA barrados pelo Compliance, uma resposta do Analista
    // retirada pelos números e três rótulos do Pesquisador barrados numa leitura só. De outra marca, nada entra.
    const outraMarca = (await api.call('POST', '/v1/brands', { cookie: e.cookie, body: { name: 'Segunda marca' } })).body.id as string;
    for (const [marca, member, workflow, kind, rules, items, uso] of [
      [e.brandId, 'lia', 'conversa.lia', 'compliance', '["promessa_de_resultado"]', 1, barradas[0]],
      [e.brandId, 'lia', 'conversa.lia', 'compliance', '["regra_da_marca"]', 1, barradas[1]],
      [e.brandId, 'analista', 'resultados.explicar', 'numero_fora', '[]', 1, retirada],
      [e.brandId, 'pesquisador', 'pesquisador.pagina', 'compliance', '["dado_pessoal"]', 3, null],
      [outraMarca, 'lia', 'conversa.lia', 'compliance', '["promessa_de_resultado"]', 5, null],
    ] as const) {
      await ownerQuery(`insert into liame.ai_refusal (id, tenant_id, brand_id, member, workflow, kind, rules, items, usage_id) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`, [
        uuidv7(),
        e.tenantId,
        marca,
        member,
        workflow,
        kind,
        rules,
        items,
        uso,
      ]);
    }

    const t = await ver(e, e.brandId);
    // O custo e as chamadas contam tudo o que foi ao modelo (6 da LIA: duas respostas, a rodada de leitura, a que falhou
    // e as duas barradas); as respostas são só as que chegaram à pessoa.
    expect(doMembro(t, 'lia').cost).toEqual({ usd_micros: '280000', calls: 6 });
    expect(numeros(t, 'lia')).toEqual({ respostas: '2', fez_sentido: '1', discordo: '0', demandas: '1', retiradas_na_conferencia: '2' });
    expect(doMembro(t, 'analista').cost).toEqual({ usd_micros: '105000', calls: 3 });
    expect(numeros(t, 'analista')).toEqual({ explicacoes: '2', fez_sentido: '0', discordo: '1', retiradas_na_conferencia: '1' });
    // O Compliance: conferidos = as respostas que chegaram à conferência (8: quatro da LIA, três do Analista e a da
    // revisão; a rodada de leitura e a tentativa que falhou não são texto para conferir); barrados = só o que uma regra
    // de texto barrou (2 + 3), e a recusa pelos números não entra aqui.
    expect(numeros(t, 'compliance')).toEqual({ textos_conferidos: '8', textos_barrados: '5' });
    // O custo do Compliance é o do revisor de IA; as regras de texto rodam no código, sem custo.
    expect(doMembro(t, 'compliance')).toMatchObject({ kind: 'regra', status: 'ativo', can_pause: false, cost: { usd_micros: '4000', calls: 2 } });
    expect(numeros(t, 'pesquisador')).toMatchObject({ retiradas_na_conferencia: '3' });
    expect(doMembro(t, 'relatorios').cost).toEqual({ usd_micros: '20000', calls: 1 });
    expect(numeros(t, 'estrategista')).toMatchObject({ em_preparo: '1' });
    expect(numeros(t, 'trafego')).toEqual({ recomendacoes: '2', comparaveis: '1', mesma_direcao: '1', arrependimento: '-18400000' });
    // O gasto da empresa no mês soma todas as chamadas; o teto vem da configuração.
    expect(t.ai.spent_usd_micros).toBe('409000');

    // Outra empresa não vê esta marca, e a marca dela não mostra o custo desta.
    const outra = await empresa();
    expect((await api.call('GET', `/v1/team?brand_id=${e.brandId}`, { cookie: outra.cookie })).status).toBe(404);
    expect(doMembro(await ver(outra, outra.brandId), 'lia').cost).toEqual({ usd_micros: '0', calls: 0 });
  });

  it('desligar e ligar um funcionário: ele deixa de trabalhar na marca; o Compliance não desliga; o histórico fica', async () => {
    const e = await empresa();
    await ligarIa(flags, e.tenantId);
    const ativo = () => withTenant(database.db, e.tenantId, (tx) => funcionarioAtivo(tx, { tenantId: e.tenantId, brandId: e.brandId, agentKey: 'lia', ativoPorPadrao: true }));
    expect(await ativo()).toBe(true);

    const r = await api.call('POST', '/v1/team/members/lia/pause', { cookie: e.cookie, body: { brand_id: e.brandId, reason: 'Vamos testar sem ela; dúvidas com fulano@exemplo.com' } });
    expect(r.status).toBe(200);
    const lia = doMembro(TeamResponse.parse(r.body), 'lia');
    expect(lia).toMatchObject({ status: 'desligado', paused: { by: { id: e.userId } } });
    expect(lia.paused!.reason).toContain('Vamos testar sem ela');
    expect(lia.paused!.reason).not.toContain('fulano@exemplo.com');
    expect(await ativo()).toBe(false);
    expect((await api.call('POST', '/v1/team/members/lia/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).body.code).toBe('ja-desligado');
    expect((await api.call('POST', '/v1/team/members/compliance/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).body.code).toBe('nao-desliga');
    // Quem não é da equipe desta fase não tem o que desligar (o CRM e mensageria entrou na A5; o de redes sociais, ainda não).
    expect((await api.call('POST', '/v1/team/members/social/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).status).toBe(400);

    const volta = await api.call('POST', '/v1/team/members/lia/resume', { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(volta.status).toBe(200);
    expect(doMembro(TeamResponse.parse(volta.body), 'lia')).toMatchObject({ status: 'ativo', paused: null });
    expect(await ativo()).toBe(true);
    expect((await api.call('POST', '/v1/team/members/lia/resume', { cookie: e.cookie, body: { brand_id: e.brandId } })).body.code).toBe('ja-ligado');
    const historico = await ownerQuery<{ agent_key: string; resumed_at: string | null; reason: string | null }>(`select agent_key, resumed_at, reason from liame.agent_pause where brand_id = $1`, [e.brandId]);
    expect(historico).toHaveLength(1);
    expect(historico[0]!.resumed_at).not.toBeNull();
    const audit = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and action like 'equipe.%' order by occurred_at`, [e.tenantId]);
    expect(audit.map((a) => a.action)).toEqual(['equipe.desligar_funcionario', 'equipe.ligar_funcionario']);
  });

  it('o Gestor de tráfego desligado na marca não roda a sombra; ligado de novo, volta', async () => {
    const e = await empresa();
    await ligarSombra(e.tenantId);
    const loop = new SombraLoop(database, flags, new SombraService(database, api.app.get(ResultsService)), new PedidosDoGestor(database, api.app.get(ActionService), flags));
    expect((await api.call('POST', '/v1/team/members/trafego/pause', { cookie: e.cookie, body: { brand_id: e.brandId } })).status).toBe(200);
    expect(await loop.executarLote(10, { tenantIds: [e.tenantId] })).toEqual([{ brandId: e.brandId, tenantId: e.tenantId, status: 'desligada_pela_empresa' }]);
    expect((await api.call('POST', '/v1/team/members/trafego/resume', { cookie: e.cookie, body: { brand_id: e.brandId } })).status).toBe(200);
    // A vez da marca volta em até uma hora.
    await ownerQuery(`update liame.shadow_state set next_at = now() where brand_id = $1`, [e.brandId]);
    const depois = await loop.executarLote(10, { tenantIds: [e.tenantId] });
    expect(depois.map((v) => v.status)).not.toContain('desligada_pela_empresa');
  });

  it('quem vê e quem desliga: o gestor vê e desliga; o aprovador não desliga', async () => {
    const e = await empresa();
    const gestor = await membro(e, 'gestor');
    expect((await ver(gestor, e.brandId)).can_manage).toBe(true);
    expect((await api.call('POST', '/v1/team/members/pesquisador/pause', { cookie: gestor.cookie, body: { brand_id: e.brandId } })).status).toBe(200);
    const aprovador = await membro(e, 'aprovador');
    expect((await api.call('POST', '/v1/team/members/pesquisador/resume', { cookie: aprovador.cookie, body: { brand_id: e.brandId } })).status).toBe(403);
    expect(doMembro(await ver(e, e.brandId), 'pesquisador').status).toBe('desligado');
  });
});
