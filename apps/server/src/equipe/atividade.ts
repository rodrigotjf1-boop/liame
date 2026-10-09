import type { TeamActivityItem } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';
import { PREFIXO_RECUSA } from '../actions/action.service.js';
import { RECUSAS_DO_COMPLIANCE } from '../ai/recusas.js';
import type { Membro } from './membros.js';

// "O que fez" (A3; protótipo P7, aprovado em 03/10/2026): os acontecimentos de cada membro da equipe, lidos do que já
// está guardado (uso de IA, demandas, planos, revisões, páginas lidas, sombra, propostas de autonomia, pedidos de peças
// e as decisões delas, recusas da conferência e as vezes em que a empresa desligou ou ligou). Nada novo é gravado. Roda na requisição, sob a RLS da
// empresa, com a empresa e a marca em cada ramo.
//
// O que a pessoa vê aqui é o que ela já pode ver na tela de origem: o título da conversa, só o da própria (a RLS da
// conversa já barra as dos outros); o do plano e o da demanda, com `planos.ver` (ou quando foi ela quem pediu); o site
// lido, com `dossie.ver`. Quem perguntou à LIA ou pediu uma explicação só aparece para a própria pessoa.

/** A lista olha os últimos 90 dias. */
export const DIAS_DA_ATIVIDADE = 90;

export interface QuemOlha {
  tenantId: string;
  brandId: string;
  userId: string;
  /** O começo do período, em ISO. */
  desde: string;
  /** Vê os planos e as demandas (`planos.ver`). */
  podePlanos: boolean;
  /** Vê o dossiê e as páginas lidas (`dossie.ver`). */
  podeDossie: boolean;
  /** Vê as campanhas e, com elas, a tela de Criativos (`campanhas.ver`): a oferta do pedido e o título da peça. */
  podePecas: boolean;
}

interface Colunas {
  at: SQL;
  kind: SQL | string;
  /** A chamada de IA do acontecimento: é por ela que se acha o retorno da pessoa e, na conversa, o título. */
  ref?: SQL;
  subject?: SQL;
  detail?: SQL;
  d1?: SQL;
  d2?: SQL;
  n?: SQL;
  /** Um segundo número do acontecimento (as peças barradas de um pedido). */
  n2?: SQL;
  by?: SQL;
  rules?: SQL;
}

const NULO = sql`null`;

/** Um ramo da união: as mesmas colunas, com o tipo dito em cada uma. */
function ramo(c: Colunas, origem: SQL): SQL {
  const kind = typeof c.kind === 'string' ? sql`${c.kind}` : c.kind;
  return sql`
    select (${c.at})::timestamptz as at, (${kind})::text as kind, (${c.ref ?? NULO})::uuid as ref, (${c.subject ?? NULO})::text as subject,
           (${c.detail ?? NULO})::text as detail, (${c.d1 ?? NULO})::date as d1, (${c.d2 ?? NULO})::date as d2, (${c.n ?? NULO})::integer as n,
           (${c.n2 ?? NULO})::integer as n2,
           (${c.by ?? NULO})::uuid as by_id, (${c.rules ?? sql`'[]'`})::jsonb as rules
      ${origem}`;
}

/**
 * Uma resposta da IA que chegou à pessoa, num fluxo: a chamada que respondeu (`answered`; as rodadas de leitura antes
 * dela não são respostas) e que a conferência não recusou (a recusada aparece em `retiradas`). Quem pediu só aparece
 * para a própria pessoa.
 */
const usoDeIa = (q: QuemOlha, fluxo: string, kind: string): SQL =>
  ramo(
    { at: sql`u.occurred_at`, kind, ref: sql`u.id`, by: sql`case when u.user_id = ${q.userId} then u.user_id end` },
    sql`from liame.ai_usage u
        where u.tenant_id = ${q.tenantId} and u.brand_id = ${q.brandId} and u.workflow = ${fluxo} and u.answered
          and not exists (select 1 from liame.ai_refusal r where r.usage_id = u.id) and u.occurred_at >= ${q.desde}::timestamptz`,
  );

