import {
  CONVERSATION_RETENTION_DAYS,
  type ConversationCard,
  type ConversationListResponse,
  type ConversationMessage,
  type ConversationResponse,
  type ConversationStaleSource,
  type ConversationStreamEvent,
  type ConversationSummary,
  type ExplanationNumber,
  type SendConversationMessageRequest,
} from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { PROPOR_CUPOM, ProporCupomInput } from '../ai/conversa/cupom.defs.js';
import { AbrirDemandaInput, ABRIR_DEMANDA } from '../ai/conversa/demanda.defs.js';
import { valorDaDemanda, valorDaProposta } from '../ai/conversa/escritas.js';
import { indiceDasOrigens, marcarResposta, type OrigemDosNumeros } from '../ai/conversa/fontes.js';
import { foraDoDia, nomesDaLeitura, rotuloDaLeitura, rotuloDoPasso } from '../ai/conversa/leituras.js';
import { LIA, PROMPT_CONVERSA_LIA, TAREFA_CONVERSA } from '../ai/conversa/prompt.js';
import { contextoDoPedido, contextoPermitido, historicoParaOModelo, querFalarComPessoa, textoDaResposta } from '../ai/conversa/contexto.js';
import { conferirResposta, RespostaDaLia } from '../ai/conversa/resposta.js';
import { AiError, type AiMessage, AiGateway, type FerramentaIa, type PassoDaFerramenta } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { dia } from '../ai/registro/formatos.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { FerramentasDeLeitura } from '../ai/registro/leituras.js';
import { textoDaConversa } from '../ai/revisor/parecer.js';
import { RevisorService } from '../ai/revisor/revisor.service.js';
import { limparJson, limparTexto } from '../ai/sanitizar.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { CouponsService } from '../coupons/coupons.service.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { dossieParaOModelo, proibidasDaMarca } from '../marca/marca.service.js';
import { conferirTexto, REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { ResultsService } from '../results/results.service.js';
import { ATENDIMENTO } from '../suporte.js';
import { DemandasService, type QuemPede } from './demandas.service.js';
import { PropostaDeCupomService, PropostaRecusada } from './proposta-cupom.service.js';

// Conversa com a LIA (A3, I10; protótipo P5, aguardando aprovação). Uma resposta é: gravar a mensagem da pessoa
// (sem dado pessoal) e marcar a conversa como "respondendo", numa transação curta; abrir o fluxo; decidir por
// regra o que não vai à IA (falar com uma pessoa, pedido político, LIA desligada); chamar a LIA com as leituras
// que a pessoa pode fazer; conferir a resposta (números, Compliance, o que a marca não diz, dado velho); gravar a
// resposta ou o aviso e liberar a conversa, em outra transação curta. Nenhuma transação fica aberta durante a
// chamada ao modelo. O que não passou na conferência não sai daqui: vira o aviso "a resposta foi retirada".

export const WORKFLOW = 'conversa.lia';
/** Mensagens anteriores que voltam ao modelo a cada resposta (as mais recentes). */
const HISTORICO_MAXIMO = 10;
/** Chamadas ao modelo numa resposta (cada uma pode pedir leituras, várias de uma vez). */
const RODADAS = 5;
/** A marca de "respondendo" de uma resposta que caiu no meio deixa de valer depois disto. */
const OCUPADA_POR = sql.raw(`interval '3 minutes'`);
const TITULO_MAXIMO = 120;
/** Mensagens por pessoa por hora, com ou sem IA (abuso: cada uma grava linhas). O limite de chamadas ao modelo é outro, no gateway. */
const MENSAGENS_POR_HORA = 60;
const AVISO_DO_ERRO: Record<string, string> = {
  desligada: 'desligada',
  travada: 'pausada',
  'sem-rota': 'fora_do_ar',
  indisponivel: 'fora_do_ar',
  'entrada-grande': 'fora_do_ar',
  'limite-usuario': 'limite_pessoa',
  teto: 'teto',
};

/** O título da conversa: a primeira mensagem, numa linha, cortada. */
const tituloDe = (texto: string): string => {
  const linha = texto.replace(/\s+/g, ' ').trim();
  return linha.length > TITULO_MAXIMO ? `${linha.slice(0, TITULO_MAXIMO - 1)}…` : linha;
};

const iso = (v: Date | string) => new Date(v).toISOString();

type LinhaMensagem = { id: string; role: string; status: string; content: Record<string, unknown>; usage_id: string | null; created_at: Date | string };
type LinhaConversa = { id: string; brand_id: string; title: string; created_at: Date | string; last_message_at: Date | string; lia_answers: number; has_demand: boolean };

const lista = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const textoOuNulo = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** O cartão guardado no formato de agora (o gravado antes de um campo existir vem com ele nulo). */
const cartaoDaLinha = (k: Record<string, unknown>): ConversationCard => ({
  kind: textoOuNulo(k.kind) ?? 'demanda',
  demand: (k.demand as ConversationCard['demand']) ?? null,
  coupon: (k.coupon as ConversationCard['coupon']) ?? null,
  meeting: (k.meeting as ConversationCard['meeting']) ?? null,
});

/** A linha guardada como a tela recebe. O conteúdo é o de cada papel; o resto vem vazio. */
export function mensagemDaLinha(l: LinhaMensagem): ConversationMessage {
  const c = l.content ?? {};
  return {
    id: l.id,
    role: l.role,
    created_at: iso(l.created_at),
    status: l.status,
    text: l.role === 'pessoa' ? (textoOuNulo(c.text) ?? '') : null,
    removed_personal_data: l.role === 'pessoa' ? Number(c.removed_personal_data ?? 0) : null,
    blocks: lista(c.blocks),
    numbers: lista(c.numbers),
    read: lista(c.read),
    cards: lista<Record<string, unknown>>(c.cards).map(cartaoDaLinha),
    economy: c.economy === true,
    usage_id: l.usage_id,
    notice: l.role === 'sistema' ? (textoOuNulo(c.notice) ?? 'fora_do_ar') : null,
    contact: (c.contact as ConversationMessage['contact']) ?? null,
    retry_at: textoOuNulo(c.retry_at),
    budget_window: textoOuNulo(c.budget_window),
    stale_sources: lista(c.stale_sources),
  };
}

/** Uma leitura feita nesta resposta, já sem dado pessoal (como o modelo a recebeu). */
interface Leitura {
  ferramenta: string;
  input: unknown;
  valor: unknown;
}

/** O que a rota resolveu antes de abrir o fluxo: a conversa marcada para esta resposta e a mensagem da pessoa gravada. */
export interface TurnoPreparado {
  quem: QuemPede & { permissions: ReadonlySet<string> };
  /** A sessão de quem pergunta (só em memória): a proposta de cupom passa pelo mesmo serviço da rota. */
  auth: AuthContext & { tenantId: string };
  conversa: ConversationSummary;
  pessoa: ConversationMessage;
  /** O texto da pessoa, sem dado pessoal: é o que vai ao modelo. */
  texto: string;
  historico: AiMessage[];
  /** O que veio antes nesta conversa (as mesmas mensagens do histórico): de onde a LIA também pode tirar número. */
  anteriores: { daPessoa: string[]; daLia: string[]; numeros: ExplanationNumber[] };
  marca: { id: string; nome: string; fuso: string };
  hoje: string;
  dossie: string | null;
  daMarca: string[];
  liaAtiva: boolean;
}

type Final =
  | { role: 'lia'; status: 'ok' | 'parada'; content: Record<string, unknown>; usageId: string | null }
  | { role: 'sistema'; status: 'ok'; content: Record<string, unknown>; usageId: null };

/** Um evento do fluxo, com os campos que não vêm nulos. */
export const evento = (type: string, campos: Partial<Omit<ConversationStreamEvent, 'type'>> = {}): ConversationStreamEvent => ({
  type,
  conversation: campos.conversation ?? null,
  message: campos.message ?? null,
  step: campos.step ?? null,
  problem: campos.problem ?? null,
});

@Injectable()
export class ConversaService {
  private readonly logger = new Logger('conversa');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly gateway: AiGateway,
    private readonly leituras: FerramentasDeLeitura,
    private readonly resultados: ResultsService,
    private readonly demandas: DemandasService,
    private readonly limite: RateLimitService,
    private readonly cupons: CouponsService,
    private readonly propostas: PropostaDeCupomService,
    private readonly revisor: RevisorService,
  ) {}

  private get db(): Database {
    if (!this.database) throw new Error('conversa: sem banco');
    return this.database;
  }

  // ------------------------------------------------------------------ leitura (na transação da rota)

  /** As conversas da pessoa nesta marca, dos últimos 30 dias, e se a LIA conversa aqui. */
  async lista(auth: AuthContext, brandId: string): Promise<ConversationListResponse> {
    const tenantId = this.empresa(auth);
    await this.exigirMarca(brandId);
    const r = await currentTx().execute<LinhaConversa>(sql`
      select c.id, c.brand_id, c.title, c.created_at, c.last_message_at, c.lia_answers,
             exists (select 1 from liame.demand d where d.conversation_id = c.id) as has_demand
        from liame.conversation c
       where c.brand_id = ${brandId} and c.last_message_at > now() - make_interval(days => ${CONVERSATION_RETENTION_DAYS})
       order by c.last_message_at desc, c.id desc
       limit 100`);
    return {
      items: r.rows.map((l) => this.resumoDaLinha(l)),
      lia: await this.liaAtiva(tenantId, auth.userId, brandId),
      retention_days: CONVERSATION_RETENTION_DAYS,
      max_lia_answers: this.config.ai.conversationMaxAnswers,
      contact: ATENDIMENTO,
    };
  }

  /** Uma conversa da pessoa, com as mensagens dos últimos 30 dias. Conversa de outra pessoa não existe para ela. */
  async conversa(auth: AuthContext, id: string): Promise<ConversationResponse> {
    this.empresa(auth);
    const c = await this.resumo(id);
    if (!c) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta conversa não existe ou já passou dos 30 dias.');
    const r = await currentTx().execute<LinhaMensagem>(sql`
      select id, role, status, content, usage_id, created_at from liame.conversation_message
       where conversation_id = ${id} and created_at > now() - make_interval(days => ${CONVERSATION_RETENTION_DAYS})
       order by created_at, id`);
    const messages = r.rows.map(mensagemDaLinha);
    // O cartão foi gravado com a situação daquela hora: ao abrir, vale a de agora (a demanda cancelada, o cupom
    // aprovado, recusado ou cancelado).
    const ids = (pegar: (k: ConversationCard) => string | undefined) => [...new Set(messages.flatMap((m) => m.cards.map(pegar).filter((x): x is string => !!x)))];
    const demandas = await this.demandas.porIds(ids((k) => k.demand?.id));
    const propostas = await this.cupons.pedidosPorId(ids((k) => k.coupon?.request.action_id));
    for (const m of messages) {
      m.cards = m.cards.map((k) => ({
        ...k,
        demand: k.demand ? (demandas.get(k.demand.id) ?? k.demand) : null,
        coupon: k.coupon ? (propostas.get(k.coupon.request.action_id) ?? k.coupon) : null,
      }));
    }
    return { conversation: c, messages };
  }

  // ------------------------------------------------------------------ uma resposta (fora da transação da rota)

  /**
   * Antes do fluxo, numa transação curta: a marca, a conversa (nova ou a mesma, travada para uma resposta por
   * vez), a mensagem da pessoa gravada sem dado pessoal e o que a resposta vai precisar. Falha aqui é resposta
   * HTTP comum (404, 409, 422); depois disso, o fluxo já começou.
   */
  async preparar(auth: AuthContext, body: SendConversationMessageRequest, agora = new Date()): Promise<TurnoPreparado> {
    const tenantId = this.empresa(auth);
    const quem = { tenantId, userId: auth.userId, name: auth.name, roleKey: auth.roleKey, permissions: auth.permissions };
    const limpo = limparTexto(body.text);
    const texto = limpo.texto.trim();
    const max = this.config.ai.conversationMaxAnswers;
    await this.limite.consume(`conversa:${quem.tenantId}:${quem.userId}`, MENSAGENS_POR_HORA, 3600);
    const liaLigada = await this.gateway.ligada({ tenantId: quem.tenantId, userId: quem.userId, brandId: body.brand_id });
    return naTransacaoDaEmpresa(this.db, quem, async () => {
      const tx = currentTx();
      const marca = await this.exigirMarca(body.brand_id);
      let conversaId = body.conversation_id;
      if (conversaId) {
        const c = (
          await tx.execute<{ brand_id: string; lia_answers: number; ocupada: boolean }>(sql`
            select brand_id, lia_answers, (busy_since is not null and busy_since > now() - ${OCUPADA_POR}) as ocupada
              from liame.conversation
             where id = ${conversaId} and last_message_at > now() - make_interval(days => ${CONVERSATION_RETENTION_DAYS})
             for update`)
        ).rows[0];
        if (!c) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta conversa não existe ou já passou dos 30 dias.');
        if (c.brand_id !== marca.id) throw new AppProblem(422, 'conversa-de-outra-marca', 'A conversa é de outra marca', 'Comece uma conversa nova nesta marca.');
        if (c.lia_answers >= max) {
          throw new AppProblem(409, 'conversa-cheia', 'Esta conversa chegou ao tamanho máximo', 'Ela continua guardada em Suas conversas. Para seguir, comece uma nova.');
        }
        if (c.ocupada) throw new AppProblem(409, 'conversa-ocupada', 'A LIA ainda está respondendo', 'Espere a resposta desta conversa antes de mandar outra mensagem.');
        await tx.execute(sql`update liame.conversation set busy_since = now(), last_message_at = now() where id = ${conversaId}`);
      } else {
        conversaId = uuidv7();
        await tx.execute(sql`
          insert into liame.conversation (id, tenant_id, brand_id, user_id, title, busy_since)
          values (${conversaId}, ${quem.tenantId}, ${marca.id}, ${quem.userId}, ${tituloDe(texto)}, now())`);
      }
      // O id é da tela: o mesmo envio repetido não grava de novo (o índice único decide, mesmo em outra empresa).
      const gravada = await tx.execute<LinhaMensagem>(sql`
        insert into liame.conversation_message (id, tenant_id, conversation_id, user_id, role, content)
        values (${body.message_id}, ${quem.tenantId}, ${conversaId}, ${quem.userId}, 'pessoa',
                ${JSON.stringify({ text: texto, removed_personal_data: limpo.removidos })}::jsonb)
        on conflict (id) do nothing
        returning id, role, status, content, usage_id, created_at`);
      if (!gravada.rows.length) throw new AppProblem(409, 'mensagem-repetida', 'Esta mensagem já foi enviada', 'Recarregue a conversa para ver a resposta.');

      const antes = (
        await tx.execute<LinhaMensagem>(sql`
          select id, role, status, content, usage_id, created_at from liame.conversation_message
           where conversation_id = ${conversaId} and id <> ${body.message_id}
           order by created_at desc, id desc
           limit ${HISTORICO_MAXIMO}`)
      ).rows
        .reverse()
        .map(mensagemDaLinha);
      const fuso = await this.resultados.fusoDaMarca(marca.id);
      return {
        quem,
        auth: { ...auth, tenantId },
        conversa: (await this.resumo(conversaId))!,
        pessoa: mensagemDaLinha(gravada.rows[0]!),
        texto,
        historico: historicoParaOModelo(antes),
        anteriores: {
          daPessoa: antes.filter((m) => m.role === 'pessoa').map((m) => m.text ?? ''),
          daLia: antes.filter((m) => m.role === 'lia' && m.status === 'ok').map(textoDaResposta),
          numeros: antes.filter((m) => m.role === 'lia' && m.status === 'ok').flatMap((m) => m.numbers),
        },
        marca: { id: marca.id, nome: marca.name, fuso },
        hoje: diaNoFuso(agora, fuso),
        dossie: await dossieParaOModelo(marca.id, marca.name),
        daMarca: await proibidasDaMarca(marca.id),
        liaAtiva: liaLigada && (await funcionarioAtivo(tx, { tenantId: quem.tenantId, brandId: marca.id, agentKey: LIA.key, ativoPorPadrao: LIA.ativoPorPadrao })),
      };
    });
  }

  /**
   * A resposta, já com o fluxo aberto: os passos saem por `enviar` enquanto acontecem; no fim, a resposta (ou o
   * aviso) é gravada, a conversa é liberada e saem `mensagem` e `fim`. Erro inesperado libera a conversa e sobe.
   */
  async responder(t: TurnoPreparado, io: { enviar: (e: ConversationStreamEvent) => void; parar: AbortSignal }): Promise<void> {
    let final: Final;
    try {
      final = await this.turno(t, io);
    } catch (err) {
      await this.liberar(t);
      throw err;
    }
    let gravado: { mensagem: ConversationMessage; conversa: ConversationSummary };
    try {
      gravado = await this.gravar(t, final);
    } catch (err) {
      await this.liberar(t);
      throw err;
    }
    io.enviar(evento('mensagem', { message: gravado.mensagem }));
    io.enviar(evento('fim', { conversation: gravado.conversa }));
  }

  /** A resposta que a conferência recusou entra na contagem de Sua equipe, sem o texto (D-A3-15). */
  private async anotarRecusa(t: TurnoPreparado, usageId: string, kind: string, regras?: readonly string[]): Promise<void> {
    if (!this.database) return;
    await registrarRecusa(this.database, {
      tenantId: t.quem.tenantId,
      brandId: t.marca.id,
      userId: t.quem.userId,
      usageId,
      member: LIA.key,
      workflow: WORKFLOW,
      kind,
      rules: regras,
      rulesVersion: regras?.length ? REGRAS_DE_TEXTO_VERSAO : null,
    });
  }

  private async turno(t: TurnoPreparado, io: { enviar: (e: ConversationStreamEvent) => void; parar: AbortSignal }): Promise<Final> {
    // O que a LIA registrou nesta resposta (a demanda, a proposta de cupom). Fica valendo mesmo que o texto dela não
    // apareça: o aviso que entra no lugar leva os cartões, para a pessoa saber e não pedir de novo.
    const cards: ConversationCard[] = [];
    const aviso = (notice: string, extra: Record<string, unknown> = {}): Final => ({ role: 'sistema', status: 'ok', content: { notice, ...extra, ...(cards.length ? { cards } : {}) }, usageId: null });
    // O que se decide por regra, sem chamar a IA.
    if (querFalarComPessoa(t.texto)) return aviso('pessoa', { contact: ATENDIMENTO });
    if (conferirTexto(t.texto).some((a) => a.regra === 'politico_eleitoral')) {
      this.logger.warn(`conversa: pedido político ou eleitoral recusado por regra (empresa ${t.quem.tenantId})`);
      return aviso('politico');
    }
    if (!t.liaAtiva) return aviso('desligada', { contact: ATENDIMENTO });
    // A falha da IA (da LIA ou do revisor) como a tela a mostra.
    const avisoDoErro = (err: AiError): Final =>
      aviso(AVISO_DO_ERRO[err.code] ?? 'fora_do_ar', {
        ...(err.detalhe.voltaEm ? { retry_at: err.detalhe.voltaEm.toISOString() } : {}),
        ...(err.detalhe.teto ? { budget_window: err.detalhe.teto } : {}),
        ...(err.code === 'desligada' ? { contact: ATENDIMENTO } : {}),
      });
    // O revisor de IA, para a empresa que o tem ligado (D-A3-16): se ele não tem como responder, a resposta não
    // apareceria de qualquer jeito, então a LIA nem é chamada (nenhum custo jogado fora, nenhuma demanda aberta à toa).
    const revisor = await this.revisor.situacao({ tenantId: t.quem.tenantId, brandId: t.marca.id, userId: t.quem.userId });
    if (revisor === 'sem_rota') return aviso('fora_do_ar');

    const leituras: Leitura[] = [];
    const ctx = { tenantId: t.quem.tenantId, userId: t.quem.userId, permissions: t.quem.permissions };
    // As leituras que ESTA pessoa pode fazer, cada uma guardada como o modelo a recebeu (é o que vale na conferência).
    const ferramentas: FerramentaIa[] = this.leituras.paraPedido(ctx).map((f) => ({
      ...f,
      executar: async (input) => {
        const r = await f.executar(input);
        if (r.ok) leituras.push({ ferramenta: f.name, input, valor: limparJson(r.valor).valor });
        return r;
      },
    }));
    // As escritas da conversa, para quem tem a permissão da rota equivalente: abrir demanda e propor cupom.
    if (t.quem.permissions.has(ABRIR_DEMANDA.permission!)) ferramentas.push(this.ferramentaDeDemanda(t, cards, leituras));
    if (t.quem.permissions.has(PROPOR_CUPOM.permission!)) ferramentas.push(this.ferramentaDeCupom(t, cards, leituras));
    const passo = (p: PassoDaFerramenta) =>
      io.enviar(evento('passo', { step: { id: p.id, label: rotuloDoPasso(p.nome, p.input), status: p.fase === 'inicio' ? 'lendo' : p.ok ? 'ok' : 'falhou' } }));
    const parada = (): Final => ({ role: 'lia', status: 'parada', content: { blocks: [], numbers: [], read: lidas(leituras), cards, economy: false }, usageId: null });

    let r: Awaited<ReturnType<AiGateway['agent']>>;
    try {
      r = await this.gateway.agent({
        tenantId: t.quem.tenantId,
        brandId: t.marca.id,
        userId: t.quem.userId,
        workflow: WORKFLOW,
        task: TAREFA_CONVERSA,
        promptVersion: `${PROMPT_CONVERSA_LIA.key}@${PROMPT_CONVERSA_LIA.version}`,
        instructions: `${PROMPT_CONVERSA_LIA.content}\n\n${contextoDoPedido(t)}`,
        messages: [...t.historico, { role: 'user', content: t.texto }],
        ferramentas,
        maxRodadas: RODADAS,
        schema: RespostaDaLia,
        parar: io.parar,
        aoUsarFerramenta: passo,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'parada') return parada();
      return avisoDoErro(err);
    }
    // Parou enquanto a última chamada terminava: o custo está registrado; a resposta não é entregue.
    if (io.parar.aborted) return parada();

    const resposta = RespostaDaLia.safeParse(r.object);
    if (!resposta.success) {
      this.logger.warn(`conversa: resposta da LIA fora do formato; uso ${r.usageId}`);
      await this.anotarRecusa(t, r.usageId, 'formato');
      return aviso('recusada');
    }
    const velhas = leituras.filter((l) => foraDoDia(l.ferramenta, l.valor).length > 0);
    const emDia = leituras.filter((l) => !velhas.includes(l));
    const nomes = [...new Set([t.marca.nome, ...leituras.flatMap((l) => nomesDaLeitura(l.valor))])];
    const fixo = contextoPermitido(t);
    // A fonte atrasada pode ser citada (qual é e a hora da última leitura): é o que a LIA diz no lugar da análise.
    const atrasadas = semRepetir(velhas.flatMap((l) => foraDoDia(l.ferramenta, l.valor)));
    const recusa = conferirResposta(resposta.data, {
      emDia: [emDia.map((l) => l.valor), atrasadas, t.texto, t.anteriores.daPessoa, t.anteriores.daLia, t.anteriores.numeros.map((n) => n.value), fixo],
      velhas: velhas.map((l) => l.valor),
      nomes,
      daMarca: t.daMarca,
    });
    if (recusa) {
      // O que foi recusado e por quê fica no log (números não são dado pessoal) e no conteúdo guardado da chamada.
      this.logger.warn(`conversa: resposta da LIA recusada (${recusa.recusa}${recusa.detalhe.length ? `: ${recusa.detalhe.slice(0, 8).join(' | ')}` : ''}); uso ${r.usageId}`);
      await this.anotarRecusa(t, r.usageId, recusa.recusa, recusa.regras);
      if (recusa.recusa === 'dado_velho') return aviso('dado_velho', { stale_sources: atrasadas });
      return aviso('recusada');
    }
    // Passou nas regras: o revisor de IA olha o tom, a clareza e as alegações. Se aponta, a recusa já ficou registrada
    // por ele, com a categoria, e a tela mostra o mesmo aviso da conferência ("a resposta foi retirada").
    if (revisor === 'pronto') {
      const revisao = await this.revisor.revisar(textoDaConversa(resposta.data), {
        tenantId: t.quem.tenantId,
        brandId: t.marca.id,
        userId: t.quem.userId,
        usageId: r.usageId,
        member: LIA.key,
        workflow: WORKFLOW,
      });
      // Parou enquanto o revisor lia: a resposta não é entregue.
      if (io.parar.aborted) return parada();
      if (revisao.situacao === 'apontou') return aviso('recusada');
      if (revisao.situacao === 'indisponivel') return avisoDoErro(revisao.erro);
    }

    const origens: OrigemDosNumeros[] = [
      ...emDia.map((l) => ({ rotulo: rotuloDaOrigem(l), valor: l.valor, comCaminho: true, ordem: 1 })),
      { rotulo: 'Você, nesta conversa', valor: [t.texto, ...t.anteriores.daPessoa], comCaminho: false, ordem: 2 },
      ...t.anteriores.numeros.flatMap((n) => n.sources.map((s) => ({ rotulo: s, valor: n.value, comCaminho: false, ordem: 3 }))),
      ...(atrasadas.length
        ? [{ rotulo: 'Liame · fonte fora do dia, com a última leitura', valor: atrasadas.map((a) => `${a.platform ?? ''} ${a.name} ${a.last_read ?? ''}`), comCaminho: false, ordem: 4 }]
        : []),
      { rotulo: 'Liame · calendário (dia de hoje e os próximos)', valor: fixo.datas, comCaminho: false, ordem: 4 },
      { rotulo: 'Liame · "a semana" são os 7 dias completos até ontem', valor: fixo.semana, comCaminho: false, ordem: 4 },
      ...(t.dossie ? [{ rotulo: 'Minha marca · dossiê da marca', valor: t.dossie, comCaminho: false, ordem: 4 }] : []),
    ];
    const { blocks, numbers, meeting } = marcarResposta(resposta.data, indiceDasOrigens(origens), nomes);
    if (meeting) cards.push({ kind: 'reuniao', demand: null, coupon: null, meeting });
    return { role: 'lia', status: 'ok', content: { blocks, numbers, read: lidas(leituras), cards, economy: r.servedBy === 'economico' }, usageId: r.usageId };
  }

  /**
   * `propor_cupom` presa a esta conversa: a marca é a da conversa; o pedido passa pelo mesmo serviço da rota da aba
   * Cupons, com a sessão de quem pergunta. Uma proposta por resposta.
   */
  private ferramentaDeCupom(t: TurnoPreparado, cards: ConversationCard[], leituras: Leitura[]): FerramentaIa {
    return {
      name: PROPOR_CUPOM.name,
      description: PROPOR_CUPOM.description,
      input: PROPOR_CUPOM.input,
      executar: async (bruto) => {
        const input = ProporCupomInput.safeParse(bruto);
        if (!input.success) return { ok: false, erro: 'Parâmetros inválidos para esta ferramenta.' };
        if (cards.some((k) => k.kind === 'proposta_cupom')) return { ok: false, erro: 'Esta resposta já mandou uma proposta de cupom para Aprovações.' };
        let proposta: Awaited<ReturnType<PropostaDeCupomService['propor']>>;
        try {
          proposta = await this.propostas.propor(t.auth, { brandId: t.marca.id, conversationId: t.conversa.id }, input.data);
        } catch (err) {
          if (err instanceof PropostaRecusada) return { ok: false, erro: err.message };
          throw err;
        }
        cards.push({ kind: 'proposta_cupom', demand: null, coupon: proposta, meeting: null });
        const p = proposta.request;
        const valor = valorDaProposta({
          codigo: p.code,
          loja: proposta.store_name,
          campanha: p.campaign?.name ?? null,
          de: p.valid_from,
          ate: p.valid_until,
          // O prazo é um instante: vira dia no fuso da loja (V34).
          expira: diaNoFuso(p.expires_at, t.marca.fuso),
        });
        leituras.push({ ferramenta: PROPOR_CUPOM.name, input: bruto, valor });
        return { ok: true, valor };
      },
    };
  }

  /** `abrir_demanda` presa a esta conversa: a marca e a mensagem são as da conversa, não as que o modelo disser. */
  private ferramentaDeDemanda(t: TurnoPreparado, cards: ConversationCard[], leituras: Leitura[]): FerramentaIa {
    return {
      name: ABRIR_DEMANDA.name,
      description: ABRIR_DEMANDA.description,
      input: ABRIR_DEMANDA.input,
      executar: async (bruto) => {
        const input = AbrirDemandaInput.safeParse(bruto);
        if (!input.success) return { ok: false, erro: 'Parâmetros inválidos para esta ferramenta.' };
        const { demanda, nova } = await this.demandas.abrirPelaLia(t.quem, { brandId: t.marca.id, conversationId: t.conversa.id, messageId: t.pessoa.id }, input.data);
        if (!cards.some((c) => c.demand?.id === demanda.id)) cards.push({ kind: 'demanda', demand: demanda, coupon: null, meeting: null });
        const valor = valorDaDemanda({ titulo: demanda.title, quemCuida: demanda.assignee.name, situacao: demanda.status, paraQuando: demanda.due_on, nova });
        leituras.push({ ferramenta: ABRIR_DEMANDA.name, input: bruto, valor });
        return { ok: true, valor };
      },
    };
  }

  /** Grava a resposta (ou o aviso) e libera a conversa, numa transação curta. */
  private gravar(t: TurnoPreparado, final: Final): Promise<{ mensagem: ConversationMessage; conversa: ConversationSummary }> {
    return naTransacaoDaEmpresa(this.db, t.quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<LinhaMensagem>(sql`
        insert into liame.conversation_message (id, tenant_id, conversation_id, user_id, role, status, content, usage_id)
        values (${uuidv7()}, ${t.quem.tenantId}, ${t.conversa.id}, ${t.quem.userId}, ${final.role}, ${final.status},
                ${JSON.stringify(final.content)}::jsonb, ${final.usageId})
        returning id, role, status, content, usage_id, created_at`);
      const conta = final.role === 'lia' && final.status === 'ok' ? 1 : 0;
      await tx.execute(sql`
        update liame.conversation set busy_since = null, last_message_at = now(), lia_answers = lia_answers + ${conta} where id = ${t.conversa.id}`);
      return { mensagem: mensagemDaLinha(r.rows[0]!), conversa: (await this.resumo(t.conversa.id))! };
    });
  }

  /** Solta a marca de "respondendo" (a resposta caiu no meio). Falha aqui só é registrada: a marca vence sozinha. */
  private async liberar(t: TurnoPreparado): Promise<void> {
    try {
      await naTransacaoDaEmpresa(this.db, t.quem, () => currentTx().execute(sql`update liame.conversation set busy_since = null where id = ${t.conversa.id}`));
    } catch (err) {
      this.logger.error(`conversa: não foi possível liberar a conversa ${t.conversa.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ------------------------------------------------------------------ apoio

  private empresa(auth: AuthContext): string {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa ativa', 'Escolha uma empresa para continuar.');
    return auth.tenantId;
  }

  private async exigirMarca(brandId: string): Promise<{ id: string; name: string }> {
    const r = await currentTx().execute<{ id: string; name: string }>(sql`select id, name from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta marca não existe nesta empresa.');
    return r.rows[0];
  }

  /** A LIA conversa nesta empresa e nesta marca? A flag `ia` e a LIA ativa. Roda na transação de quem chama. */
  private async liaAtiva(tenantId: string, userId: string, brandId: string): Promise<boolean> {
    if (!(await this.gateway.ligada({ tenantId, userId, brandId }))) return false;
    return funcionarioAtivo(currentTx(), { tenantId, brandId, agentKey: LIA.key, ativoPorPadrao: LIA.ativoPorPadrao });
  }

  private async resumo(id: string): Promise<ConversationSummary | null> {
    const r = await currentTx().execute<LinhaConversa>(sql`
      select c.id, c.brand_id, c.title, c.created_at, c.last_message_at, c.lia_answers,
             exists (select 1 from liame.demand d where d.conversation_id = c.id) as has_demand
        from liame.conversation c
       where c.id = ${id} and c.last_message_at > now() - make_interval(days => ${CONVERSATION_RETENTION_DAYS})`);
    return r.rows[0] ? this.resumoDaLinha(r.rows[0]) : null;
  }

  private resumoDaLinha(l: LinhaConversa): ConversationSummary {
    const ultima = new Date(l.last_message_at);
    return {
      id: l.id,
      brand_id: l.brand_id,
      title: l.title,
      created_at: iso(l.created_at),
      last_message_at: ultima.toISOString(),
      expires_at: new Date(ultima.getTime() + CONVERSATION_RETENTION_DAYS * 86_400_000).toISOString(),
      lia_answers: l.lia_answers,
      max_lia_answers: this.config.ai.conversationMaxAnswers,
      has_demand: l.has_demand,
    };
  }
}

/** O que a LIA leu, sem repetir, na ordem. */
function lidas(leituras: Leitura[]): string[] {
  return [...new Set(leituras.map((l) => rotuloDaLeitura(l.ferramenta, l.input)).filter((r): r is string => !!r))];
}

/** De onde veio o número, quando ele saiu do que a LIA fez (a demanda, a proposta) e não de uma leitura. */
function rotuloDaOrigem(l: Leitura): string {
  return rotuloDaLeitura(l.ferramenta, l.input) ?? (l.ferramenta === PROPOR_CUPOM.name ? 'Proposta de cupom enviada nesta resposta' : 'Demanda registrada nesta resposta');
}

function semRepetir(fontes: ConversationStaleSource[]): ConversationStaleSource[] {
  const vistas = new Set<string>();
  return fontes.filter((f) => {
    const k = `${f.platform}|${f.name}|${f.freshness}`;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}
