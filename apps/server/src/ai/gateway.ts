import { type Database, type Tx, uuidv7, withContext } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { APICallError, dynamicTool, generateText, type LanguageModel, type LanguageModelUsage, type ModelMessage, NoObjectGeneratedError, Output, RetryError, type ToolSet } from 'ai';
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
// precisa ficar gravado mesmo que a requisição desista. Com ferramentas (`agent`), o laço é daqui: uma
// chamada ao modelo por rodada, o teto conferido de novo a cada uma e cada rodada registrada.
//
// Quem monta o contexto manda os números já formatados ("R$ 1.250,00", "12.500 cliques"): número cru
// de 10 dígitos ou mais parece telefone ou CPF e sai na limpeza (`pii_removed` mostra quando aconteceu).
//
// O `stream` do plano (I10) é este laço com aviso de cada passo e com "Parar": a resposta só aparece depois
// da conferência (A3-5), então o que corre em tempo real são as leituras, não os tokens. Parar não corta a
// chamada que já está no fornecedor (o custo dela existe e precisa ser registrado, A3-2): impede a rodada
// seguinte e qualquer ferramenta que ainda não rodou.

export type AiErrorCode = 'desligada' | 'entrada-grande' | 'travada' | 'sem-rota' | 'limite-usuario' | 'teto' | 'indisponivel' | 'parada';

/**
 * Tamanho máximo da entrada (instruções + mensagens), em caracteres. O teto de custo é conferido antes
 * da chamada: sem este limite, um pedido só (contexto de um milhão de tokens) passaria do teto do dia.
 */
export const ENTRADA_MAXIMA = 200_000;

/** O que a tela precisa para dizer quando a IA volta: qual teto barrou e quando o limite da pessoa libera. */
export interface AiErrorDetail {
  /** No `teto`: o do dia ou o do mês. */
  teto?: 'dia' | 'mes';
  /** No `limite-usuario`: quando a chamada mais antiga da janela de uma hora sai dela. */
  voltaEm?: Date;
}

/** Toda falha da IA é esta. Quem chama cai no caminho sem IA: tela, aviso e relatório seguem (A3-6). */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly detalhe: AiErrorDetail = {},
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

/**
 * Ferramenta como o gateway a enxerga: já presa à empresa e à pessoa do pedido (quem monta a lista é o
 * registro de ferramentas, que confere a permissão e abre a transação da empresa). O gateway não conhece
 * permissão nem banco de negócio.
 */
export interface FerramentaIa {
  name: string;
  description: string;
  input: z.ZodType;
  executar(input: unknown): Promise<{ ok: true; valor: unknown } | { ok: false; erro: string }>;
}

/** Uma ferramenta pedida pelo modelo: quando começa e quando termina (é o "Lendo os resultados…" da tela). */
export interface PassoDaFerramenta {
  /** O id da chamada da ferramenta, igual no começo e no fim. */
  id: string;
  nome: string;
  /** Os parâmetros como o modelo mandou (validados pela ferramenta ao rodar). */
  input: unknown;
  fase: 'inicio' | 'fim';
  /** No fim: a ferramenta respondeu ou falhou. */
  ok?: boolean;
}

export interface AgentRequest extends GenerateRequest {
  ferramentas: FerramentaIa[];
  /** Quantas chamadas ao modelo o pedido pode fazer (cada rodada pode usar ferramentas). Padrão 6, no máximo 12. */
  maxRodadas?: number;
  /** A resposta final no formato do schema, com as ferramentas na mesma chamada; sem ele, texto livre. */
  schema?: z.ZodType<unknown>;
  /**
   * Pedido para parar (a pessoa tocou em "Parar" ou fechou a conversa): nenhuma rodada nova começa e nenhuma
   * ferramenta roda depois dele. A chamada que já está no fornecedor termina e é registrada. Termina em `parada`.
   */
  parar?: AbortSignal;
  /** Cada ferramenta que o modelo pede, ao começar e ao terminar. Erro aqui não interrompe o laço. */
  aoUsarFerramenta?: (passo: PassoDaFerramenta) => void;
}

