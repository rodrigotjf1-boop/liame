import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations, uuidv7 } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiError, AiGateway, type FerramentaIa, type GenerateRequest } from '../../src/ai/gateway.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, modeloComPreco, recusa, type RefDeModelo, responde, rotaAtiva, uso } from '../helpers/ia.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// A escolha do modelo no Pro (A3, I13; D-A3-12; protótipo P7, aprovado em 03/10/2026; D-A3-25 a D-A3-28): o catálogo
// (`ai_model_option`), a escolha da empresa (`ai_model_choice`), o gateway usando a escolha e as rotas de Sua equipe.

describe.skipIf(!hasDb)('A escolha do modelo no Pro: o catálogo, a escolha e o gateway (A3, I13)', () => {
  const RODADA = `teste_${randomBytes(4).toString('hex')}`;
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let flags: FlagService;
  let switches: KillSwitchService;
  let modelos: ModelosDeTeste;

  type Dono = { cookie: string; tenantId: string; userId: string };

  async function dono(company = 'Pizzaria do Modelo'): Promise<Dono> {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    const d = { cookie: s.cookie, tenantId: s.me.active_organization_id as string, userId: s.me.user.id as string };
    await ligarIa(flags, d.tenantId);
    return d;
  }
  /** Outra pessoa na mesma empresa, com o nível dado. */
  async function membro(d: Dono, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: d.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  const modelo = (texto: string, barato = false) => modeloComPreco(modelos, RODADA, responde(texto), barato);
  const rota = (principal: RefDeModelo, extra: Parameters<typeof rotaAtiva>[2] = {}) => rotaAtiva(`${RODADA}_${randomBytes(3).toString('hex')}`, principal, extra);
  const gateway = () => new AiGateway(database, config, flags, switches, new ModelosDeTeste(config, modelos.porChave));
  const pedido = (d: Dono, task: string): GenerateRequest => ({
    tenantId: d.tenantId,
    userId: d.userId,
    workflow: 'resultados.explicar',
    task,
    promptVersion: 'explicar@1',
    instructions: 'Explique o resultado com os números recebidos.',
    messages: [{ role: 'user', content: 'Investimento R$ 1.250,00 · 38 pedidos' }],
  });
  /** O modelo no catálogo da tarefa (só a distribuição grava: escopo de sistema). */
  const oferecer = (task: string, m: RefDeModelo, extra: { maxCost?: number; status?: string; nota?: string } = {}) =>
    ownerQuery(
      `insert into liame.ai_model_option (id, task, provider, model, label, speed, max_cost_usd_micros, eval_score, eval_note, status, created_by)
       values ($1, $2, $3, $4, 'Modelo de teste', 'mais_lento', $5, $6, 'rodada de teste automatizado', $7, 'testes')
       on conflict (task, provider, model) do update set status = excluded.status`,
      [uuidv7(), task, m.provider, m.model, extra.maxCost ?? 300_000, extra.nota ?? '0.9600', extra.status ?? 'oferecida'],
    );
  /** A escolha da empresa, gravada direto (o caminho da rota está nos testes da API, abaixo). */
  const escolher = (d: Dono, purpose: string, m: RefDeModelo) =>
    ownerQuery(
      `insert into liame.ai_model_choice (id, tenant_id, purpose, provider, model, chosen_by) values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, purpose) do update set provider = excluded.provider, model = excluded.model`,
      [uuidv7(), d.tenantId, purpose, m.provider, m.model, d.userId],
    );
  const ligarEscolha = async (d: Dono, valor = true) => {
    await ligarFlagDaEmpresa(api, 'escolha_de_modelo', d.tenantId, valor);
    flags.invalidate();
  };
  const usos = (tenantId: string, task: string) =>
    ownerQuery<{ model: string; served_by: string; outcome: string }>(`select model, served_by, outcome from liame.ai_usage where tenant_id = $1 and task = $2 order by occurred_at, id`, [tenantId, task]);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    switches = api.app.get(KillSwitchService);
    modelos = new ModelosDeTeste(config);
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await ownerQuery(`delete from liame.ai_model_option where task like $1 or model like $1`, [`${RODADA}%`]);
    await ownerQuery(`delete from liame.ai_model_route where task like $1`, [`${RODADA}%`]);
    await ownerQuery(`delete from liame.ai_model_price where model like $1`, [`${RODADA}%`]);
    await api?.close();
  });

  it('a função nasce desligada, e o banco recusa o que o catálogo e a escolha não aceitam (V119)', async () => {
    const [flag] = await ownerQuery<{ default_value: boolean; is_write: boolean }>(`select default_value, is_write from liame.feature_flag where key = 'escolha_de_modelo'`);
    expect(flag).toEqual({ default_value: false, is_write: false });
    const d = await dono();
    const m = await modelo('ok');
    const task = await rota(m);
    const erro = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? 'outro');
    // velocidade fora da lista; status fora da lista; nota acima de 1; o mesmo modelo duas vezes na tarefa
    expect(await erro(ownerQuery(`insert into liame.ai_model_option (id, task, provider, model, label, speed, max_cost_usd_micros, eval_score, eval_note, created_by) values ($1, $2, 'teste', 'x', 'Xx', 'ligeiro', 1, 0.9, 'nota', 'testes')`, [uuidv7(), task]))).toBe('23514');
    expect(await erro(ownerQuery(`insert into liame.ai_model_option (id, task, provider, model, label, speed, max_cost_usd_micros, eval_score, eval_note, status, created_by) values ($1, $2, 'teste', 'x', 'Xx', 'rapido', 1, 0.9, 'nota', 'pausada', 'testes')`, [uuidv7(), task]))).toBe('23514');
    expect(await erro(ownerQuery(`insert into liame.ai_model_option (id, task, provider, model, label, speed, max_cost_usd_micros, eval_score, eval_note, created_by) values ($1, $2, 'teste', 'x', 'Xx', 'rapido', 1, 1.5, 'nota', 'testes')`, [uuidv7(), task]))).toBe('23514');
    await oferecer(task, m);
    expect(await erro(ownerQuery(`insert into liame.ai_model_option (id, task, provider, model, label, speed, max_cost_usd_micros, eval_score, eval_note, created_by) values ($1, $2, $3, $4, 'Xx', 'rapido', 1, 0.9, 'nota', 'testes')`, [uuidv7(), task, m.provider, m.model]))).toBe('23505');
    // finalidade fora da lista; duas escolhas na mesma finalidade
    expect(await erro(ownerQuery(`insert into liame.ai_model_choice (id, tenant_id, purpose, provider, model) values ($1, $2, 'imagem', 'teste', 'x')`, [uuidv7(), d.tenantId]))).toBe('23514');
    await ownerQuery(`insert into liame.ai_model_choice (id, tenant_id, purpose, provider, model) values ($1, $2, 'texto', 'teste', 'x')`, [uuidv7(), d.tenantId]);
    expect(await erro(ownerQuery(`insert into liame.ai_model_choice (id, tenant_id, purpose, provider, model) values ($1, $2, 'texto', 'teste', 'y')`, [uuidv7(), d.tenantId]))).toBe('23505');
  });

  it('o gateway usa o modelo escolhido só com a função ligada e o modelo no catálogo da tarefa; o da rota vira a reserva', async () => {
    const d = await dono();
    const principal = await modelo('pela rota');
    const escolhido = await modelo('pelo escolhido');
    const task = await rota(principal);
    await oferecer(task, escolhido);
    await escolher(d, 'analise', escolhido);

    // Desligada: a escolha fica guardada, e a chamada vai pelo modelo da rota.
    expect((await gateway().generate(pedido(d, task))).text).toBe('pela rota');
    await ligarEscolha(d);
    const r = await gateway().generate(pedido(d, task));
    expect(r).toMatchObject({ text: 'pelo escolhido', model: escolhido.model, servedBy: 'principal' });

    // Fora do catálogo (retirado): volta ao automático, sem apagar a escolha.
    await oferecer(task, escolhido, { status: 'retirada' });
    expect((await gateway().generate(pedido(d, task))).text).toBe('pela rota');
    const [guardada] = await ownerQuery(`select model from liame.ai_model_choice where tenant_id = $1 and purpose = 'analise'`, [d.tenantId]);
    expect(guardada).toEqual({ model: escolhido.model });
    expect((await usos(d.tenantId, task)).map((u) => u.model)).toEqual([principal.model, escolhido.model, principal.model]);
  });

  it('o escolhido que falha cai para o modelo da rota, registrado como reserva; a escolha de outra empresa não vale aqui', async () => {
    const d = await dono();
    const outra = await dono('Outra Pizzaria');
    const principal = await modelo('pela rota');
    const quebrado = await modeloComPreco(modelos, RODADA, recusa(500));
    const task = await rota(principal);
    await oferecer(task, quebrado);
    await escolher(d, 'analise', quebrado);
    await ligarEscolha(d);
    await ligarEscolha(outra);

    const r = await gateway().generate(pedido(d, task));
    expect(r).toMatchObject({ text: 'pela rota', servedBy: 'reserva' });
    expect(await usos(d.tenantId, task)).toEqual([
      { model: quebrado.model, served_by: 'principal', outcome: 'erro' },
      { model: principal.model, served_by: 'reserva', outcome: 'ok' },
    ]);
    // A outra empresa não escolheu nada: vai pelo modelo da rota.
    expect((await gateway().generate(pedido(outra, task))).servedBy).toBe('principal');
    expect((await usos(outra.tenantId, task)).map((u) => u.model)).toEqual([principal.model]);
  });

  it('acima de 80% do teto vale o econômico da rota, mesmo com a escolha', async () => {
    const d = await dono();
    const principal = await modelo('pela rota');
    const economico = await modelo('pelo econômico', true);
    const escolhido = await modelo('pelo escolhido');
    const task = await rota(principal, { economico });
    await oferecer(task, escolhido);
    await escolher(d, 'analise', escolhido);
    await ligarEscolha(d);
    // 85% do menor teto (o do dia, no padrão) já gasto hoje.
    const teto = BigInt(Math.min(config.ai.dailyLimitUsdMicros, config.ai.monthlyLimitUsdMicros));
    await ownerQuery(
      `insert into liame.ai_usage (id, tenant_id, workflow, task, provider, model, served_by, cost_usd_micros, outcome) values (gen_random_uuid(), $1, 'teste.semente', 'teste_semente', 'teste', 'semente', 'principal', $2, 'ok')`,
      [d.tenantId, ((teto * 85n) / 100n).toString()],
    );
    expect(await gateway().generate(pedido(d, task))).toMatchObject({ text: 'pelo econômico', servedBy: 'economico' });
  });

  it('o teto de UMA chamada passa a ser o do escolhido: as rodadas com ferramenta seguem até o teto dele', async () => {
    const rodada = (content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }>) => ({
      content,
      finishReason: { unified: content.some((c) => c.type === 'tool-call') ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
      usage: uso(1000, 500),
      warnings: [],
    });
    const roteiro = (texto: string) =>
      new MockLanguageModelV4({ doGenerate: [rodada([{ type: 'tool-call', toolCallId: `c-${randomBytes(3).toString('hex')}`, toolName: 'ler_teste', input: '{}' }]), rodada([{ type: 'text', text: texto }])] });
    const ferramentas: FerramentaIa[] = [{ name: 'ler_teste', description: 'Lê um dado de teste.', input: z.strictObject({}), executar: async () => ({ ok: true, valor: { pedidos: '38 pedidos' } }) }];
    const d = await dono();
    const daRota = await modeloComPreco(modelos, RODADA, roteiro('pela rota'));
    const escolhido = await modeloComPreco(modelos, RODADA, roteiro('pelo escolhido'));
    // A primeira rodada custa US$ 0,014: passa do teto da rota (1 micro) e não do teto do escolhido (US$ 10).
    const task = await rota(daRota, { maxCost: 1 });
    const falha = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof AiError ? e.code : `outro erro: ${String(e)}`));
    expect(await falha(gateway().agent({ ...pedido(d, task), ferramentas }))).toBe('indisponivel');

    await oferecer(task, escolhido, { maxCost: 10_000_000 });
    await escolher(d, 'analise', escolhido);
    await ligarEscolha(d);
    const r = await gateway().agent({ ...pedido(d, task), ferramentas });
    expect(r).toMatchObject({ text: 'pelo escolhido', rodadas: 2, model: escolhido.model });
  });

  describe('as rotas de Sua equipe', () => {
    /** Uma tarefa de conversa só deste teste, e o modelo oferecido em TODAS as tarefas ativas de conversa (a regra do catálogo). */
    async function catalogoDaConversa(m: RefDeModelo): Promise<string[]> {
      const minha = `${RODADA}_conversa_${randomBytes(3).toString('hex')}`;
      const outro = await modelo('outro');
      await ownerQuery(
        `insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, max_output_tokens, timeout_ms, max_cost_usd_micros, created_by, deployed_at)
         values (gen_random_uuid(), $1, 1, 'ativa', 'conversa', $2, $3, 4000, 30000, 200000, 'testes', now())`,
        [minha, outro.provider, outro.model],
      );
      const tarefas = await ownerQuery<{ task: string }>(`select task from liame.ai_model_route where status = 'ativa' and purpose = 'conversa'`);
      for (const t of tarefas) await oferecer(t.task, m);
      return tarefas.map((t) => t.task);
    }

    it('ver: a função, quem pode trocar, o automático e o catálogo de cada finalidade, com a estimativa pelo uso de 30 dias', async () => {
      const d = await dono();
      const m = await modelo('opus de teste');
      const tarefas = await catalogoDaConversa(m);
      // Uso de ontem numa tarefa de conversa: 1 milhão de tokens de entrada e 100 mil de saída, no `global`.
      await ownerQuery(
        `insert into liame.ai_usage (id, tenant_id, workflow, task, provider, model, served_by, inference_geo, input_tokens, output_tokens, cost_usd_micros, outcome, answered, occurred_at)
         values (gen_random_uuid(), $1, 'conversa.lia', $2, 'teste', 'qualquer', 'principal', 'global', 1000000, 100000, 1234, 'ok', true, now() - interval '1 day')`,
        [d.tenantId, tarefas[0]],
      );
      const desligada = await api.call('GET', '/v1/team/models', { cookie: d.cookie });
      expect(desligada.status).toBe(200);
      expect(desligada.body).toMatchObject({ enabled: false, can_change: true });
      expect(desligada.body.purposes.map((p: { purpose: string }) => p.purpose)).toEqual(['conversa', 'analise', 'texto']);

      await ligarEscolha(d);
      const r = await api.call('GET', '/v1/team/models', { cookie: d.cookie });
      const conversa = r.body.purposes.find((p: { purpose: string }) => p.purpose === 'conversa');
      expect(conversa).toMatchObject({ label: 'Conversa e atendimento', answered: 1, spent_usd_micros: '1234', choice: null });
      // US$ 4 por milhão de entrada e US$ 20 por milhão de saída (o preço do modelo de teste): 4 + 2 = US$ 6.
      expect(conversa.options).toContainEqual({ provider: m.provider, model: m.model, label: 'Modelo de teste', speed: 'mais_lento', eval_score: '0.9600', estimated_usd_micros: '6000000' });
    });

    it('trocar: só Dono e Administrador; o modelo fora do catálogo e a função desligada são recusados; voltar ao automático apaga a escolha; tudo na auditoria', async () => {
      const d = await dono();
      const m = await modelo('opus de teste');
      await catalogoDaConversa(m);

      const desligada = await api.call('PUT', '/v1/team/models/conversa', { cookie: d.cookie, body: { model: { provider: m.provider, model: m.model } } });
      expect([desligada.status, desligada.body.code]).toEqual([409, 'funcao-desligada']);
      await ligarEscolha(d);

      const gestor = await membro(d, 'gestor');
      expect((await api.call('PUT', '/v1/team/models/conversa', { cookie: gestor.cookie, body: { model: null } })).status).toBe(403);
      const fora = await api.call('PUT', '/v1/team/models/conversa', { cookie: d.cookie, body: { model: { provider: 'teste', model: `${RODADA}_nao_existe` } } });
      expect([fora.status, fora.body.code]).toEqual([422, 'fora-do-catalogo']);
      expect((await api.call('PUT', '/v1/team/models/imagem', { cookie: d.cookie, body: { model: null } })).status).toBe(400);

      const admin = await membro(d, 'administrador');
      const ok = await api.call('PUT', '/v1/team/models/conversa', { cookie: admin.cookie, body: { model: { provider: m.provider, model: m.model } } });
      expect(ok.status).toBe(200);
      expect(ok.body.purposes.find((p: { purpose: string }) => p.purpose === 'conversa').choice).toMatchObject({ provider: m.provider, model: m.model, offered: true, by: { name: 'Pessoa administrador' } });

      const volta = await api.call('PUT', '/v1/team/models/conversa', { cookie: d.cookie, body: { model: null } });
      expect(volta.body.purposes.find((p: { purpose: string }) => p.purpose === 'conversa').choice).toBeNull();
      expect(await ownerQuery(`select 1 from liame.ai_model_choice where tenant_id = $1`, [d.tenantId])).toEqual([]);

      const eventos = await ownerQuery<{ before: { model: string }; after: { model: string } }>(
        `select before, after from liame.audit_event where tenant_id = $1 and action = 'equipe.escolher_modelo' order by chain_seq`,
        [d.tenantId],
      );
      expect(eventos.map((e) => [e.before.model, e.after.model])).toEqual([
        ['automatico', `${m.provider}/${m.model}`],
        [`${m.provider}/${m.model}`, 'automatico'],
      ]);
    }, 120_000);
  });
});