/** Os textos do membro que a conferência não deixou aparecer (D-A3-15): sem o texto, só o porquê. */
const retiradas = (q: QuemOlha, membro: Membro): SQL =>
  ramo(
    { at: sql`r.created_at`, kind: 'retirada_na_conferencia', detail: sql`r.kind`, n: sql`r.items`, rules: sql`r.rules` },
    sql`from liame.ai_refusal r
        where r.tenant_id = ${q.tenantId} and r.brand_id = ${q.brandId} and r.member = ${membro} and r.created_at >= ${q.desde}::timestamptz`,
  );

/** As vezes em que a empresa desligou e ligou o membro nesta marca. */
const pausas = (q: QuemOlha, membro: Membro): SQL[] => [
  ramo(
    { at: sql`p.paused_at`, kind: 'desligado', by: sql`p.paused_by` },
    sql`from liame.agent_pause p
        where p.tenant_id = ${q.tenantId} and p.brand_id = ${q.brandId} and p.agent_key = ${membro} and p.paused_at >= ${q.desde}::timestamptz`,
  ),
  ramo(
    { at: sql`p.resumed_at`, kind: 'ligado', by: sql`p.resumed_by` },
    sql`from liame.agent_pause p
        where p.tenant_id = ${q.tenantId} and p.brand_id = ${q.brandId} and p.agent_key = ${membro} and p.resumed_at >= ${q.desde}::timestamptz`,
  ),
];

/** As demandas (o título, para quem vê os planos ou para quem pediu). */
const demandas = (q: QuemOlha, kind: string, filtro: SQL): SQL =>
  ramo(
    {
      at: sql`d.created_at`,
      kind,
      subject: sql`case when ${q.podePlanos}::boolean or d.requested_by = ${q.userId} then d.title end`,
      detail: sql`d.kind`,
      by: sql`d.requested_by`,
    },
    sql`from liame.demand d
        where d.tenant_id = ${q.tenantId} and d.brand_id = ${q.brandId} and ${filtro} and d.created_at >= ${q.desde}::timestamptz`,
  );

