import { type Database, type Tx, uuidv7, withContext } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { APICallError, generateText, type LanguageModel, type LanguageModelUsage, NoObjectGeneratedError, Output, RetryError } from 'ai';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { type Esforco, ModelosIa } from './modelos.js';
import { custoMicros, type PrecoModelo, type TokensUsados, tokensDe } from './precos.js';
import { limparJson, limparTexto } from './sanitizar.js';
import { type Gasto, situacaoDoTeto, virouDeFaixa } from './teto.js';

// AI Gateway (ADR-006, `ai-architecture.md` §2): o único caminho até um modelo. Em toda chamada:
// flag `ia` da empresa → trava (kill switch do provider `ai`) → rota ativa da tarefa → limite por pessoa
// → teto de custo → remoção de dado pessoal → modelo (com reserva só da rota) → custo → `ai_usage`.
// Nada disso roda dentro da transação da requisição: a chamada ao modelo leva segundos, e o custo
// precisa ficar gravado mesmo que a requisição desista.
//
// Quem monta o contexto manda os números já formatados ("R$ 1.250,00", "12.500 cliques"): número cru
// de 10 dígitos ou mais parece telefone ou CPF e sai na limpeza (`pii_removed` mostra quando aconteceu).

export type AiErrorCode = 'desligada' | 'entrada-grande' | 'travada' | 'sem-rota' | 'limite-usuario' | 'teto' | 'indisponivel';

/**
 * Tamanho máximo da entrada (instruções + mensagens), em caracteres. O teto de custo é conferido antes
 * da chamada: sem este limite, um pedido só (contexto de um milhão de tokens) passaria do teto do dia.
 */
export const ENTRADA_MAXIMA = 200_000;

/** Toda falha da IA é esta. Quem chama cai no caminho sem IA: tela, aviso e relatório seguem (A3-6). */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  tenantId: string;
  brandId?: string | null;
  /** Quem pediu; nulo em rotina do sistema (relatório noturno). */
  userId?: string | null;
  /** De onde veio o pedido, para o custo por fluxo (ex.: `resultados.explicar`). */
  workflow: string;
  /** Tarefa: escolhe a rota de modelo (`ai_model_route`). */
  task: string;
  promptVersion?: string | null;
  instructions: string;
  messages: AiMessage[];
}

export interface GenerateResult {
  /** Linha de `ai_usage` desta resposta. */
  usageId: string;
  text: string;
  servedBy: ServidoPor;
  provider: string;
  model: string;
  routeVersion: number;
  costUsdMicros: number;
  finishReason: string;
}

export interface StructuredRequest<T> extends GenerateRequest {
  schema: z.ZodType<T>;
}

export interface StructuredResult<T> extends Omit<GenerateResult, 'text'> {
  object: T;
}

type ServidoPor = 'principal' | 'reserva' | 'economico';

interface Candidato {
  provider: string;
  model: string;
  servedBy: ServidoPor;
}

type Rota = {
  version: number;
  provider: string;
  model: string;
  effort: Esforco | null;
  max_output_tokens: number;
  timeout_ms: number;
  max_cost_usd_micros: string;
  fallback: Array<{ provider: string; model: string }>;
  economy_provider: string | null;
  economy_model: string | null;
};

type Preparo =
  | { barrado: 'travada' | 'sem-rota' | 'limite-usuario' | 'teto' }
  | { barrado: null; rota: Rota; gasto: Gasto; candidatos: Candidato[]; precos: Map<string, PrecoModelo> };

interface Tentativa {
  id: string;
  candidato: Candidato;
  geo: 'us' | 'global' | null;
  tokens: TokensUsados;
  custo: bigint;
  latenciaMs: number;
  outcome: 'ok' | 'erro';
  errorCode: string | null;
  traceId: string | null;
  /** Quando a tentativa terminou (ms): a ordem das tentativas de um pedido fica no registro. */
  em: number;
}

const SEM_TOKENS: TokensUsados = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
const chave = (provider: string, model: string) => `${provider}/${model}`;
const tracer = trace.getTracer('liame');

