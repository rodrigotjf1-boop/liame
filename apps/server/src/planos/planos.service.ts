import {
  type ApprovePlanRequest,
  type EditPlanRequest,
  type ExplanationNumber,
  PlanContent,
  type PlanDecision,
  type PlanListQuery,
  type PlanListResponse,
  type PlanMarkedText,
  type PlanResponse,
  type PlanSummary,
  type ReanalyzePlanRequest,
  type RejectPlanRequest,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { indiceDasOrigens } from '../ai/conversa/fontes.js';
import { dinheiroDoPlano, hashDoConteudo, marcarPlano } from '../ai/estrategista/plano.js';
import { conferirEdicao } from '../ai/estrategista/resposta.js';
import { limparJson, limparTexto } from '../ai/sanitizar.js';
import { MfaService } from '../auth/mfa.service.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { proibidasDaMarca } from '../marca/marca.service.js';
import { ResultsService } from '../results/results.service.js';
import { nomesDaMarca, prazoDoPlano } from './prazo.js';

// Planos do Estrategista (A3, I11; protótipo P8, aguardando aprovação; sem tela ainda). A pessoa vê o plano com a fonte
// de cada número e decide: aprovar (com o código do app, para o hash que viu), editar (nasce uma versão nova, e a
// aprovação antiga deixa de valer), recusar (com o motivo) ou pedir nova análise (o Estrategista refaz, pela fila do
// worker). Nada é executado: quem muda campanha, verba ou cardápio é quem cuida deles. Tudo na transação da rota; o
// plano que passou do prazo aparece como `expirado` e não aceita decisão.

/** O número que uma pessoa escreveu ao editar e que não estava na versão anterior. */
const DE_QUEM_EDITOU = 'Escrito por quem editou esta versão do plano';

type LinhaResumo = {
  id: string;
  brand_id: string;
  kind: string;
  title: string;
  status: string;
  version: number;
  risk: string;
  money_micros: string | null;
  content_hash: string;
  expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  demand_id: string | null;
  requested_by: string | null;
  requester: string | null;
};

type LinhaVersao = {
  content: unknown;
  numbers: ExplanationNumber[];
  marked: PlanMarkedText[];
  author: string;
  created_by: string | null;
  editor: string | null;
  reanalysis: string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const quem = (id: string | null, nome: string | null) => (id ? { id, name: nome ?? 'Pessoa removida' } : null);

/** A situação que vale agora: pendente que passou do prazo é `expirado`, mesmo antes de alguém tocar no plano. */
const SITUACAO = sql`case when p.status = 'pendente' and p.expires_at <= now() then 'expirado' else p.status end`;
const RESUMO = sql`
  select p.id, p.brand_id, p.kind, p.title, ${SITUACAO} as status, p.version, v.risk, v.money_micros::text as money_micros, v.content_hash,
         p.expires_at, p.created_at, p.updated_at, p.demand_id, p.requested_by, u.name as requester
    from liame.plan p
    join liame.plan_version v on v.plan_id = p.id and v.version = p.version
    left join liame.app_user u on u.id = p.requested_by`;

function resumoDaLinha(l: LinhaResumo): PlanSummary {
  return {
    id: l.id,
    brand_id: l.brand_id,
    kind: l.kind,
    title: l.title,
    status: l.status,
    version: l.version,
    risk: l.risk,
    money_micros: l.money_micros,
    content_hash: l.content_hash,
    expires_at: iso(l.expires_at),
    created_at: iso(l.created_at),
    updated_at: iso(l.updated_at),
    demand_id: l.demand_id,
    requested_by: quem(l.requested_by, l.requester),
  };
}

@Injectable()
export class PlanosService {
  constructor(
    private readonly mfa: MfaService,
    private readonly resultados: ResultsService,
  ) {}

  /** Os planos da marca (até 100): os que esperam decisão primeiro, o que expira antes no topo; depois, os mais novos. */
  async list(auth: AuthContext, query: PlanListQuery): Promise<PlanListResponse> {
    this.empresa(auth);
    await this.exigirMarca(query.brand_id);
    const r = await currentTx().execute<LinhaResumo>(sql`
      ${RESUMO}
       where p.brand_id = ${query.brand_id} ${query.status ? sql`and ${SITUACAO} = ${query.status}` : sql``}
       order by (${SITUACAO} = 'pendente') desc, case when ${SITUACAO} = 'pendente' then p.expires_at end asc, p.created_at desc, p.id desc
       limit 100`);
    return { items: r.rows.map(resumoDaLinha) };
  }

  /** O plano com a versão atual, a fonte de cada número e as decisões já tomadas. */
  async get(auth: AuthContext, id: string): Promise<PlanResponse> {
    this.empresa(auth);
    const tx = currentTx();
    const resumo = await this.resumo(id);
    const v = (
      await tx.execute<LinhaVersao>(sql`
        select v.content, v.numbers, v.marked, v.author, v.created_by, u.name as editor, v.reanalysis
          from liame.plan_version v left join liame.app_user u on u.id = v.created_by
         where v.plan_id = ${id} and v.version = ${resumo.version}`)
    ).rows[0]!;
    const decisoes = await tx.execute<{ version: number; decision: string; reasons: string[]; comment: string | null; decided_by: string | null; decider: string | null; created_at: Date | string }>(sql`
      select d.version, d.decision, d.reasons, d.comment, d.decided_by, u.name as decider, d.created_at
        from liame.plan_decision d left join liame.app_user u on u.id = d.decided_by
       where d.plan_id = ${id}
       order by d.created_at, d.id`);
    return {
      plan: resumo,
      content: PlanContent.parse(v.content),
      numbers: v.numbers,
      marked: v.marked,
      author: v.author,
      edited_by: v.author === 'pessoa' ? quem(v.created_by, v.editor) : null,
      reanalysis: v.reanalysis,
      decisions: decisoes.rows.map(
        (d): PlanDecision => ({ version: d.version, decision: d.decision, reasons: d.reasons, comment: d.comment, decided_by: quem(d.decided_by, d.decider), created_at: iso(d.created_at) }),
      ),
      can_decide: auth.permissions.has('planos.decidir') && resumo.status === 'pendente',
    };
  }

  /**
   * Editar: a versão nova é a que a pessoa mandou, a partir da versão aberta (`base_version`). O texto perde o dado
   * pessoal e passa pelo Compliance e pelo que a marca não diz; a verba de hoje continua a calculada pelo código. A
   * aprovação da versão anterior deixa de valer: o plano volta a esperar a decisão, com prazo novo.
   */
  async edit(auth: AuthContext, id: string, body: EditPlanRequest): Promise<PlanResponse> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const p = await this.travar(id);
    if (p.status !== 'pendente' && p.status !== 'aprovado') {
      throw new AppProblem(409, 'plano-nao-editavel', 'O plano não pode mais ser editado', 'Só o plano que espera decisão ou que já foi aprovado pode ganhar uma versão nova.');
    }
    if (p.status === 'pendente' && p.expirado) throw this.expirado();
    if (body.base_version !== p.version) {
      throw new AppProblem(409, 'plano-mudou', 'O plano mudou', 'O plano ganhou uma versão nova depois que você abriu. Confira a versão nova e edite de novo.');
    }
    if (body.content.kind !== p.kind) throw new AppProblem(422, 'tipo-do-plano', 'O tipo do plano não muda', 'Edite o plano no mesmo tipo em que ele foi proposto.');
    const atual = await this.versao(id, p.version);
    const anterior = PlanContent.parse(atual.content);
    // O dado pessoal sai antes de tudo; a verba de hoje é a do código, nunca a da edição.
    let content = PlanContent.parse(limparJson(body.content).valor);
    if (content.kind === 'noventa_dias' && anterior.kind === 'noventa_dias') content = { ...content, budget: { ...content.budget, today: anterior.budget.today } };
    const nomes = await nomesDaMarca(tx, p.brand_id);
    const problemas = conferirEdicao(content, { nomes, daMarca: await proibidasDaMarca(p.brand_id) });
    if (problemas.length) {
      throw new AppProblem(422, 'texto-recusado', 'O texto não passa assim', `Ajuste e salve de novo: ${problemas.join('; ')}.`);
    }
    const hashAnterior = hashDoConteudo(anterior);
    const hash = hashDoConteudo(content);
    // O hash do conteúdo não é segredo (a rota o devolve a quem vê o plano): a comparação não tem o que vazar.
    // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack
    if (hash === hashAnterior) throw new AppProblem(409, 'plano-sem-mudanca', 'Nada mudou', 'A versão que você mandou é igual à atual.');

    // Os números que já estavam no plano levam a fonte de antes; o que a pessoa escreveu é dela.
    const origens = atual.numbers.flatMap((n) => n.sources.map((s) => ({ rotulo: s, valor: n.value, comCaminho: false, ordem: 1 })));
    const verba = (path: string) => {
      const m = atual.marked.find((x) => x.path === path);
      const n = m?.text.find((s) => s.number !== null)?.number;
      return n === undefined || n === null ? [DE_QUEM_EDITOU] : (atual.numbers[n]?.sources ?? [DE_QUEM_EDITOU]);
    };
    const { numbers, marked } = marcarPlano(content, indiceDasOrigens(origens), nomes, {
      semLugar: DE_QUEM_EDITOU,
      fontesDaVerba: { meta: verba('budget.today.meta'), google: verba('budget.today.google') },
    });
    const versao = p.version + 1;
    const fuso = await this.resultados.fusoDaMarca(p.brand_id);
    await tx.execute(sql`
      insert into liame.plan_version (id, tenant_id, plan_id, version, content, numbers, marked, risk, money_micros, content_hash, author, created_by)
      values (${uuidv7()}, ${tenantId}, ${id}, ${versao}, ${JSON.stringify(content)}::jsonb, ${JSON.stringify(numbers)}::jsonb, ${JSON.stringify(marked)}::jsonb,
              ${content.risk}, ${dinheiroDoPlano(content)}, ${hash}, 'pessoa', ${auth.userId})`);
    await tx.execute(sql`
      update liame.plan
         set version = ${versao}, status = 'pendente', expires_at = ${prazoDoPlano(content, fuso, new Date())}, updated_at = now()
       where id = ${id}`);
    auditDetail({ resourceId: id, before: { version: p.version, status: p.status, content_hash: hashAnterior }, after: { version: versao, status: 'pendente', content_hash: hash } });
    return this.get(auth, id);
  }

  /** Aprovar: o código do app agora, para o hash da versão que a pessoa viu (como as ações, ADR-007). Nada é executado. */
  async approve(auth: AuthContext, id: string, body: ApprovePlanRequest): Promise<PlanResponse> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const p = await this.paraDecidir(id, body.plan_hash, 'aprovar');
    await this.mfa.verifyStepUp(tx, auth.userId, body.code);
    await this.decidir(tenantId, id, p, auth.userId, { decision: 'aprovado', reasons: [], comment: null });
    await tx.execute(sql`update liame.plan set status = 'aprovado', updated_at = now() where id = ${id}`);
    auditDetail({ resourceId: id, after: { version: p.version, content_hash: p.content_hash, status: 'aprovado' } });
    return this.get(auth, id);
  }

  /** Recusar, com o motivo (e o comentário, sem dado pessoal). Recusar não executa nada: não pede o código do app. */
  async reject(auth: AuthContext, id: string, body: RejectPlanRequest): Promise<PlanResponse> {
    const tenantId = this.empresa(auth);
    const p = await this.paraDecidir(id, body.plan_hash, 'recusar');
    const comentario = body.comment ? limparTexto(body.comment).texto.trim() || null : null;
    await this.decidir(tenantId, id, p, auth.userId, { decision: 'recusado', reasons: [...new Set(body.reasons)], comment: comentario });
    await currentTx().execute(sql`update liame.plan set status = 'recusado', updated_at = now() where id = ${id}`);
    auditDetail({ resourceId: id, after: { version: p.version, content_hash: p.content_hash, status: 'recusado', reasons: [...new Set(body.reasons)].join(',') } });
    return this.get(auth, id);
  }

  /**
   * Pedir nova análise: o que a pessoa quer diferente (sem dado pessoal) vai para o Estrategista, que refaz o plano pela
   * fila do worker. Vale também para o plano que expirou sem decisão.
   */
  async reanalyze(auth: AuthContext, id: string, body: ReanalyzePlanRequest): Promise<PlanResponse> {
    const tenantId = this.empresa(auth);
    const p = await this.paraDecidir(id, body.plan_hash, 'pedir nova análise', { aceitaExpirado: true });
    const pedido = limparTexto(body.request).texto.trim();
    if (pedido.length < 3) throw new AppProblem(422, 'pedido-curto', 'Diga o que mudar', 'Escreva em poucas palavras o que você quer diferente no plano.');
    await this.decidir(tenantId, id, p, auth.userId, { decision: 'nova_analise', reasons: [], comment: pedido });
    await currentTx().execute(sql`
      update liame.plan set status = 'nova_analise', attempts = 0, next_attempt_at = null, last_error = null, updated_at = now() where id = ${id}`);
    auditDetail({ resourceId: id, after: { version: p.version, content_hash: p.content_hash, status: 'nova_analise' } });
    return this.get(auth, id);
  }

  // ------------------------------------------------------------------ apoio

  private empresa(auth: AuthContext): string {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa ativa', 'Escolha uma empresa para continuar.');
    return auth.tenantId;
  }

  private async exigirMarca(brandId: string): Promise<void> {
    const r = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows.length) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta marca não existe nesta empresa.');
  }

  private async resumo(id: string): Promise<PlanSummary> {
    const r = await currentTx().execute<LinhaResumo>(sql`${RESUMO} where p.id = ${id}`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este plano não existe nesta empresa.');
    return resumoDaLinha(r.rows[0]);
  }

  private async versao(id: string, version: number): Promise<LinhaVersao> {
    const r = await currentTx().execute<LinhaVersao>(sql`
      select content, numbers, marked, author, created_by, null as editor, reanalysis from liame.plan_version where plan_id = ${id} and version = ${version}`);
    return r.rows[0]!;
  }

  /** O plano travado para a decisão (uma decisão por vez), com o hash da versão atual e se o prazo já passou. */
  private async travar(id: string): Promise<{ status: string; version: number; kind: string; brand_id: string; content_hash: string; expirado: boolean }> {
    const r = await currentTx().execute<{ status: string; version: number; kind: string; brand_id: string; content_hash: string; expirado: boolean }>(sql`
      select p.status, p.version, p.kind, p.brand_id, v.content_hash, (p.expires_at <= now()) as expirado
        from liame.plan p join liame.plan_version v on v.plan_id = p.id and v.version = p.version
       where p.id = ${id}
         for update of p`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este plano não existe nesta empresa.');
    return r.rows[0];
  }

  /** O plano que espera decisão, no hash que a pessoa viu. O que passou do prazo só aceita nova análise. */
  private async paraDecidir(id: string, hash: string, acao: string, opcoes: { aceitaExpirado?: boolean } = {}) {
    const p = await this.travar(id);
    if (p.status !== 'pendente') throw new AppProblem(409, 'plano-nao-aguarda', 'O plano não espera decisão', `Não é possível ${acao}: este plano não está esperando decisão.`);
    if (p.expirado && !opcoes.aceitaExpirado) throw this.expirado();
    // É a conferência de versão (a que a pessoa viu é a atual?), não uma credencial: o hash vem na resposta do plano.
    // nosemgrep: ajinabraham.njsscan.crypto.timing_attack_node.node_timing_attack
    if (p.content_hash !== hash) {
      throw new AppProblem(409, 'plano-mudou', 'O plano mudou', 'O plano ganhou uma versão nova depois que você abriu. Confira a versão nova antes de decidir.');
    }
    return p;
  }

  private expirado(): AppProblem {
    return new AppProblem(409, 'plano-expirado', 'O plano expirou', 'Ninguém decidiu a tempo. Peça uma nova análise para o Estrategista montar uma versão atual.');
  }

  private async decidir(
    tenantId: string,
    planId: string,
    p: { version: number; content_hash: string },
    userId: string,
    d: { decision: 'aprovado' | 'recusado' | 'nova_analise'; reasons: string[]; comment: string | null },
  ): Promise<void> {
    await currentTx().execute(sql`
      insert into liame.plan_decision (id, tenant_id, plan_id, version, content_hash, decision, reasons, comment, decided_by)
      values (${uuidv7()}, ${tenantId}, ${planId}, ${p.version}, ${p.content_hash}, ${d.decision},
              ${sql`array[${sql.join(d.reasons.map((x) => sql`${x}`), sql`, `)}]::text[]`}, ${d.comment}, ${userId})`);
  }
}
