import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations, withContext } from '@liame/database';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiError, AiGateway, ENTRADA_MAXIMA, type FerramentaIa, type GenerateRequest, SAIDA_DA_FERRAMENTA_MAXIMA } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { FerramentasDeLeitura } from '../../src/ai/registro/leituras.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { HOSTS_DO_VIGIA } from '../../src/connectors/vigia-trechos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { Mailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// Os spans do gateway caem aqui: o teste confere que só levam dado técnico (A3-3).
const spans = new InMemorySpanExporter();
trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }));

/** Os modelos do teste: simulados, por `fornecedor/modelo`; o que não está aqui fica "sem credencial". */
class ModelosDeTeste extends ModelosIa {
  constructor(
    config: AppConfig,
    readonly porChave = new Map<string, MockLanguageModelV4>(),
  ) {
    super(config);
  }
  override modelo(provider: string, model: string) {
    return this.porChave.get(`${provider}/${model}`) ?? null;
  }
}

const uso = (input: number, output: number, cacheRead?: number, cacheWrite?: number) => ({
  inputTokens: { total: input + (cacheRead ?? 0) + (cacheWrite ?? 0), noCache: input, cacheRead, cacheWrite },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const responde = (text: string, u = uso(1000, 500)) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: u, warnings: [] }),
  });
const recusa = (statusCode: number) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({ message: 'recusado', url: 'https://fornecedor.test', requestBodyValues: {}, statusCode, isRetryable: false });
    },
  });