@Injectable()
export class AiGateway {
  private readonly logger = new Logger('ia');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly switches: KillSwitchService,
    private readonly modelos: ModelosIa,
  ) {}

  private get db() {
    if (!this.database) throw new AiError('indisponivel', 'ia: sem banco');
    return this.database.db;
  }

  /** Texto livre. */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const r = await this.run(req, null);
    return { ...r.base, text: r.text };
  }

  /** Resposta no formato do schema: o que não valida conta como falha e passa para a reserva da rota. */
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const r = await this.run(req, req.schema);
    return { ...r.base, object: r.object as T };
  }

  private async run(req: GenerateRequest, schema: z.ZodType<unknown> | null): Promise<{ base: Omit<GenerateResult, 'text'>; text: string; object: unknown }> {
    const contexto = { tenantId: req.tenantId, userId: req.userId ?? null };
    if (!(await this.flags.isEnabled('ia', this.flags.context({ ...contexto, brandId: req.brandId ?? null })))) {
      throw new AiError('desligada', 'ia: desligada para esta empresa');
    }
    const tamanho = req.instructions.length + req.messages.reduce((n, m) => n + m.content.length, 0);
    if (tamanho > ENTRADA_MAXIMA) {
      this.logger.warn(`ia: ${req.task} (${req.workflow}) com entrada de ${tamanho} caracteres, acima do máximo de ${ENTRADA_MAXIMA}`);
      throw new AiError('entrada-grande', 'ia: entrada grande demais');
    }
    const db = this.db;
    const preparo = await withContext(db, contexto, (tx) => this.preparar(tx, req));
    if (preparo.barrado) throw new AiError(preparo.barrado, `ia: ${preparo.barrado}`);
    const { rota, gasto, candidatos, precos } = preparo;

    const instrucoes = limparTexto(req.instructions);
    const mensagens = req.messages.map((m) => ({ role: m.role, ...limparTexto(m.content) }));
    const removidos = instrucoes.removidos + mensagens.reduce((n, m) => n + m.removidos, 0);
    const enviado = { instructions: instrucoes.texto, messages: mensagens.map((m) => ({ role: m.role, content: m.texto })) };

    const tentativas: Tentativa[] = [];
    // Duas tentativas no mesmo milissegundo não trocam de ordem no registro.
    const guardar = (t: Tentativa) => tentativas.push({ ...t, em: Math.max(t.em, (tentativas[tentativas.length - 1]?.em ?? 0) + 1) });
    let resposta: { text: string; object: unknown; finishReason: string } | null = null;
    for (const candidato of candidatos) {
      const model = this.modelos.modelo(candidato.provider, candidato.model);
      const preco = precos.get(chave(candidato.provider, candidato.model));
      // Sem credencial ou sem preço cadastrado o modelo não roda: custo que não se mede não se gasta (A3-2).
      if (!model || !preco) {
        guardar(this.falha(candidato, model ? 'sem_preco' : 'sem_credencial'));
        continue;
      }
      const t = await this.chamar(req, rota, candidato, model, preco, enviado, schema);
      guardar(t.tentativa);
      if (t.resposta) {
        resposta = t.resposta;
        break;
      }
    }

    const ultima = tentativas[tentativas.length - 1]!;
    const guardado = resposta ? limparJson(schema ? { object: resposta.object } : { text: resposta.text }).valor : null;
    try {
      await withContext(db, contexto, async (tx) => {
        for (const t of tentativas) await this.registrar(tx, req, rota, t, removidos);
        // O conteúdo (já sem dado pessoal) fica 30 dias, para investigar erro e abuso; depois, só a linha de uso.
        await tx.execute(sql`
          insert into liame.ai_exchange (usage_id, tenant_id, request, response)
          values (${ultima.id}, ${req.tenantId}, ${JSON.stringify(enviado)}::jsonb, ${guardado === null ? null : JSON.stringify(guardado)}::jsonb)`);
      });
    } catch (err) {
      // Resposta sem registro de custo furaria o teto: não é entregue. O log leva os números para a conferência.
      this.logger.error(
        `ia: registro de uso falhou (${err instanceof Error ? err.message : String(err)}); tarefa ${req.task}, empresa ${req.tenantId}, ` +
          tentativas.map((t) => `${chave(t.candidato.provider, t.candidato.model)} ${t.outcome} ${t.custo} micros`).join('; '),
      );
      throw new AiError('indisponivel', 'ia: não foi possível registrar o uso');
    }

    if (!resposta) {
      this.logger.warn(`ia: ${req.task} sem resposta (${tentativas.map((t) => `${chave(t.candidato.provider, t.candidato.model)}: ${t.errorCode}`).join('; ')})`);
      throw new AiError('indisponivel', 'ia: nenhum modelo da rota respondeu');
    }
    const total = tentativas.reduce((n, t) => n + t.custo, 0n);
    if (ultima.custo > BigInt(rota.max_cost_usd_micros)) {
      this.logger.warn(`ia: ${req.task} v${rota.version} custou ${ultima.custo} micros, acima do teto da rota (${rota.max_cost_usd_micros})`);
    }
    const faixa = virouDeFaixa(gasto, total);
    if (faixa) this.logger.warn(`ia: a empresa ${req.tenantId} entrou na faixa "${faixa}" do teto de custo de IA`);

    // O que sai daqui também vai limpo: se o modelo escrever um contato, ele não chega à tela.
    const limpa = limparJson({ text: resposta.text, object: resposta.object }).valor as { text: string; object: unknown };
    return {
      base: {
        usageId: ultima.id,
        servedBy: ultima.candidato.servedBy,
        provider: ultima.candidato.provider,
        model: ultima.candidato.model,
        routeVersion: rota.version,
        costUsdMicros: Number(ultima.custo),
        finishReason: resposta.finishReason,
      },
      text: limpa.text,
      object: limpa.object,
    };
  }

  /** Tudo o que se decide antes de gastar: trava, rota, limite por pessoa, teto e preços. */
  private async preparar(tx: Tx, req: GenerateRequest): Promise<Preparo> {
    if (await this.switches.check(tx, { tenantId: req.tenantId, provider: 'ai', brandId: req.brandId ?? null })) return { barrado: 'travada' };

    const rota = (
      await tx.execute<Rota>(sql`
        select version, provider, model, effort, max_output_tokens, timeout_ms, max_cost_usd_micros::text as max_cost_usd_micros,
               fallback, economy_provider, economy_model
          from liame.ai_model_route where task = ${req.task} and status = 'ativa'`)
    ).rows[0];
    if (!rota) return { barrado: 'sem-rota' };

    if (req.userId) {
      const r = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from liame.ai_usage
         where tenant_id = ${req.tenantId} and user_id = ${req.userId} and model is not null and occurred_at > now() - interval '1 hour'`);
      if ((r.rows[0]?.n ?? 0) >= this.config.ai.userHourlyCalls) {
        await this.registrarBarrado(tx, req, rota, 'limite_usuario');
        return { barrado: 'limite-usuario' };
      }
    }

    // Dia e mês viram no fuso da empresa, como o orçamento de mídia.
    const g = (
      await tx.execute<{ teto_dia: string; teto_mes: string; gasto_dia: string; gasto_mes: string }>(sql`
        select coalesce(b.daily_usd_micros, ${this.config.ai.dailyLimitUsdMicros})::text as teto_dia,
               coalesce(b.monthly_usd_micros, ${this.config.ai.monthlyLimitUsdMicros})::text as teto_mes,
               (select coalesce(sum(u.cost_usd_micros), 0)::text from liame.ai_usage u
                 where u.tenant_id = o.id and u.occurred_at >= date_trunc('day', now() at time zone o.timezone) at time zone o.timezone) as gasto_dia,
               (select coalesce(sum(u.cost_usd_micros), 0)::text from liame.ai_usage u
                 where u.tenant_id = o.id and u.occurred_at >= date_trunc('month', now() at time zone o.timezone) at time zone o.timezone) as gasto_mes
          from liame.organization o left join liame.ai_budget b on b.tenant_id = o.id
         where o.id = ${req.tenantId}`)
    ).rows[0];
    if (!g) throw new Error('ia: empresa não encontrada no contexto');
    const gasto: Gasto = { gastoDia: BigInt(g.gasto_dia), gastoMes: BigInt(g.gasto_mes), tetoDia: BigInt(g.teto_dia), tetoMes: BigInt(g.teto_mes) };
    const situacao = situacaoDoTeto(gasto);
    if (situacao === 'bloqueado') {
      await this.registrarBarrado(tx, req, rota, 'teto');
      return { barrado: 'teto' };
    }

    // A partir de 80% do teto, só o modelo econômico da rota (quando ela tem um, com eval aprovado).
    const economico = situacao === 'economico' && rota.economy_provider && rota.economy_model;
    const candidatos: Candidato[] = economico
      ? [{ provider: rota.economy_provider!, model: rota.economy_model!, servedBy: 'economico' }]
      : [
          { provider: rota.provider, model: rota.model, servedBy: 'principal' },
          ...rota.fallback.map((f) => ({ provider: f.provider, model: f.model, servedBy: 'reserva' as const })),
        ];

    const linhas = await tx.execute<{ provider: string; model: string; input: string; output: string; cache_read: string; cache_write_5m: string; cache_write_1h: string }>(sql`
      select distinct on (provider, model) provider, model,
             input_usd_micros_per_mtok::text as input, output_usd_micros_per_mtok::text as output,
             cache_read_usd_micros_per_mtok::text as cache_read, cache_write_5m_usd_micros_per_mtok::text as cache_write_5m,
             cache_write_1h_usd_micros_per_mtok::text as cache_write_1h
        from liame.ai_model_price
       where provider in ${[...new Set(candidatos.map((c) => c.provider))]} and model in ${[...new Set(candidatos.map((c) => c.model))]}
         and valid_from <= (now() at time zone 'UTC')::date
       order by provider, model, valid_from desc`);
    const precos = new Map<string, PrecoModelo>(
      linhas.rows.map((p) => [
        chave(p.provider, p.model),
        { input: BigInt(p.input), output: BigInt(p.output), cacheRead: BigInt(p.cache_read), cacheWrite5m: BigInt(p.cache_write_5m), cacheWrite1h: BigInt(p.cache_write_1h) },
      ]),
    );
    return { barrado: null, rota, gasto, candidatos, precos };
  }

  /** Uma chamada a um modelo, dentro de um span `gen_ai` só com dados técnicos (nunca o conteúdo). */
  private async chamar(
    req: GenerateRequest,
    rota: Rota,
    candidato: Candidato,
    model: LanguageModel,
    preco: PrecoModelo,
    enviado: { instructions: string; messages: AiMessage[] },
    schema: z.ZodType<unknown> | null,
  ): Promise<{ tentativa: Tentativa; resposta: { text: string; object: unknown; finishReason: string } | null }> {
    const geo = this.modelos.geo(candidato.provider);
    const providerOptions = this.modelos.opcoes(candidato.provider, rota.effort);
    const atributos = {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': candidato.provider,
      'gen_ai.request.model': candidato.model,
      'gen_ai.request.max_tokens': rota.max_output_tokens,
      'liame.ai.task': req.task,
      'liame.ai.workflow': req.workflow,
    };
    return tracer.startActiveSpan(`chat ${candidato.model}`, { attributes: atributos }, async (span) => {
      const id = span.spanContext().traceId;
      const traceId = /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : null;
      const inicio = Date.now();
      const tentativa = (outcome: 'ok' | 'erro', usage: LanguageModelUsage | undefined, errorCode: string | null): Tentativa => {
        const tokens = usage ? tokensDe(usage) : SEM_TOKENS;
        span.setAttributes({
          'gen_ai.usage.input_tokens': tokens.input + tokens.cacheRead + tokens.cacheWrite,
          'gen_ai.usage.output_tokens': tokens.output,
          'gen_ai.usage.cache_read.input_tokens': tokens.cacheRead,
          'gen_ai.usage.cache_creation.input_tokens': tokens.cacheWrite,
        });
        return {
          id: uuidv7(),
          candidato,
          geo,
          tokens,
          custo: custoMicros(preco, tokens, { geo: geo ?? 'global' }),
          latenciaMs: Date.now() - inicio,
          outcome,
          errorCode,
          traceId,
          em: Date.now(),
        };
      };
      try {
        const comum = {
          model,
          instructions: enviado.instructions,
          messages: enviado.messages,
          maxOutputTokens: rota.max_output_tokens,
          abortSignal: AbortSignal.timeout(rota.timeout_ms),
          maxRetries: 1,
          // A telemetria do SDK grava entrada e saída: fica desligada; o span daqui leva só o técnico.
          telemetry: { isEnabled: false },
          ...(providerOptions ? { providerOptions } : {}),
        };
        if (schema) {
          const r = await generateText({ ...comum, output: Output.object({ schema }) });
          span.setAttribute('gen_ai.response.finish_reasons', [r.finishReason]);
          return { tentativa: tentativa('ok', r.totalUsage, null), resposta: { text: '', object: r.output, finishReason: r.finishReason } };
        }
        const r = await generateText(comum);
        span.setAttribute('gen_ai.response.finish_reasons', [r.finishReason]);
        return { tentativa: tentativa('ok', r.totalUsage, null), resposta: { text: r.text, object: null, finishReason: r.finishReason } };
      } catch (err) {
        const codigo = codigoDoErro(err);
        // O erro do SDK guarda o corpo enviado: nunca vai para o log nem para o span, só o código.
        span.setStatus({ code: SpanStatusCode.ERROR, message: codigo });
        this.logger.warn(`ia: ${req.task} em ${chave(candidato.provider, candidato.model)} falhou: ${codigo}`);
        // Resposta fora do schema foi gerada e é cobrada: o uso dela entra no custo.
        return { tentativa: tentativa('erro', NoObjectGeneratedError.isInstance(err) ? err.usage : undefined, codigo), resposta: null };
      } finally {
        span.end();
      }
    });
  }

  private falha(candidato: Candidato, errorCode: string): Tentativa {
    return { id: uuidv7(), candidato, geo: null, tokens: SEM_TOKENS, custo: 0n, latenciaMs: 0, outcome: 'erro', errorCode, traceId: null, em: Date.now() };
  }

  private async registrar(tx: Tx, req: GenerateRequest, rota: Rota, t: Tentativa, removidos: number): Promise<void> {
    await tx.execute(sql`
      insert into liame.ai_usage (id, tenant_id, brand_id, user_id, workflow, task, route_version, prompt_version, provider, model, served_by,
                                  inference_geo, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
                                  cost_usd_micros, latency_ms, outcome, error_code, pii_removed, trace_id, occurred_at)
      values (${t.id}, ${req.tenantId}, ${req.brandId ?? null}, ${req.userId ?? null}, ${req.workflow}, ${req.task}, ${rota.version},
              ${req.promptVersion ?? null}, ${t.candidato.provider}, ${t.candidato.model}, ${t.candidato.servedBy}, ${t.geo},
              ${t.tokens.input}, ${t.tokens.cacheRead}, ${t.tokens.cacheWrite}, ${t.tokens.output}, ${t.tokens.reasoning},
              ${t.custo.toString()}, ${t.latenciaMs}, ${t.outcome}, ${t.errorCode}, ${removidos}, ${t.traceId}, ${new Date(t.em).toISOString()})`);
  }

  /** Pedido barrado antes de chegar a um modelo: fica registrado, sem modelo e sem custo. */
  private async registrarBarrado(tx: Tx, req: GenerateRequest, rota: Rota, outcome: 'teto' | 'limite_usuario'): Promise<void> {
    await tx.execute(sql`
      insert into liame.ai_usage (id, tenant_id, brand_id, user_id, workflow, task, route_version, prompt_version, outcome)
      values (${uuidv7()}, ${req.tenantId}, ${req.brandId ?? null}, ${req.userId ?? null}, ${req.workflow}, ${req.task}, ${rota.version},
              ${req.promptVersion ?? null}, ${outcome})`);
  }
}

/** Código curto do motivo da falha, sem o texto do fornecedor (que pode repetir o que foi enviado). */
export function codigoDoErro(err: unknown): string {
  const e = RetryError.isInstance(err) ? err.lastError : err;
  if (APICallError.isInstance(e)) return e.statusCode ? `http_${e.statusCode}` : 'rede';
  if (NoObjectGeneratedError.isInstance(e)) return 'resposta_invalida';
  if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) return 'tempo_esgotado';
  return e instanceof Error ? `falha_${e.name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60)}` : 'falha';
}