export interface AgentResult extends GenerateResult {
  /** Com `schema`: a resposta no formato pedido; sem ele, nulo. */
  object: unknown;
  rodadas: number;
  ferramentas: Array<{ name: string; ok: boolean }>;
}

const RODADAS_PADRAO = 6;
const RODADAS_MAXIMO = 12;
/** Tamanho máximo do que uma ferramenta devolve ao modelo, em caracteres (a maior leitura de hoje fica abaixo de 20 mil). */
export const SAIDA_DA_FERRAMENTA_MAXIMA = 60_000;

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
  | { barrado: 'travada' | 'sem-rota' | 'limite-usuario' | 'teto'; detalhe?: AiErrorDetail }
  | { barrado: null; rota: Rota; gasto: Gasto; candidatos: Candidato[]; precos: Map<string, PrecoModelo> };

/** Qual teto barrou: o do mês, quando ele está cheio; senão, o do dia. */
const qualTeto = (g: Gasto): 'dia' | 'mes' => (g.gastoMes >= g.tetoMes ? 'mes' : 'dia');

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
  /** Ferramentas que o modelo pediu nesta chamada, e quantas falharam. */
  toolCalls: number;
  toolFailures: number;
}

interface Resposta {
  text: string;
  object: unknown;
  finishReason: string;
  /** O que o modelo escreveu e o resultado das ferramentas, do jeito que volta para ele na rodada seguinte. */
  mensagens: ModelMessage[];
}

interface Opcoes {
  schema: z.ZodType<unknown> | null;
  ferramentas: FerramentaIa[];
  maxRodadas: number;
  parar?: AbortSignal;
  aoUsarFerramenta?: (passo: PassoDaFerramenta) => void;
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

  /** A IA está ligada para esta empresa (flag `ia`)? É o que a tela pergunta antes de oferecer a LIA; não gasta nada. */
  ligada(quem: { tenantId: string; userId?: string | null; brandId?: string | null }): Promise<boolean> {
    return this.flags.isEnabled('ia', this.flags.context({ tenantId: quem.tenantId, userId: quem.userId ?? null, brandId: quem.brandId ?? null }));
  }