function ramosDoMembro(membro: Membro, q: QuemOlha): SQL[] {
  const tituloDoPlano = sql`case when ${q.podePlanos}::boolean then p.title end`;
  switch (membro) {
    case 'lia':
      return [usoDeIa(q, 'conversa.lia', 'respondeu'), demandas(q, 'abriu_demanda', sql`d.opened_by_agent = 'lia'`), retiradas(q, membro), ...pausas(q, membro)];
    case 'analista':
      return [usoDeIa(q, 'resultados.explicar', 'explicou_resultados'), usoDeIa(q, 'atencao.explicar', 'explicou_aviso'), retiradas(q, membro), ...pausas(q, membro)];
    case 'relatorios':
      return [
        ramo(
          { at: sql`w.generated_at`, kind: 'gerou_revisao', ref: sql`w.usage_id`, detail: sql`w.reading_source`, d1: sql`w.week_from`, d2: sql`w.week_to` },
          sql`from liame.weekly_review w where w.tenant_id = ${q.tenantId} and w.brand_id = ${q.brandId} and w.generated_at >= ${q.desde}::timestamptz`,
        ),
        ramo(
          { at: sql`w.email_sent_at`, kind: 'enviou_revisao', d1: sql`w.week_from`, d2: sql`w.week_to`, n: sql`w.email_recipients` },
          sql`from liame.weekly_review w
              where w.tenant_id = ${q.tenantId} and w.brand_id = ${q.brandId} and w.email_status = 'enviado' and w.email_sent_at >= ${q.desde}::timestamptz`,
        ),
        retiradas(q, membro),
        ...pausas(q, membro),
      ];
    case 'compliance':
      // O que ele barrou, de qualquer funcionário: `detail` diz quem escreveu. O Compliance não desliga.
      return [
        ramo(
          { at: sql`r.created_at`, kind: 'barrou_texto', detail: sql`r.member`, n: sql`r.items`, rules: sql`r.rules` },
          sql`from liame.ai_refusal r
              where r.tenant_id = ${q.tenantId} and r.brand_id = ${q.brandId}
                and r.kind in (${sql.join(RECUSAS_DO_COMPLIANCE.map((k) => sql`${k}`), sql`, `)}) and r.created_at >= ${q.desde}::timestamptz`,
        ),
      ];
    case 'estrategista':
      return [
        demandas(q, 'recebeu_demanda', sql`d.assignee_agent = 'estrategista'`),
        ramo(
          { at: sql`v.created_at`, kind: 'montou_plano', ref: sql`v.usage_id`, subject: tituloDoPlano, detail: sql`p.kind`, n: sql`v.version` },
          sql`from liame.plan_version v join liame.plan p on p.id = v.plan_id
              where p.tenant_id = ${q.tenantId} and p.brand_id = ${q.brandId} and v.author = 'estrategista' and v.created_at >= ${q.desde}::timestamptz`,
        ),
        ramo(
          { at: sql`x.created_at`, kind: sql`'plano_' || x.decision`, subject: tituloDoPlano, detail: sql`p.kind`, by: sql`x.decided_by` },
          sql`from liame.plan_decision x join liame.plan p on p.id = x.plan_id
              where p.tenant_id = ${q.tenantId} and p.brand_id = ${q.brandId} and x.created_at >= ${q.desde}::timestamptz`,
        ),
        retiradas(q, membro),
        ...pausas(q, membro),
      ];
    case 'pesquisador':
      return [
        ramo(
          {
            at: sql`r.finished_at`,
            kind: sql`case r.status when 'concluida' then 'leu_pagina' when 'recusada' then 'pagina_recusada' else 'pagina_falhou' end`,
            subject: sql`case when ${q.podeDossie}::boolean then r.host end`,
            detail: sql`case when r.status = 'concluida' then r.kind else r.reason end`,
            n: sql`case when r.status = 'concluida' then cardinality(r.sections) end`,
            by: sql`r.requested_by`,
          },
          sql`from liame.research_request r
              where r.tenant_id = ${q.tenantId} and r.brand_id = ${q.brandId} and r.status in ('concluida', 'recusada', 'falhou') and r.finished_at >= ${q.desde}::timestamptz`,
        ),
        retiradas(q, membro),
        ...pausas(q, membro),
      ];
    case 'criativo': {
      // O título da versão: o que a pessoa leu ao decidir, ou o que o pedido de outra versão entregou.
      const titulo = sql`case when ${q.podePecas}::boolean then v.title end`;
      const doPedido = sql`from liame.ad_piece_request r where r.tenant_id = ${q.tenantId} and r.brand_id = ${q.brandId}`;
      return [
        // Um pedido de peças novas atendido: quantas saíram e quantas a conferência barrou de saída.
        ramo(
          {
            at: sql`r.finished_at`,
            kind: 'escreveu_pecas',
            ref: sql`r.usage_id`,
            subject: sql`case when ${q.podePecas}::boolean then r.offer end`,
            n: sql`r.pieces`,
            n2: sql`(select count(*) from liame.ad_piece_version x where x.request_id = r.id and x.version = 1 and x.review_status = 'barrou')`,
            by: sql`r.requested_by`,
          },
          sql`${doPedido} and r.piece_id is null and r.status = 'concluido' and r.finished_at >= ${q.desde}::timestamptz`,
        ),
        // Outra versão de uma peça, a pedido: a versão que saiu e o resultado da conferência dela.
        ramo(
          { at: sql`r.finished_at`, kind: 'refez_peca', ref: sql`r.usage_id`, subject: titulo, detail: sql`v.review_status`, n: sql`v.version`, by: sql`r.requested_by` },
          sql`from liame.ad_piece_request r join liame.ad_piece_version v on v.request_id = r.id
              where r.tenant_id = ${q.tenantId} and r.brand_id = ${q.brandId} and r.piece_id is not null and r.status = 'concluido' and r.finished_at >= ${q.desde}::timestamptz`,
        ),
        // O pedido que ele não atendeu: recusado (não escreve sobre aquilo, ou nenhuma peça serviu) ou com falha.
        ramo(
          {
            at: sql`r.finished_at`,
            kind: sql`case r.status when 'recusado' then 'pedido_recusado' else 'pedido_falhou' end`,
            subject: sql`case when ${q.podePecas}::boolean and r.piece_id is null then r.offer end`,
            detail: sql`r.reason`,
            by: sql`r.requested_by`,
          },
          sql`${doPedido} and r.status in ('recusado', 'falhou') and r.finished_at >= ${q.desde}::timestamptz`,
        ),
        // O que as pessoas decidiram das peças dele.
        ramo(
          { at: sql`x.created_at`, kind: sql`'peca_' || x.decision`, subject: titulo, detail: sql`x.reason`, n: sql`x.version`, by: sql`x.decided_by` },
          sql`from liame.ad_piece_decision x join liame.ad_piece p on p.id = x.piece_id
              left join liame.ad_piece_version v on v.piece_id = x.piece_id and v.version = x.version
              where x.tenant_id = ${q.tenantId} and p.brand_id = ${q.brandId} and x.created_at >= ${q.desde}::timestamptz`,
        ),
        retiradas(q, membro),
        ...pausas(q, membro),
      ];
    }
    case 'crm': {
      // O nome da mensagem só para quem vê as campanhas (é quem vê a tela Mensagens e o pedido em Aprovações).
      const nome = sql`case when ${q.podePecas}::boolean then m.name end`;
      const doPedido = sql`from liame.message_request m join liame.action_request r on r.id = m.action_request_id
                          where m.tenant_id = ${q.tenantId} and m.brand_id = ${q.brandId} and m.agent_key = ${membro}`;
      return [
        // O pedido de envio que ele montou: a mensagem e quantas pessoas podem receber.
        ramo({ at: sql`m.created_at`, kind: 'propos_mensagem', subject: nome, n: sql`m.people_can_receive` }, sql`${doPedido} and m.created_at >= ${q.desde}::timestamptz`),
        // O que aconteceu com o pedido: uma pessoa aprovou e o envio foi para o RegemCast, recusou, cancelou (quem opera
        // tirou o pedido da fila), deixou expirar, ou o envio falhou. Quem aprovou é a aprovação mais recente; quem recusou
        // não fica em coluna (o nome está no motivo).
        ramo(
          {
            at: sql`r.updated_at`,
            kind: sql`case when r.status = 'executada' then 'mensagem_enviada' when r.status = 'falhou' then 'mensagem_falhou' when r.status = 'expirada' then 'mensagem_expirou'
                           when r.status_reason like ${`${PREFIXO_RECUSA}%`} then 'mensagem_recusada' else 'mensagem_cancelada' end`,
            subject: nome,
            n: sql`m.people_can_receive`,
            by: sql`case when r.status = 'executada' then (select a.approved_by from liame.approval a where a.action_request_id = r.id order by a.created_at desc limit 1) end`,
          },
          sql`${doPedido} and r.status in ('executada', 'falhou', 'expirada', 'cancelada') and r.updated_at >= ${q.desde}::timestamptz`,
        ),
        retiradas(q, membro),
        ...pausas(q, membro),
      ];
    }
    case 'trafego': {
      const daSombra = sql`from liame.shadow_decision d join liame.campaign c on c.id = d.campaign_id where d.tenant_id = ${q.tenantId} and d.brand_id = ${q.brandId}`;
      const daProposta = sql`from liame.autonomy_proposal a join liame.connected_account ca on ca.id = a.connected_account_id where a.tenant_id = ${q.tenantId} and a.brand_id = ${q.brandId}`;
      return [
        ramo(
          { at: sql`d.created_at`, kind: 'recomendou', subject: sql`c.name`, detail: sql`d.tool`, n: sql`(d.params->>'percent')::numeric` },
          sql`${daSombra} and d.created_at >= ${q.desde}::timestamptz`,
        ),
        ramo({ at: sql`d.evaluated_at`, kind: 'comparou', subject: sql`c.name`, detail: sql`d.regret_label` }, sql`${daSombra} and d.status = 'avaliada' and d.evaluated_at >= ${q.desde}::timestamptz`),
        // O modo Aprovação (A4, X3): o pedido que ele mesmo fez, e a tentativa que não virou pedido (o motivo vai em código;
        // o texto dele está na recomendação, que a Atenção e a lista da sombra mostram).
        ramo(
          { at: sql`r.created_at`, kind: 'pediu', subject: sql`c.name`, detail: sql`d.tool`, n: sql`(d.params->>'percent')::numeric` },
          sql`from liame.action_request r join liame.shadow_decision d on d.id = r.shadow_decision_id join liame.campaign c on c.id = d.campaign_id
              where r.tenant_id = ${q.tenantId} and r.brand_id = ${q.brandId} and r.agent_key = ${membro} and r.created_at >= ${q.desde}::timestamptz`,
        ),
        ramo(
          { at: sql`d.request_attempted_at`, kind: 'nao_pediu', subject: sql`c.name`, detail: sql`left(replace(d.request_error, '-', '_'), 60)` },
          sql`${daSombra} and d.request_error is not null and d.request_attempted_at >= ${q.desde}::timestamptz`,
        ),
        // O passo para a Aprovação (A4, X3) sai com os tipos dele: o texto de cada um diz outra coisa.
        ramo(
          { at: sql`a.created_at`, kind: sql`case a.to_mode when 'APPROVAL' then 'aprovacao_proposta' else 'promocao_proposta' end`, subject: sql`ca.name`, detail: sql`a.tool`, n: sql`a.sample_size` },
          sql`${daProposta} and a.created_at >= ${q.desde}::timestamptz`,
        ),
        ramo(
          {
            at: sql`a.decided_at`,
            // Aprovada (inclusive a que depois voltou para sombra) tem a versão da política; recusada foi uma pessoa; retirada, o sistema.
            kind: sql`(case a.to_mode when 'APPROVAL' then 'aprovacao' else 'promocao' end) ||
                      (case when a.policy_version is not null then '_aprovada' when a.status = 'recusada' then '_recusada' else '_retirada' end)`,
            subject: sql`ca.name`,
            detail: sql`a.tool`,
            by: sql`a.decided_by`,
          },
          sql`${daProposta} and a.decided_at >= ${q.desde}::timestamptz`,
        ),
        ramo(
          { at: sql`a.undone_at`, kind: sql`case a.to_mode when 'APPROVAL' then 'saiu_da_aprovacao' else 'voltou_para_sombra' end`, subject: sql`ca.name`, detail: sql`a.tool`, by: sql`a.undone_by` },
          sql`${daProposta} and a.undone_at >= ${q.desde}::timestamptz`,
        ),
        ...pausas(q, membro),
      ];
    }
  }
}

