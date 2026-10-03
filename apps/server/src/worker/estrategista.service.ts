import { type ConversationStaleSource, type ExplanationNumber, PlanContent, type PlanKind, type PlanMarkedText } from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { indiceDasOrigens } from '../ai/conversa/fontes.js';
import { foraDoDia, nomesDaLeitura, rotuloDaLeitura } from '../ai/conversa/leituras.js';
import { contextoDoPlano, type DadosDoPlano, fontesDaVerba, mensagemDoPlano, origensDoPlano, type PedidoDoPlano, permitidoNoContexto } from '../ai/estrategista/contexto.js';
import { cuponsAtivos, dinheiroDoPlano, hashDoConteudo, marcarPlano, TITULO_DO_TIPO, verbaDeHoje } from '../ai/estrategista/plano.js';
import { ESTRATEGISTA, PROMPT_ESTRATEGISTA, TAREFA_ESTRATEGISTA } from '../ai/estrategista/prompt.js';
import { conferirPlano, conteudoDaResposta, JANELA_DO_TIPO, RESPOSTA_DO_TIPO } from '../ai/estrategista/resposta.js';
import { AiError, type AiErrorCode, AiGateway, type FerramentaIa } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { FerramentasDeLeitura } from '../ai/registro/leituras.js';
import { limparJson } from '../ai/sanitizar.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { dossieParaOModelo, proibidasDaMarca } from '../marca/marca.service.js';
import { nomesDaMarca, prazoDoPlano } from '../planos/prazo.js';
import { nomesPoliticos } from '../policy/texto.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';
import { ResultsService } from '../results/results.service.js';

// O Estrategista de uma demanda ou de uma nova análise (A3, I11; protótipo P8, aguardando aprovação). Fica na pasta do
// worker porque é uma rotina da fila, sem pessoa na sessão:
//   1. lê, como a empresa, o pedido (a demanda que a LIA registrou, ou a versão atual e o pedido de nova análise), a
//      verba de hoje (os mesmos números da tela Resultados), o calendário comercial e o dossiê;
//   2. chama o Estrategista, sem transação aberta, com as leituras que a rotina do sistema pode fazer;
//   3. confere o plano (formato, dias, datas do calendário, cupom, Compliance, o que a marca não diz e cada número);
//   4. grava o plano (ou a versão seguinte) para Aprovações, com a fonte de cada número, e a auditoria do agente.
// Nada é executado em plataforma nenhuma. Quem decide o que acontece com a demanda depois de cada vez é a fila
// (`estrategista-loop.ts`).

export const WORKFLOW = 'estrategista.plano';
/** Chamadas ao modelo num plano (cada uma pode pedir leituras, várias de uma vez). */
const RODADAS = 6;
const SEM_LUGAR = 'Liame · dado lido pelo Estrategista';

/** O que a fila entregou: uma demanda (plano novo) ou um plano com nova análise pedida (versão seguinte). */
export interface ItemDoEstrategista {
  tipo: 'demanda' | 'nova_analise';
  id: string;
  tenantId: string;
  brandId: string;
  kind: PlanKind;
}

export type ResultadoDoEstrategista =
  | { status: 'proposto'; planId: string; version: number }
  /** O Estrategista não foi chamado ou não respondeu por um motivo que não é dele (IA desligada, sem rota, teto). */
  | { status: 'sem_ia'; motivo: AiErrorCode | 'funcionario_desligado'; voltaEm?: Date }
  /** Respondeu, e o plano não passou (ou nem foi chamado: nome político nos dados). Conta como tentativa. */
  | { status: 'recusado'; motivo: string }
  /** O item não está mais com o Estrategista (a demanda mudou, a marca foi arquivada). */
  | { status: 'descartado'; motivo: string };

interface Leitura {
  ferramenta: string;
  input: unknown;
  valor: unknown;
}

type Lido =
  | { descartado: string }
  | { dados: DadosDoPlano; pediu: string | null; ativo: boolean; daMarca: string[]; politicos: string[]; titulo: string; demandId: string | null };