describe.skipIf(!hasDb)('AI Gateway: custo, teto, limpeza de dado pessoal e funcionamento sem IA (A3, I1)', () => {
  const RODADA = `teste_${randomBytes(4).toString('hex')}`;
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let flags: FlagService;
  let switches: KillSwitchService;
  let modelos: ModelosDeTeste;

  type Dono = { cookie: string; tenantId: string; userId: string };

  /** Empresa nova com a flag `ia` ligada (ela nasce desligada para todos). */
  async function dono(company = 'Pizzaria da IA', ligada = true): Promise<Dono> {
    const s = await signupAndLogin(api, undefined, company);
    await enableMfa(api, s.cookie);
    const d = { cookie: s.cookie, tenantId: s.me.active_organization_id as string, userId: s.me.user.id as string };
    if (ligada) {
      await ownerQuery(
        `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'ia', 'tenant', $1, 'true'::jsonb, 'testes')`,
        [d.tenantId],
      );
      flags.invalidate();
    }
    return d;
  }

  /** Modelo simulado com preço na tabela (US$ por milhão: 4 de entrada, 20 de saída; o econômico, 1 e 5). */
  async function modelo(mock: MockLanguageModelV4, barato = false, provider = 'teste'): Promise<{ provider: string; model: string; mock: MockLanguageModelV4 }> {
    const model = `${RODADA}_${randomBytes(3).toString('hex')}`;
    await ownerQuery(
      `insert into liame.ai_model_price (id, provider, model, valid_from, input_usd_micros_per_mtok, output_usd_micros_per_mtok, cache_read_usd_micros_per_mtok,
                                         cache_write_5m_usd_micros_per_mtok, cache_write_1h_usd_micros_per_mtok, source, checked_on)
       values (gen_random_uuid(), $1, $2, current_date - 1, $3, $4, $5, $6, $7, 'teste automatizado', current_date)`,
      barato ? [provider, model, 1_000_000, 5_000_000, 100_000, 1_250_000, 2_000_000] : [provider, model, 4_000_000, 20_000_000, 200_000, 5_000_000, 8_000_000],
    );
    modelos.porChave.set(`${provider}/${model}`, mock);
    return { provider, model, mock };
  }

  type Ref = { provider: string; model: string };
  /** Rota ativa só deste teste (o banco é compartilhado: a tarefa é única por rodada). */
  async function rota(principal: Ref, extra: { reserva?: Ref[]; economico?: Ref; timeoutMs?: number; effort?: string; maxCost?: number } = {}): Promise<string> {
    const task = `${RODADA}_${randomBytes(3).toString('hex')}`;
    await ownerQuery(
      `insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms, max_cost_usd_micros, fallback,
                                         economy_provider, economy_model, created_by, deployed_at)
       values (gen_random_uuid(), $1, 3, 'ativa', 'analise', $2, $3, $4, 4000, $5, $6, $7::jsonb, $8, $9, 'testes', now())`,
      [task, principal.provider, principal.model, extra.effort ?? null, extra.timeoutMs ?? 30_000, extra.maxCost ?? 200_000, JSON.stringify(extra.reserva ?? []), extra.economico?.provider ?? null, extra.economico?.model ?? null],
    );
    return task;
  }

  /** Gateway com a configuração de IA do teste (os modelos simulados são os mesmos). */
  const gateway = (ai: Partial<AppConfig['ai']> = {}) => {
    const c = { ...config, ai: { ...config.ai, ...ai } };
    return new AiGateway(database, c, flags, switches, new ModelosDeTeste(c, modelos.porChave));
  };
  const pedido = (d: Dono, task: string, extra: Partial<GenerateRequest> = {}): GenerateRequest => ({
    tenantId: d.tenantId,
    userId: d.userId,
    workflow: 'resultados.explicar',
    task,
    promptVersion: 'explicar@1',
    instructions: 'Explique o resultado com os números recebidos.',
    messages: [{ role: 'user', content: 'Investimento R$ 1.250,00 · 38 pedidos · ROAS 2,6' }],
    ...extra,
  });
  const usos = (tenantId: string, task: string) =>
    ownerQuery<Record<string, any>>(
      `select id, user_id, workflow, route_version, prompt_version, provider, model, served_by, inference_geo, input_tokens::int, cache_read_tokens::int,
              cache_write_tokens::int, output_tokens::int, cost_usd_micros::int, outcome, error_code, pii_removed, trace_id
         from liame.ai_usage where tenant_id = $1 and task = $2 order by occurred_at, id`,
      [tenantId, task],
    );
  /** Gasto já registrado, para chegar perto do teto sem dezenas de chamadas. */
  const gastar = (tenantId: string, micros: number) =>
    ownerQuery(
      `insert into liame.ai_usage (id, tenant_id, workflow, task, provider, model, served_by, cost_usd_micros, outcome)
       values (gen_random_uuid(), $1, 'teste.semente', 'teste_semente', 'teste', 'semente', 'principal', $2, 'ok')`,
      [tenantId, micros],
    );
  const falha = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof AiError ? e.code : `outro erro: ${String(e)}`));

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    switches = api.app.get(KillSwitchService);
    modelos = new ModelosDeTeste(config);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await ownerQuery(`delete from liame.ai_model_route where task like $1`, [`${RODADA}%`]);
    await ownerQuery(`delete from liame.ai_model_price where model like $1`, [`${RODADA}%`]);
    await api?.close();
  });

  it('a API sobe com o gateway registrado, e sem chave do fornecedor nenhum modelo existe', () => {
    expect(api.app.get(AiGateway)).toBeInstanceOf(AiGateway);
    expect(new ModelosIa({ ...config, ai: { ...config.ai, anthropicApiKey: null } }).modelo('anthropic', 'qualquer')).toBeNull();
    expect(api.app.get(ModelosIa).modelo('outro_fornecedor', 'qualquer')).toBeNull();
  });

  it('a flag `ia` nasce desligada, e a aposentadoria de modelos do fornecedor está entre as fontes do Vigia', async () => {
    const [flag] = await ownerQuery<{ default_value: boolean; is_write: boolean }>(`select default_value, is_write from liame.feature_flag where key = 'ia'`);
    expect(flag).toEqual({ default_value: false, is_write: false });
    const fontes = await ownerQuery<{ url: string; active: boolean }>(`select url, active from liame.watch_source where provider = 'anthropic'`);
    expect(fontes).toEqual([{ url: 'https://platform.claude.com/docs/en/about-claude/model-deprecations', active: true }]);
    expect(fontes.every((f) => HOSTS_DO_VIGIA.has(new URL(f.url).hostname))).toBe(true);
  });

  it('A3-2: toda chamada gera `ai_usage` com o custo da tabela de preços, contando o cache', async () => {
    const d = await dono();
    const m = await modelo(responde('O custo por pedido subiu porque o investimento cresceu e os pedidos não.', uso(1000, 500, 2000, 300)));
    const task = await rota(m);
    const r = await gateway().generate(pedido(d, task));
    expect(r).toMatchObject({ text: 'O custo por pedido subiu porque o investimento cresceu e os pedidos não.', servedBy: 'principal', provider: 'teste', model: m.model, routeVersion: 3, costUsdMicros: 15_900, finishReason: 'stop' });

    const [linha, ...outras] = await usos(d.tenantId, task);
    expect(outras).toEqual([]);
    expect(linha).toMatchObject({
      id: r.usageId,
      user_id: d.userId,
      workflow: 'resultados.explicar',
      route_version: 3,
      prompt_version: 'explicar@1',
      provider: 'teste',
      model: m.model,
      served_by: 'principal',
      inference_geo: null,
      input_tokens: 1000,
      cache_read_tokens: 2000,
      cache_write_tokens: 300,
      output_tokens: 500,
      cost_usd_micros: 15_900,
      outcome: 'ok',
      error_code: null,
      pii_removed: 0,
    });
    // O limite de saída e o prazo da rota chegam ao modelo; a tentativa extra do SDK é uma só.
    expect(m.mock.doGenerateCalls[0]).toMatchObject({ maxOutputTokens: 4000 });
    expect(m.mock.doGenerateCalls[0]!.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('A3-2: na Anthropic, rodar nos Estados Unidos entra no pedido e no custo (10% a mais); o esforço vem da rota', async () => {
    const d = await dono();
    // O modelo e o preço são os da tabela publicada (migration 0028): US$ 4 e US$ 20 por milhão.
    const mock = responde('ok');
    modelos.porChave.set('anthropic/claude-opus-5-5', mock);
    const task = await rota({ provider: 'anthropic', model: 'claude-opus-5-5' }, { effort: 'low' });

    const us = await gateway({ inferenceGeo: 'us' }).generate(pedido(d, task));
    expect(us.costUsdMicros).toBe(15_400);
    expect(mock.doGenerateCalls[0]!.providerOptions).toEqual({ anthropic: { inferenceGeo: 'us', effort: 'low' } });

    const global = await gateway({ inferenceGeo: 'global' }).generate(pedido(d, task));
    expect(global.costUsdMicros).toBe(14_000);
    expect(mock.doGenerateCalls[1]!.providerOptions).toEqual({ anthropic: { effort: 'low' } });
    expect((await usos(d.tenantId, task)).map((u) => [u.inference_geo, u.cost_usd_micros])).toEqual([['us', 15_400], ['global', 14_000]]);
    modelos.porChave.delete('anthropic/claude-opus-5-5');
  });

  it('A3-3: dado pessoal sai antes do envio e não fica no banco, na resposta nem no span', async () => {
    const d = await dono();
    const m = await modelo(responde('Ligue para (21) 98888-7777 e confirme com maria@cliente.com.'));
    const task = await rota(m);
    spans.reset();
    const r = await gateway().generate(
      pedido(d, task, {
        instructions: 'Responda como analista. Dúvidas: suporte@agencia.com.br',
        messages: [
          { role: 'user', content: 'A cliente Ana (ana.souza@gmail.com, 21 99876-5432, CPF 123.456.789-09, CEP 20040-020) reclamou do cupom PIZZA10.' },
          { role: 'assistant', content: 'Entendi.' },
          { role: 'user', content: 'E o pedido de +55 (11) 91234-5678?' },
        ],
      }),
    );
    const PESSOAIS = ['ana.souza@gmail.com', '99876-5432', '123.456.789-09', '20040-020', '91234-5678', 'suporte@agencia.com.br', '98888-7777', 'maria@cliente.com'];
    const semDado = (texto: string) => PESSOAIS.filter((p) => texto.includes(p));

    // O que o modelo recebeu.
    const enviado = JSON.stringify(m.mock.doGenerateCalls[0]!.prompt);
    expect(semDado(enviado)).toEqual([]);
    expect(enviado).toContain('PIZZA10');
    expect(enviado).toContain('[email]');
    // O que voltou para quem chamou.
    expect(r.text).toBe('Ligue para [telefone] e confirme com [email].');
    // O que ficou guardado (30 dias) e a contagem do que saiu.
    const [guardado] = await ownerQuery<{ request: unknown; response: unknown }>(`select request, response from liame.ai_exchange where usage_id = $1`, [r.usageId]);
    expect(semDado(JSON.stringify(guardado))).toEqual([]);
    expect(guardado!.response).toEqual({ text: 'Ligue para [telefone] e confirme com [email].' });
    expect((await usos(d.tenantId, task))[0]).toMatchObject({ pii_removed: 6 });
    // O span: só dado técnico, nunca o conteúdo.
    const span = spans.getFinishedSpans().find((s) => s.name === `chat ${m.model}`)!;
    expect(span.attributes).toMatchObject({ 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'teste', 'gen_ai.request.model': m.model, 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 500, 'liame.ai.task': task });
    const noSpan = JSON.stringify([span.attributes, span.events, span.status]);
    expect(semDado(noSpan)).toEqual([]);
    expect(noSpan).not.toContain('PIZZA10');
    expect((await usos(d.tenantId, task))[0]!.trace_id).toBe(span.spanContext().traceId);
  });

  it('A3-6: com a flag desligada nada é chamado nem gravado; sem rota ativa, também não', async () => {
    const desligada = await dono('Sem IA', false);
    const m = await modelo(responde('não deveria responder'));
    const task = await rota(m);
    expect(await falha(gateway().generate(pedido(desligada, task)))).toBe('desligada');

    const ligada = await dono();
    expect(await falha(gateway().generate(pedido(ligada, `${RODADA}_sem_rota`)))).toBe('sem-rota');
    await ownerQuery(`insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, max_output_tokens, max_cost_usd_micros, created_by)
                      values (gen_random_uuid(), $1, 1, 'rascunho', 'analise', 'teste', $2, 1000, 1000, 'testes')`, [`${RODADA}_rascunho`, m.model]);
    expect(await falha(gateway().generate(pedido(ligada, `${RODADA}_rascunho`)))).toBe('sem-rota');

    // Entrada grande demais não chega ao modelo: um pedido só não pode passar do teto do dia.
    const enorme = pedido(ligada, task, { messages: [{ role: 'user', content: 'x'.repeat(ENTRADA_MAXIMA) }] });
    expect(await falha(gateway().generate(enorme))).toBe('entrada-grande');

    expect(m.mock.doGenerateCalls).toHaveLength(0);
    const [n] = await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.ai_usage where tenant_id = any($1::uuid[])`, [[desligada.tenantId, ligada.tenantId]]);
    expect(n!.n).toBe('0');
  });

  it('A3-9: a parada trava a IA (a da empresa e a do provider `ai`, da distribuição) e, desligada, libera', async () => {
    const d = await dono();
    const m = await modelo(responde('ok'));
    const task = await rota(m);
    const conferida = vi.spyOn(switches, 'check');
    const on = await api.call('POST', '/v1/kill-switches', { cookie: d.cookie, body: { level: 'tenant', reason: 'gasto estranho' } });
    expect(on.status).toBe(201);
    expect(await falha(gateway().generate(pedido(d, task)))).toBe('travada');
    expect(m.mock.doGenerateCalls).toHaveLength(0);
    // O alvo conferido é o provider `ai`: a trava da distribuição para o fornecedor inteiro pega por aqui.
    expect(conferida).toHaveBeenLastCalledWith(expect.anything(), { tenantId: d.tenantId, provider: 'ai', brandId: null });
    conferida.mockRestore();

    expect((await api.call('DELETE', `/v1/kill-switches/${on.body.id}`, { cookie: d.cookie })).status).toBe(204);
    expect((await gateway().generate(pedido(d, task))).text).toBe('ok');
  });

  it('D-A3-3: perto do teto vai para o modelo econômico; no teto, barra e registra; outra empresa não é afetada', async () => {
    const [a, b] = [await dono('Empresa A'), await dono('Empresa B')];
    const principal = await modelo(responde('resposta do principal'));
    const economico = await modelo(responde('resposta do econômico'), true);
    const task = await rota(principal, { economico });
    // Teto de A: US$ 0,10 por dia (o padrão da configuração vale para B).
    await ownerQuery(`insert into liame.ai_budget (tenant_id, daily_usd_micros, monthly_usd_micros, set_by, reason) values ($1, 100000, 1000000, 'testes', 'teste do teto')`, [a.tenantId]);

    await gastar(a.tenantId, 66_000);
    // 66% → modelo principal (US$ 0,014) → 80%.
    expect(await gateway().generate(pedido(a, task))).toMatchObject({ servedBy: 'principal', costUsdMicros: 14_000 });
    // 80% → econômico (US$ 0,0035) → 83,5%.
    expect(await gateway().generate(pedido(a, task))).toMatchObject({ servedBy: 'economico', model: economico.model, text: 'resposta do econômico', costUsdMicros: 3_500 });
    await gastar(a.tenantId, 16_500);
    // 100% → nada é chamado; fica o registro do pedido barrado, sem modelo e sem custo.
    expect(await falha(gateway().generate(pedido(a, task)))).toBe('teto');
    expect(principal.mock.doGenerateCalls).toHaveLength(1);
    expect(economico.mock.doGenerateCalls).toHaveLength(1);
    expect((await usos(a.tenantId, task)).map((u) => [u.outcome, u.served_by, u.model === null, u.cost_usd_micros])).toEqual([
      ['ok', 'principal', false, 14_000],
      ['ok', 'economico', false, 3_500],
      ['teto', null, true, 0],
    ]);

    // O gasto de A não conta para B.
    expect(await gateway().generate(pedido(b, task))).toMatchObject({ servedBy: 'principal' });
    // Rota sem modelo econômico: perto do teto segue no principal, até barrar.
    const semEconomico = await rota(principal);
    await ownerQuery(`update liame.ai_budget set daily_usd_micros = 120000 where tenant_id = $1`, [a.tenantId]);
    expect(await gateway().generate(pedido(a, semEconomico))).toMatchObject({ servedBy: 'principal' });
  });

  it('limite por pessoa: passou das chamadas da hora, barra só ela; a rotina do sistema segue', async () => {
    const d = await dono();
    const m = await modelo(responde('ok'));
    const task = await rota(m);
    const g = gateway({ userHourlyCalls: 2 });
    await g.generate(pedido(d, task));
    await g.generate(pedido(d, task));
    expect(await falha(g.generate(pedido(d, task)))).toBe('limite-usuario');
    expect(m.mock.doGenerateCalls).toHaveLength(2);
    expect((await usos(d.tenantId, task)).map((u) => u.outcome)).toEqual(['ok', 'ok', 'limite_usuario']);
    expect((await g.generate(pedido(d, task, { userId: null }))).text).toBe('ok');
  });

  it('A3-6: o principal falha e a reserva DA ROTA responde; sem ninguém, indisponível, com tudo registrado', async () => {
    const d = await dono();
    const principal = await modelo(recusa(400));
    const reserva = await modelo(responde('resposta da reserva'));
    const task = await rota(principal, { reserva: [reserva] });
    const r = await gateway().generate(pedido(d, task));
    expect(r).toMatchObject({ servedBy: 'reserva', model: reserva.model, text: 'resposta da reserva', costUsdMicros: 14_000 });
    expect((await usos(d.tenantId, task)).map((u) => [u.model, u.served_by, u.outcome, u.error_code, u.cost_usd_micros])).toEqual([
      [principal.model, 'principal', 'erro', 'http_400', 0],
      [reserva.model, 'reserva', 'ok', null, 14_000],
    ]);

    // Fornecedor fora do ar, sem credencial e sem preço: quem chama recebe um só erro e cai no caminho sem IA.
    const semPreco = `${RODADA}_sem_preco`;
    modelos.porChave.set(`teste/${semPreco}`, responde('não pode rodar: não há como medir o custo'));
    const fora = await rota(principal, { reserva: [{ provider: 'teste', model: `${RODADA}_sem_credencial` }, { provider: 'teste', model: semPreco }] });
    expect(await falha(gateway().generate(pedido(d, fora)))).toBe('indisponivel');
    const linhas = await usos(d.tenantId, fora);
    expect(linhas.map((u) => [u.outcome, u.error_code, u.cost_usd_micros])).toEqual([['erro', 'http_400', 0], ['erro', 'sem_credencial', 0], ['erro', 'sem_preco', 0]]);
    expect(modelos.porChave.get(`teste/${semPreco}`)!.doGenerateCalls).toHaveLength(0);
    const [guardado] = await ownerQuery<{ response: unknown; request: { messages: unknown[] } }>(`select request, response from liame.ai_exchange where usage_id = $1`, [linhas[2]!.id]);
    expect(guardado).toMatchObject({ response: null, request: { messages: [{ role: 'user' }] } });
  });

  it('o prazo da rota corta a chamada que não volta', async () => {
    const d = await dono();
    const lento = await modelo(
      new MockLanguageModelV4({
        doGenerate: ({ abortSignal }) => new Promise((_, reject) => abortSignal!.addEventListener('abort', () => reject(abortSignal!.reason), { once: true })),
      }),
    );
    const task = await rota(lento, { timeoutMs: 1000 });
    const inicio = Date.now();
    expect(await falha(gateway().generate(pedido(d, task)))).toBe('indisponivel');
    expect(Date.now() - inicio).toBeLessThan(10_000);
    expect((await usos(d.tenantId, task)).map((u) => [u.outcome, u.error_code])).toEqual([['erro', 'tempo_esgotado']]);
  });

  it('resposta estruturada: devolve o objeto no formato pedido; fora do formato é falha, e o que foi gerado é cobrado', async () => {
    const d = await dono();
    const Explicacao = z.object({ motivos: z.array(z.string()).min(1), risco: z.enum(['baixo', 'medio', 'alto']) });
    const certo = await modelo(responde(JSON.stringify({ motivos: ['investimento subiu 20%', 'fale com ze@loja.com'], risco: 'medio' })));
    const task = await rota(certo);
    const r = await gateway().structured({ ...pedido(d, task), schema: Explicacao });
    expect(r.object).toEqual({ motivos: ['investimento subiu 20%', 'fale com [email]'], risco: 'medio' });
    const [guardado] = await ownerQuery<{ response: unknown }>(`select response from liame.ai_exchange where usage_id = $1`, [r.usageId]);
    expect(guardado!.response).toEqual({ object: { motivos: ['investimento subiu 20%', 'fale com [email]'], risco: 'medio' } });

    const errado = await modelo(responde(JSON.stringify({ risco: 'gigante' })));
    const outra = await rota(errado);
    expect(await falha(gateway().structured({ ...pedido(d, outra), schema: Explicacao }))).toBe('indisponivel');
    expect((await usos(d.tenantId, outra)).map((u) => [u.outcome, u.error_code, u.cost_usd_micros])).toEqual([['erro', 'resposta_invalida', 14_000]]);
  });

  it('isolamento: outra empresa não vê o uso nem o conteúdo; a aplicação não altera o uso nem define o próprio teto', async () => {
    const [a, b] = [await dono('Empresa A'), await dono('Empresa B')];
    const m = await modelo(responde('ok'));
    const task = await rota(m);
    const r = await gateway().generate(pedido(a, task));
    const ver = (quem: Dono, tabela: 'ai_usage' | 'ai_exchange') =>
      withContext(database.db, { tenantId: quem.tenantId, userId: quem.userId }, async (tx) => Number((await tx.execute<{ n: string }>(sql`select count(*)::text as n from ${sql.raw(`liame.${tabela}`)}`)).rows[0]!.n));
    expect([await ver(a, 'ai_usage'), await ver(a, 'ai_exchange')]).toEqual([1, 1]);
    expect([await ver(b, 'ai_usage'), await ver(b, 'ai_exchange')]).toEqual([0, 0]);

    const comoA = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext(database.db, { tenantId: a.tenantId, userId: a.userId }, fn);
    await expect(comoA((tx) => tx.execute(sql`update liame.ai_usage set cost_usd_micros = 0 where id = ${r.usageId}`))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(comoA((tx) => tx.execute(sql`delete from liame.ai_usage where id = ${r.usageId}`))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(
      comoA((tx) => tx.execute(sql`insert into liame.ai_budget (tenant_id, daily_usd_micros, monthly_usd_micros, set_by) values (${a.tenantId}, 999999999, 999999999, 'a propria empresa')`)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    // O conteúdo só sai pelo expurgo (escopo de sistema): a empresa não apaga o que serve para investigar abuso.
    expect((await comoA((tx) => tx.execute(sql`delete from liame.ai_exchange where usage_id = ${r.usageId} returning usage_id`))).rows).toEqual([]);
  });

  // ------------------------------------------------------------------ laço com ferramentas (I2)

  const rodada = (content: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }>) => ({
    content,
    finishReason: { unified: content.some((c) => c.type === 'tool-call') ? ('tool-calls' as const) : ('stop' as const), raw: undefined },
    usage: uso(1000, 500),
    warnings: [],
  });
  const pede = (toolName: string, input: unknown = {}, toolCallId = `chamada-${randomBytes(3).toString('hex')}`) => rodada([{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }]);
  const diz = (text: string) => rodada([{ type: 'text', text }]);
  const roteiro = (...passos: Array<ReturnType<typeof rodada>>) => new MockLanguageModelV4({ doGenerate: passos });
  const ferramentaDeTeste = (executar: FerramentaIa['executar'], name = 'ler_teste'): FerramentaIa => ({ name, description: 'Lê um dado de teste.', input: z.strictObject({ marca: z.string().optional() }), executar });

  it('A3-4: o modelo pede uma leitura, o código executa com a permissão e a empresa da pessoa, e cada rodada é registrada', async () => {
    const [a, b] = [await dono('Empresa A'), await dono('Empresa B')];
    const marcaA = (await api.call('GET', '/v1/brands', { cookie: a.cookie })).body.items[0].id as string;
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone)
       values (gen_random_uuid(), $1, $2, 'meta_ads', 'act_' || $3, 'Conta da Pizzaria A', 'BRL', 'America/Sao_Paulo')`,
      [a.tenantId, marcaA, Math.floor(Math.random() * 1e9).toString()],
    );
    const leituras = api.app.get(FerramentasDeLeitura);
    const m = await modelo(roteiro(pede('fontes_frescor', { brand_id: marcaA }), diz('A conta da Meta nunca foi lida.'), pede('fontes_frescor', { brand_id: marcaA }), diz('Não há contas.')));
    const task = await rota(m);

    // A pessoa tem `contas.ver` e não tem `campanhas.ver`: só a leitura das contas é oferecida ao modelo.
    const ferramentas = leituras.paraPedido({ tenantId: a.tenantId, userId: a.userId, permissions: new Set(['contas.ver']) });
    expect(ferramentas.map((f) => f.name)).toEqual(['fontes_frescor']);
    const r = await gateway().agent({ ...pedido(a, task), ferramentas });
    expect(r).toMatchObject({ text: 'A conta da Meta nunca foi lida.', rodadas: 2, ferramentas: [{ name: 'fontes_frescor', ok: true }], costUsdMicros: 28_000, finishReason: 'stop' });
    expect(m.mock.doGenerateCalls[0]!.tools?.map((t) => t.name)).toEqual(['fontes_frescor']);
    // A segunda rodada recebeu o resultado da ferramenta, com a conta DA EMPRESA A.
    const segunda = JSON.stringify(m.mock.doGenerateCalls[1]!.prompt);
    expect(segunda).toContain('Conta da Pizzaria A');
    expect(segunda).toContain('nunca leu');
    const linhas = await ownerQuery<{ id: string; tool_calls: number; tool_failures: number; cost_usd_micros: number }>(
      `select id, tool_calls, tool_failures, cost_usd_micros::int from liame.ai_usage where tenant_id = $1 and task = $2 order by occurred_at, id`,
      [a.tenantId, task],
    );
    expect(linhas.map((l) => [l.tool_calls, l.tool_failures, l.cost_usd_micros])).toEqual([[1, 0, 14_000], [0, 0, 14_000]]);
    expect(linhas[1]!.id).toBe(r.usageId);
    const [guardado] = await ownerQuery<{ response: unknown }>(`select response from liame.ai_exchange where usage_id = $1`, [r.usageId]);
    expect(guardado!.response).toEqual({ text: 'A conta da Meta nunca foi lida.', tools: [{ name: 'fontes_frescor', ok: true }] });

    // A empresa B pede a marca da A: o banco não entrega, e nada da A chega ao modelo.
    const deB = leituras.paraPedido({ tenantId: b.tenantId, userId: b.userId, permissions: new Set(['contas.ver', 'campanhas.ver']) });
    expect(deB.map((f) => f.name)).toEqual(['fontes_frescor', 'atencao_avisos', 'midia_entrega']);
    await gateway().agent({ ...pedido(b, task), ferramentas: deB });
    const paraB = JSON.stringify(m.mock.doGenerateCalls[3]!.prompt);
    expect(paraB).not.toContain('Conta da Pizzaria A');
    expect(paraB).toContain('"contas":[]');
  });

  it('ferramenta que falha vira um aviso curto para o modelo, a saída volta sem dado pessoal, e o laço segue', async () => {
    const d = await dono();
    const m = await modelo(
      roteiro(pede('ler_teste'), rodada([{ type: 'tool-call', toolCallId: 'c2', toolName: 'quebra', input: '{}' }, { type: 'tool-call', toolCallId: 'c3', toolName: 'recusa', input: '{}' }]), pede('gigante'), diz('Pronto.')),
    );
    const task = await rota(m);
    const r = await gateway().agent({
      ...pedido(d, task),
      ferramentas: [
        ferramentaDeTeste(async () => ({ ok: true, valor: { contato: 'fale com dono@loja.com', pedidos: '38 pedidos' } })),
        ferramentaDeTeste(async () => {
          throw new Error('erro interno com detalhe que o modelo não precisa ver');
        }, 'quebra'),
        ferramentaDeTeste(async () => ({ ok: false, erro: 'Marca não encontrada nesta empresa.' }), 'recusa'),
        // Saída maior que o máximo: não volta ao modelo (ela seria entrada paga da rodada seguinte).
        ferramentaDeTeste(async () => ({ ok: true, valor: { linhas: 'linha repetida '.repeat(SAIDA_DA_FERRAMENTA_MAXIMA / 10) } }), 'gigante'),
      ],
    });
    expect(r).toMatchObject({
      text: 'Pronto.',
      rodadas: 4,
      ferramentas: [{ name: 'ler_teste', ok: true }, { name: 'quebra', ok: false }, { name: 'recusa', ok: false }, { name: 'gigante', ok: false }],
    });
    const quarta = JSON.stringify(m.mock.doGenerateCalls[3]!.prompt);
    expect(quarta).toContain('O resultado é grande demais');
    expect(quarta).not.toContain('linha repetida linha repetida');
    const [segunda, terceira] = [JSON.stringify(m.mock.doGenerateCalls[1]!.prompt), JSON.stringify(m.mock.doGenerateCalls[2]!.prompt)];
    expect(segunda).toContain('fale com [email]');
    expect(segunda).toContain('38 pedidos');
    expect(terceira).toContain('Não foi possível ler agora.');
    expect(terceira).toContain('Marca não encontrada nesta empresa.');
    expect(terceira).not.toContain('erro interno');
    expect((await ownerQuery<{ c: number; f: number }>(`select tool_calls as c, tool_failures as f from liame.ai_usage where tenant_id = $1 and task = $2 order by occurred_at, id`, [d.tenantId, task])).map((l) => [l.c, l.f])).toEqual([[1, 0], [2, 2], [1, 1], [0, 0]]);
  });

  it('A3-9: o laço para no limite de rodadas e no teto da empresa, com tudo registrado', async () => {
    const d = await dono();
    const insistente = () => roteiro(...Array.from({ length: 8 }, () => pede('ler_teste')));
    const ferramentas = [ferramentaDeTeste(async () => ({ ok: true, valor: { ok: true } }))];

    const m = await modelo(insistente());
    const task = await rota(m, { maxCost: 1_000_000 });
    expect(await falha(gateway().agent({ ...pedido(d, task), ferramentas, maxRodadas: 3 }))).toBe('indisponivel');
    expect(m.mock.doGenerateCalls).toHaveLength(3);
    const linhas = await usos(d.tenantId, task);
    expect(linhas.map((u) => u.outcome)).toEqual(['ok', 'ok', 'ok']);
    const [guardado] = await ownerQuery<{ response: { stopped: string; tools: unknown[] } }>(`select response from liame.ai_exchange where usage_id = $1`, [linhas[2]!.id]);
    expect(guardado!.response).toMatchObject({ stopped: 'rodadas' });
    expect(guardado!.response.tools).toHaveLength(3);

    // Teto de US$ 0,06 no dia: o que este pedido já gastou conta a cada rodada (3 × US$ 0,014 já gastos + 2 rodadas).
    await ownerQuery(`insert into liame.ai_budget (tenant_id, daily_usd_micros, monthly_usd_micros, set_by) values ($1, 60000, 1000000, 'testes')`, [d.tenantId]);
    const outro = await modelo(insistente());
    const outra = await rota(outro, { maxCost: 1_000_000 });
    expect(await falha(gateway().agent({ ...pedido(d, outra), ferramentas }))).toBe('teto');
    expect(outro.mock.doGenerateCalls).toHaveLength(2);

    // Teto de custo da própria rota (US$ 0,02 por pedido): para na rodada em que passa dele.
    const [e, cara] = [await dono(), await modelo(insistente())];
    const curta = await rota(cara, { maxCost: 20_000 });
    expect(await falha(gateway().agent({ ...pedido(e, curta), ferramentas }))).toBe('indisponivel');
    expect(cara.mock.doGenerateCalls).toHaveLength(2);
  });

  it('o conteúdo sai em 30 dias e fica só o registro técnico do uso', async () => {
    const d = await dono();
    const m = await modelo(responde('ok'));
    const task = await rota(m);
    const g = gateway();
    const [antigo, recente] = [await g.generate(pedido(d, task)), await g.generate(pedido(d, task))];
    await ownerQuery(`update liame.ai_exchange set created_at = now() - interval '31 days' where usage_id = $1`, [antigo.usageId]);

    const purge = new LifecyclePurgeService(database, api.app.get(VaultService), api.app.get(Mailer));
    expect(await purge.purgeRetention({ tenantIds: [d.tenantId], userIds: [d.userId] })).toMatchObject({ conteudo_ia: 1 });
    const sobrou = await ownerQuery<{ usage_id: string }>(`select usage_id from liame.ai_exchange where tenant_id = $1`, [d.tenantId]);
    expect(sobrou.map((x) => x.usage_id)).toEqual([recente.usageId]);
    expect(await usos(d.tenantId, task)).toHaveLength(2);
  });
});