  /** Texto livre. */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const r = await this.run(req, { schema: null, ferramentas: [], maxRodadas: 1 });
    return { ...r.base, text: r.text };
  }

  /** Resposta no formato do schema: o que não valida conta como falha e passa para a reserva da rota. */
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const r = await this.run(req, { schema: req.schema, ferramentas: [], maxRodadas: 1 });
    return { ...r.base, object: r.object as T };
  }

  /**
   * Laço com ferramentas: o modelo pede uma leitura, o código executa (com a permissão e o isolamento da
   * empresa) e devolve o resultado, até o modelo responder em texto. A cada rodada o teto é conferido de
   * novo, e cada chamada ao modelo vira uma linha de `ai_usage`.
   */
  async agent(req: AgentRequest): Promise<AgentResult> {
    const maxRodadas = Math.min(Math.max(req.maxRodadas ?? RODADAS_PADRAO, 1), RODADAS_MAXIMO);
    const r = await this.run(req, { schema: req.schema ?? null, ferramentas: req.ferramentas, maxRodadas, parar: req.parar, aoUsarFerramenta: req.aoUsarFerramenta });
    return { ...r.base, text: r.text, object: req.schema ? r.object : null, rodadas: r.rodadas, ferramentas: r.usadas };
  }

  private async run(
    req: GenerateRequest,
    opcoes: Opcoes,
  ): Promise<{ base: Omit<GenerateResult, 'text'>; text: string; object: unknown; rodadas: number; usadas: Array<{ name: string; ok: boolean }> }> {
    const { schema } = opcoes;
    const contexto = { tenantId: req.tenantId, userId: req.userId ?? null };
    // Parou antes de começar: nada foi chamado, nada a registrar.
    if (opcoes.parar?.aborted) throw new AiError('parada', 'ia: parada antes da primeira chamada');
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
    if (preparo.barrado) throw new AiError(preparo.barrado, `ia: ${preparo.barrado}`, preparo.detalhe);
    const { rota, gasto, candidatos, precos } = preparo;

    const instrucoes = limparTexto(req.instructions);
    const mensagens = req.messages.map((m) => ({ role: m.role, ...limparTexto(m.content) }));
    const removidos = instrucoes.removidos + mensagens.reduce((n, m) => n + m.removidos, 0);
    const enviado = { instructions: instrucoes.texto, messages: mensagens.map((m) => ({ role: m.role, content: m.texto })) };

    const tentativas: Tentativa[] = [];
    // Duas tentativas no mesmo milissegundo não trocam de ordem no registro.
    const guardar = (t: Tentativa) => tentativas.push({ ...t, em: Math.max(t.em, (tentativas[tentativas.length - 1]?.em ?? 0) + 1) });
    const conversa: ModelMessage[] = [...enviado.messages];
    const usadas: Array<{ name: string; ok: boolean }> = [];
    const pedir = (candidato: Candidato, model: LanguageModel, preco: PrecoModelo) =>
      this.chamar(req, rota, candidato, model, preco, { instructions: enviado.instructions, messages: conversa }, { schema, ferramentas: opcoes.ferramentas, usadas, parar: opcoes.parar, aoUsarFerramenta: opcoes.aoUsarFerramenta });

    // Primeira rodada: o modelo da rota e, se ele falhar, a reserva da própria rota.
    let resposta: Resposta | null = null;
    let escolhido: { candidato: Candidato; model: LanguageModel; preco: PrecoModelo } | null = null;
    for (const candidato of candidatos) {
      const model = this.modelos.modelo(candidato.provider, candidato.model);
      const preco = precos.get(chave(candidato.provider, candidato.model));
      // Sem credencial ou sem preço cadastrado o modelo não roda: custo que não se mede não se gasta (A3-2).
      if (!model || !preco) {
        guardar(this.falha(candidato, model ? 'sem_preco' : 'sem_credencial'));
        continue;
      }
      const t = await pedir(candidato, model, preco);
      guardar(t.tentativa);
      if (t.resposta) {
        resposta = t.resposta;
        escolhido = { candidato, model, preco };
        break;
      }
    }

    // Rodadas seguintes: enquanto o modelo pedir ferramenta, com o mesmo modelo. O teto é conferido de
    // novo a cada rodada, contando o que este pedido já gastou.
    let rodadas = 1;
    let parada: 'rodadas' | 'teto' | 'teto_da_rota' | 'pessoa' | null = null;
    while (resposta && escolhido && resposta.finishReason === 'tool-calls') {
      conversa.push(...resposta.mensagens);
      const gastoAqui = tentativas.reduce((n, t) => n + t.custo, 0n);
      if (opcoes.parar?.aborted) parada = 'pessoa';
      else if (rodadas >= opcoes.maxRodadas) parada = 'rodadas';
      else if (situacaoDoTeto({ ...gasto, gastoDia: gasto.gastoDia + gastoAqui, gastoMes: gasto.gastoMes + gastoAqui }) === 'bloqueado') parada = 'teto';
      else if (gastoAqui > BigInt(rota.max_cost_usd_micros)) parada = 'teto_da_rota';
      if (parada) {
        resposta = null;
        break;
      }
      const t = await pedir(escolhido.candidato, escolhido.model, escolhido.preco);
      guardar(t.tentativa);
      rodadas += 1;
      resposta = t.resposta;
    }

    const ultima = tentativas[tentativas.length - 1]!;
    const guardado = resposta
      ? limparJson({ ...(schema ? { object: resposta.object } : { text: resposta.text }), ...(usadas.length ? { tools: usadas } : {}) }).valor
      : parada
        ? { stopped: parada, tools: usadas }
        : null;
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

    const total = tentativas.reduce((n, t) => n + t.custo, 0n);
    const faixa = virouDeFaixa(gasto, total);
    if (faixa) this.logger.warn(`ia: a empresa ${req.tenantId} entrou na faixa "${faixa}" do teto de custo de IA`);
    if (parada) {
      // A pessoa parou: não é falha. O uso das rodadas que aconteceram já está registrado.
      if (parada === 'pessoa') throw new AiError('parada', `ia: parada pela pessoa depois de ${rodadas} rodada(s)`);
      this.logger.warn(`ia: ${req.task} parou sem resposta depois de ${rodadas} rodada(s): ${parada}`);
      if (parada === 'teto') throw new AiError('teto', 'ia: laço interrompido (teto)', { teto: qualTeto({ ...gasto, gastoDia: gasto.gastoDia + total, gastoMes: gasto.gastoMes + total }) });
      throw new AiError('indisponivel', `ia: laço interrompido (${parada})`);
    }
    if (!resposta) {
      this.logger.warn(`ia: ${req.task} sem resposta (${tentativas.map((t) => `${chave(t.candidato.provider, t.candidato.model)}: ${t.errorCode}`).join('; ')})`);
      throw new AiError('indisponivel', 'ia: nenhum modelo da rota respondeu');
    }
    if (total > BigInt(rota.max_cost_usd_micros)) {
      this.logger.warn(`ia: ${req.task} v${rota.version} custou ${total} micros, acima do teto da rota (${rota.max_cost_usd_micros})`);
    }

    // O que sai daqui também vai limpo: se o modelo escrever um contato, ele não chega à tela.
    const limpa = limparJson({ text: resposta.text, object: resposta.object }).valor as { text: string; object: unknown };
    return {
      base: {
        usageId: ultima.id,
        servedBy: ultima.candidato.servedBy,
        provider: ultima.candidato.provider,
        model: ultima.candidato.model,
        routeVersion: rota.version,
        // O custo do pedido inteiro: todas as rodadas e as tentativas que falharam depois de gerar.
        costUsdMicros: Number(total),
        finishReason: resposta.finishReason,
      },
      text: limpa.text,
      object: limpa.object,
      rodadas,
      usadas,
    };
  }

  /** As ferramentas no formato do SDK: a saída volta limpa de dado pessoal, e a falha vira um aviso curto para o modelo. */
  private ferramentasDoSdk(
    ferramentas: FerramentaIa[],
    conta: { chamadas: number; falhas: number },
    usadas: Array<{ name: string; ok: boolean }>,
    opcoes: { parar?: AbortSignal; aoUsarFerramenta?: (passo: PassoDaFerramenta) => void } = {},
  ): ToolSet {
    const avisar = (passo: PassoDaFerramenta) => {
      try {
        opcoes.aoUsarFerramenta?.(passo);
      } catch (err) {
        this.logger.error(`ia: o aviso do passo ${passo.nome} falhou: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    return Object.fromEntries(
      ferramentas.map((f) => [
        f.name,
        dynamicTool({
          description: f.description,
          inputSchema: f.input,
          execute: async (input, { toolCallId }) => {
            // Depois de "Parar", nada mais roda (nem leitura, nem a abertura de uma demanda).
            if (opcoes.parar?.aborted) return { erro: 'A pessoa parou a resposta.' };
            conta.chamadas += 1;
            avisar({ id: toolCallId, nome: f.name, input, fase: 'inicio' });
            let r: Awaited<ReturnType<FerramentaIa['executar']>>;
            try {
              r = await f.executar(input);
            } catch (err) {
              this.logger.error(`ia: a ferramenta ${f.name} falhou: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
              r = { ok: false, erro: 'Não foi possível ler agora.' };
            }
            // A saída também tem tamanho máximo: ela volta ao modelo como entrada da rodada seguinte, e paga.
            const limpo = r.ok ? limparJson(r.valor).valor : null;
            if (r.ok && JSON.stringify(limpo).length > SAIDA_DA_FERRAMENTA_MAXIMA) {
              this.logger.warn(`ia: a ferramenta ${f.name} devolveu mais de ${SAIDA_DA_FERRAMENTA_MAXIMA} caracteres`);
              r = { ok: false, erro: 'O resultado é grande demais. Peça um período menor ou uma marca só.' };
            }
            usadas.push({ name: f.name, ok: r.ok });
            avisar({ id: toolCallId, nome: f.name, input, fase: 'fim', ok: r.ok });
            if (!r.ok) {
              conta.falhas += 1;
              return { erro: r.erro };
            }
            return limpo;
          },
        }),
      ]),
    );
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
        // O limite libera quando a chamada que completa a conta sai da janela de uma hora.
        const limiar = await tx.execute<{ em: Date | string }>(sql`
          select occurred_at as em from liame.ai_usage
           where tenant_id = ${req.tenantId} and user_id = ${req.userId} and model is not null and occurred_at > now() - interval '1 hour'
           order by occurred_at desc offset ${this.config.ai.userHourlyCalls - 1} limit 1`);
        const em = limiar.rows[0]?.em;
        await this.registrarBarrado(tx, req, rota, 'limite_usuario');
        return { barrado: 'limite-usuario', detalhe: em ? { voltaEm: new Date(new Date(em).getTime() + 3_600_000) } : {} };
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
      return { barrado: 'teto', detalhe: { teto: qualTeto(gasto) } };
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
    enviado: { instructions: string; messages: ModelMessage[] },
    opcoes: {
      schema: z.ZodType<unknown> | null;
      ferramentas: FerramentaIa[];
      usadas: Array<{ name: string; ok: boolean }>;
      parar?: AbortSignal;
      aoUsarFerramenta?: (passo: PassoDaFerramenta) => void;
    },
  ): Promise<{ tentativa: Tentativa; resposta: Resposta | null }> {
    const { schema } = opcoes;
    const conta = { chamadas: 0, falhas: 0 };
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
          toolCalls: conta.chamadas,
          toolFailures: conta.falhas,
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
        // Com ferramentas, cada chamada é UMA rodada: o SDK executa o que o modelo pediu e devolve as mensagens
        // (a do modelo e a do resultado) para a rodada seguinte, que quem decide se acontece é o laço daqui. Com
        // schema, a resposta final vem no formato pedido; a rodada que pede ferramenta não tem resposta ainda.
        const r = await generateText({
          ...comum,
          ...(opcoes.ferramentas.length ? { tools: this.ferramentasDoSdk(opcoes.ferramentas, conta, opcoes.usadas, opcoes) } : {}),
          ...(schema ? { output: Output.object({ schema }) } : {}),
        });
        span.setAttribute('gen_ai.response.finish_reasons', [r.finishReason]);
        let object: unknown = null;
        if (schema && r.finishReason !== 'tool-calls') {
          try {
            object = r.output;
          } catch {
            // Terminou sem texto nenhum (o limite de saída, por exemplo): não há objeto, mas o uso foi cobrado.
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'resposta_invalida' });
            return { tentativa: tentativa('erro', r.totalUsage, 'resposta_invalida'), resposta: null };
          }
        }
        return { tentativa: tentativa('ok', r.totalUsage, null), resposta: { text: schema ? '' : r.text, object, finishReason: r.finishReason, mensagens: r.responseMessages } };
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
    return { id: uuidv7(), candidato, geo: null, tokens: SEM_TOKENS, custo: 0n, latenciaMs: 0, outcome: 'erro', errorCode, traceId: null, em: Date.now(), toolCalls: 0, toolFailures: 0 };
  }

  private async registrar(tx: Tx, req: GenerateRequest, rota: Rota, t: Tentativa, removidos: number): Promise<void> {
    await tx.execute(sql`
      insert into liame.ai_usage (id, tenant_id, brand_id, user_id, workflow, task, route_version, prompt_version, provider, model, served_by,
                                  inference_geo, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
                                  cost_usd_micros, latency_ms, tool_calls, tool_failures, outcome, error_code, pii_removed, trace_id, occurred_at)
      values (${t.id}, ${req.tenantId}, ${req.brandId ?? null}, ${req.userId ?? null}, ${req.workflow}, ${req.task}, ${rota.version},
              ${req.promptVersion ?? null}, ${t.candidato.provider}, ${t.candidato.model}, ${t.candidato.servedBy}, ${t.geo},
              ${t.tokens.input}, ${t.tokens.cacheRead}, ${t.tokens.cacheWrite}, ${t.tokens.output}, ${t.tokens.reasoning},
              ${t.custo.toString()}, ${t.latenciaMs}, ${t.toolCalls}, ${t.toolFailures}, ${t.outcome}, ${t.errorCode}, ${removidos}, ${t.traceId},
              ${new Date(t.em).toISOString()})`);
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