@Injectable()
export class EstrategistaService {
  private readonly logger = new Logger('estrategista');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly gateway: AiGateway,
    private readonly leituras: FerramentasDeLeitura,
    private readonly resultados: ResultsService,
  ) {}

  /** Gera o plano do item. O relógio injetado vale para a operação inteira (V34). */
  async gerar(item: ItemDoEstrategista, agora = new Date()): Promise<ResultadoDoEstrategista> {
    if (!this.database) throw new Error('estrategista: sem banco');
    const quem = { tenantId: item.tenantId, userId: null };

    // ---- 1. leitura, como a empresa
    const lido = await naTransacaoDaEmpresa(this.database, quem, () => this.ler(item, agora));
    if ('descartado' in lido) return { status: 'descartado', motivo: lido.descartado };
    const { dados } = lido;
    if (!lido.ativo) return { status: 'sem_ia', motivo: 'funcionario_desligado' };
    // Uso político ou eleitoral é proibido nos Termos (A3-15): com campanha ou conta de nome político, a IA nem é chamada.
    if (lido.politicos.length) {
      this.logger.warn(`plano sem IA: campanha ou conta com nome político ou eleitoral (empresa ${item.tenantId})`);
      return { status: 'recusado', motivo: 'conteudo_politico' };
    }

    // ---- 2. o Estrategista, sem transação aberta
    const leituras: Leitura[] = [];
    const ctx = { tenantId: item.tenantId, userId: null, permissions: 'sistema' as const, agora };
    // As leituras da rotina, cada uma guardada como o modelo a recebeu (é o que vale na conferência).
    const ferramentas: FerramentaIa[] = this.leituras.paraPedido(ctx).map((f) => ({
      ...f,
      executar: async (input) => {
        const r = await f.executar(input);
        if (r.ok) leituras.push({ ferramenta: f.name, input, valor: limparJson(r.valor).valor });
        return r;
      },
    }));
    let r: Awaited<ReturnType<AiGateway['agent']>>;
    try {
      r = await this.gateway.agent({
        tenantId: item.tenantId,
        brandId: item.brandId,
        // O custo é de quem pediu o plano (a demanda, ou a nova análise): conta no limite por pessoa.
        userId: lido.pediu,
        workflow: WORKFLOW,
        task: TAREFA_ESTRATEGISTA,
        promptVersion: `${PROMPT_ESTRATEGISTA.key}@${PROMPT_ESTRATEGISTA.version}`,
        instructions: `${PROMPT_ESTRATEGISTA.content}\n\n${contextoDoPlano(dados)}`,
        messages: [{ role: 'user', content: mensagemDoPlano(dados) }],
        ferramentas,
        maxRodadas: RODADAS,
        schema: RESPOSTA_DO_TIPO[item.kind],
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      return err.code === 'indisponivel' || err.code === 'entrada-grande' ? { status: 'recusado', motivo: err.code } : { status: 'sem_ia', motivo: err.code, voltaEm: err.detalhe.voltaEm };
    }

    // ---- 3. conferência
    const mapeado = conteudoDaResposta(item.kind, r.object, dados.verbaDeHoje);
    if (!mapeado.ok) {
      this.logger.warn(`plano do Estrategista fora do formato (${mapeado.detalhe.join(' | ')}); uso ${r.usageId}`);
      return { status: 'recusado', motivo: 'formato' };
    }
    const content = mapeado.content;
    const velhas = leituras.filter((l) => foraDoDia(l.ferramenta, l.valor).length > 0);
    const emDia = leituras.filter((l) => !velhas.includes(l));
    const atrasadas = semRepetir(velhas.flatMap((l) => foraDoDia(l.ferramenta, l.valor)));
    const nomes = [...new Set([dados.marca.nome, ...leituras.flatMap((l) => nomesDaLeitura(l.valor))])];
    const recusa = conferirPlano(content, {
      hoje: dados.hoje,
      calendario: dados.calendario,
      cupons: cuponsAtivos(leituras),
      // A fonte atrasada pode ser citada (qual é e a hora da última leitura): é o que o plano diz no lugar dos números dela.
      emDia: [emDia.map((l) => l.valor), atrasadas, permitidoNoContexto(dados)],
      velhas: velhas.map((l) => l.valor),
      nomes,
      daMarca: lido.daMarca,
    });
    if (recusa) {
      // O que foi recusado e por quê fica no log (números não são dado pessoal) e no conteúdo guardado da chamada.
      this.logger.warn(`plano do Estrategista recusado (${recusa.recusa}${recusa.detalhe.length ? `: ${recusa.detalhe.slice(0, 8).join(' | ')}` : ''}); uso ${r.usageId}`);
      return { status: 'recusado', motivo: recusa.recusa };
    }

    // ---- 4. a fonte de cada número, dita pelo código
    const origens = origensDoPlano(dados, {
      leituras: emDia.map((l) => ({ rotulo: rotuloDaLeitura(l.ferramenta, l.input) ?? SEM_LUGAR, valor: l.valor })),
      content,
      atrasadas,
    });
    const { numbers, marked } = marcarPlano(content, indiceDasOrigens(origens), nomes, { semLugar: SEM_LUGAR, fontesDaVerba: fontesDaVerba(dados.semana) });

    // ---- 5. gravação, numa transação curta da empresa
    return naTransacaoDaEmpresa(this.database, quem, () => this.gravar(item, { content, numbers, marked, usageId: r.usageId, lido, agora }));
  }

  /** O que a geração precisa, na transação da empresa. O item que não está mais com o Estrategista é descartado. */
  private async ler(item: ItemDoEstrategista, agora: Date): Promise<Lido> {
    const tx = currentTx();
    const marca = (await tx.execute<{ id: string; name: string }>(sql`select id, name from liame.brand where id = ${item.brandId} and archived_at is null`)).rows[0];
    if (!marca) return { descartado: 'a marca foi arquivada' };
    let pedido: PedidoDoPlano | null = null;
    let pediu: string | null = null;
    let anterior: DadosDoPlano['anterior'] = null;
    let titulo: string = TITULO_DO_TIPO[item.kind];
    let demandId: string | null = null;
    const daDemanda = async (id: string) =>
      (
        await tx.execute<{ title: string; detail: string; notes: string | null; due_on: string | null; status: string; requested_by: string | null }>(sql`
          select title, detail, notes, due_on::text as due_on, status, requested_by from liame.demand where id = ${id}`)
      ).rows[0];
    if (item.tipo === 'demanda') {
      const d = await daDemanda(item.id);
      if (!d || d.status !== 'em_andamento') return { descartado: 'a demanda não está mais com o Estrategista' };
      pedido = { title: d.title, detail: d.detail, notes: d.notes, due_on: d.due_on };
      pediu = d.requested_by;
      titulo = d.title;
      demandId = item.id;
    } else {
      const p = (
        await tx.execute<{ status: string; version: number; title: string; demand_id: string | null; content: unknown; numbers: ExplanationNumber[] }>(sql`
          select p.status, p.version, p.title, p.demand_id, v.content, v.numbers
            from liame.plan p join liame.plan_version v on v.plan_id = p.id and v.version = p.version
           where p.id = ${item.id}`)
      ).rows[0];
      if (!p || p.status !== 'nova_analise') return { descartado: 'o plano não espera mais nova análise' };
      const conteudo = PlanContent.safeParse(p.content);
      if (!conteudo.success) return { descartado: 'a versão atual do plano está fora do formato' };
      const pedida = (
        await tx.execute<{ comment: string | null; decided_by: string | null }>(sql`
          select comment, decided_by from liame.plan_decision
           where plan_id = ${item.id} and decision = 'nova_analise' order by created_at desc, id desc limit 1`)
      ).rows[0];
      anterior = { version: p.version, content: conteudo.data, pedido: pedida?.comment ?? '', numbers: Array.isArray(p.numbers) ? p.numbers : [] };
      pediu = pedida?.decided_by ?? null;
      titulo = p.title;
      if (p.demand_id) {
        const d = await daDemanda(p.demand_id);
        if (d) pedido = { title: d.title, detail: d.detail, notes: d.notes, due_on: d.due_on };
      }
    }
    const fuso = await this.resultados.fusoDaMarca(marca.id);
    const hoje = diaNoFuso(agora, fuso);
    const semana = { from: menosDias(hoje, 7), to: menosDias(hoje, 1) };
    // O calendário da janela maior (90 dias) vai para todos os tipos: a oferta e a pauta também caem em data comemorativa.
    const calendario = (
      await tx.execute<{ day: string; name: string; kind: string }>(sql`
        select day::text as day, name, kind from liame.commercial_date
         where day between ${hoje}::date and ${menosDias(hoje, -JANELA_DO_TIPO.noventa_dias)}::date
         order by day, name`)
    ).rows;
    return {
      dados: {
        kind: item.kind,
        hoje,
        marca: { id: marca.id, nome: marca.name, fuso },
        dossie: await dossieParaOModelo(marca.id, marca.name),
        calendario,
        verbaDeHoje: verbaDeHoje(await this.resultados.closedLoop({ brand_id: marca.id, ...semana }, agora)),
        semana,
        pedido,
        anterior,
      },
      pediu,
      ativo: await funcionarioAtivo(tx, { tenantId: item.tenantId, brandId: marca.id, agentKey: ESTRATEGISTA.key, ativoPorPadrao: ESTRATEGISTA.ativoPorPadrao }),
      daMarca: await proibidasDaMarca(marca.id),
      politicos: nomesPoliticos(await nomesDaMarca(tx, marca.id)),
      titulo,
      demandId,
    };
  }

  /** Grava o plano novo (a demanda vira `entregue`) ou a versão seguinte (o plano volta a esperar a decisão). */
  private async gravar(
    item: ItemDoEstrategista,
    g: { content: PlanContent; numbers: ExplanationNumber[]; marked: PlanMarkedText[]; usageId: string; lido: Extract<Lido, { dados: DadosDoPlano }>; agora: Date },
  ): Promise<ResultadoDoEstrategista> {
    const tx = currentTx();
    const hash = hashDoConteudo(g.content);
    const dinheiro = dinheiroDoPlano(g.content);
    const expira = prazoDoPlano(g.content, g.lido.dados.marca.fuso, g.agora);
    let planId: string;
    let versao: number;
    if (item.tipo === 'demanda') {
      const d = (await tx.execute<{ status: string; requested_by: string | null }>(sql`select status, requested_by from liame.demand where id = ${item.id} for update`)).rows[0];
      if (!d || d.status !== 'em_andamento') return { status: 'descartado', motivo: 'a demanda não está mais com o Estrategista' };
      planId = uuidv7();
      versao = 1;
      // Uma demanda vira um plano só: outra tentativa que chegou antes ganha (V24).
      const novo = await tx.execute<{ id: string }>(sql`
        insert into liame.plan (id, tenant_id, brand_id, kind, title, status, version, demand_id, requested_by, expires_at)
        values (${planId}, ${item.tenantId}, ${item.brandId}, ${item.kind}, ${g.lido.titulo}, 'pendente', 1, ${item.id}, ${d.requested_by}, ${expira})
        on conflict (demand_id) where demand_id is not null do nothing
        returning id`);
      await tx.execute(sql`
        update liame.demand set status = 'entregue', next_attempt_at = null, last_error = null, updated_at = now() where id = ${item.id}`);
      if (!novo.rows.length) return { status: 'descartado', motivo: 'a demanda já tinha plano' };
    } else {
      const p = (await tx.execute<{ status: string; version: number }>(sql`select status, version from liame.plan where id = ${item.id} for update`)).rows[0];
      if (!p || p.status !== 'nova_analise') return { status: 'descartado', motivo: 'o plano não espera mais nova análise' };
      planId = item.id;
      versao = p.version + 1;
      await tx.execute(sql`
        update liame.plan
           set version = ${versao}, status = 'pendente', expires_at = ${expira}, attempts = 0, next_attempt_at = null, last_error = null, updated_at = now()
         where id = ${planId}`);
    }
    await tx.execute(sql`
      insert into liame.plan_version (id, tenant_id, plan_id, version, content, numbers, marked, risk, money_micros, content_hash, author, reanalysis, usage_id)
      values (${uuidv7()}, ${item.tenantId}, ${planId}, ${versao}, ${JSON.stringify(g.content)}::jsonb, ${JSON.stringify(g.numbers)}::jsonb,
              ${JSON.stringify(g.marked)}::jsonb, ${g.content.risk}, ${dinheiro}, ${hash}, 'estrategista', ${g.lido.dados.anterior?.pedido || null}, ${g.usageId})`);
    await writeAudit(tx, {
      tenantId: item.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: 'Estrategista',
      action: 'plano.propor',
      resourceType: 'plan',
      resourceId: planId,
      after: { kind: item.kind, version: versao, content_hash: hash, risk: g.content.risk, money_micros: dinheiro, demand_id: g.lido.demandId, nova_analise: item.tipo === 'nova_analise' },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: ESTRATEGISTA.key,
    });
    return { status: 'proposto', planId, version: versao };
  }
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