type Linha = {
  at: Date | string;
  kind: string;
  subject: string | null;
  detail: string | null;
  d1: string | null;
  d2: string | null;
  n: number | string | null;
  n2: number | string | null;
  by_id: string | null;
  by_name: string | null;
  rules: unknown;
  feedback: string | null;
};

const NOME_DE_REGRA = /^[a-z0-9_]{1,60}$/;

/**
 * Os acontecimentos do membro, do mais novo para o mais antigo, e se há mais do que `limite`. Só as linhas que vão
 * para a tela recebem o que custa procurar: o nome de quem pediu, o retorno da pessoa e o título da conversa.
 */
export async function atividadeDoMembro(tx: Tx, membro: Membro, q: QuemOlha, limite: number): Promise<{ items: TeamActivityItem[]; hasMore: boolean }> {
  const r = await tx.execute<Linha>(sql`
    with ev as (
      select * from (${sql.join(ramosDoMembro(membro, q), sql` union all `)}) t
       order by t.at desc, t.kind
       limit ${limite + 1}
    )
    select ev.at, ev.kind, ev.detail, ev.d1::text as d1, ev.d2::text as d2, ev.n, ev.n2, ev.by_id, ev.rules, u.name as by_name,
           coalesce(ev.subject, case when ev.kind = 'respondeu' then (
             select c.title from liame.conversation c join liame.conversation_message m on m.conversation_id = c.id
              where c.user_id = ${q.userId} and c.brand_id = ${q.brandId} and m.usage_id = ev.ref
              limit 1) end) as subject,
           case when ev.ref is not null then (
             select f.verdict from liame.ai_feedback f where f.usage_id = ev.ref order by f.updated_at desc limit 1) end as feedback
      from ev left join liame.app_user u on u.id = ev.by_id
     order by ev.at desc, ev.kind`);
  const linhas = r.rows;
  return {
    hasMore: linhas.length > limite,
    items: linhas.slice(0, limite).map((l) => ({
      at: new Date(l.at).toISOString(),
      kind: l.kind,
      subject: l.subject,
      detail: l.detail,
      period: l.d1 && l.d2 ? { from: l.d1, to: l.d2 } : null,
      count: l.n === null ? null : Number(l.n),
      barred: l.kind === 'escreveu_pecas' && l.n2 !== null ? Number(l.n2) : null,
      rules: Array.isArray(l.rules) ? l.rules.filter((x): x is string => typeof x === 'string' && NOME_DE_REGRA.test(x)) : [],
      by: l.by_id ? { id: l.by_id, name: l.by_name ?? 'Pessoa removida' } : null,
      mine: l.by_id === q.userId,
      feedback: l.feedback,
    })),
  };
}
