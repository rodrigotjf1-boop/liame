import type { DemandResponse } from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { actorLabel } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import type { AbrirDemandaInput } from '../ai/conversa/demanda.defs.js';
import { QUEM_CUIDA } from '../ai/conversa/demanda.defs.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { limparTexto } from '../ai/sanitizar.js';

// Demandas (A3, I10): o pedido que a LIA registra para a equipe (o Estrategista monta promoção, plano e pauta,
// I11). É trabalho da empresa: fica depois que a conversa some (30 dias). O texto entra sem dado pessoal. Uma
// demanda por mensagem da pessoa, mesmo que o modelo peça duas vezes (índice único, V24).

type LinhaDemanda = {
  id: string;
  brand_id: string;
  kind: string;
  title: string;
  detail: string;
  notes: string | null;
  assignee_agent: string;
  due_on: string | null;
  status: string;
  requested_by: string | null;
  requester: string | null;
  opened_by_agent: string | null;
  conversation_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  cancelled_at: Date | string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const COLUNAS = sql`d.id, d.brand_id, d.kind, d.title, d.detail, d.notes, d.assignee_agent, d.due_on::text as due_on, d.status, d.requested_by,
                    u.name as requester, d.opened_by_agent, d.conversation_id, d.created_at, d.updated_at, d.cancelled_at`;

export function respostaDaDemanda(d: LinhaDemanda): DemandResponse {
  return {
    id: d.id,
    brand_id: d.brand_id,
    kind: d.kind,
    title: d.title,
    detail: d.detail,
    notes: d.notes,
    assignee: { agent: d.assignee_agent, name: QUEM_CUIDA[d.assignee_agent] ?? d.assignee_agent },
    due_on: d.due_on,
    status: d.status,
    requested_by: d.requested_by ? { id: d.requested_by, name: d.requester ?? 'Pessoa removida' } : null,
    opened_by_agent: d.opened_by_agent,
    conversation_id: d.conversation_id,
    created_at: iso(d.created_at),
    updated_at: iso(d.updated_at),
    cancelled_at: d.cancelled_at ? iso(d.cancelled_at) : null,
  };
}

/** Quem pediu, como a auditoria e a demanda precisam. */
export type QuemPede = Pick<AuthContext, 'userId' | 'name' | 'roleKey'> & { tenantId: string };

@Injectable()
export class DemandasService {
  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /**
   * A LIA registra a demanda em nome da pessoa, numa transação curta da empresa (a conversa não segura
   * transação). A auditoria diz que foi o agente, a pedido de quem. A mesma mensagem repetida devolve a
   * demanda que já existe.
   */
  async abrirPelaLia(quem: QuemPede, origem: { brandId: string; conversationId: string; messageId: string }, input: AbrirDemandaInput): Promise<{ demanda: DemandResponse; nova: boolean }> {
    if (!this.database) throw new Error('demandas: sem banco');
    const limpo = (t: string | undefined) => (t === undefined ? null : limparTexto(t).texto.trim() || null);
    const titulo = limpo(input.titulo) ?? input.titulo;
    const pedido = limpo(input.pedido) ?? input.pedido;
    return naTransacaoDaEmpresa(this.database, quem, async () => {
      const tx = currentTx();
      const id = uuidv7();
      const r = await tx.execute<{ id: string }>(sql`
        insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, notes, assignee_agent, due_on, requested_by, opened_by_agent, conversation_id, origin_message_id)
        values (${id}, ${quem.tenantId}, ${origem.brandId}, ${input.tipo}, ${titulo}, ${pedido}, ${limpo(input.anotacoes)}, 'estrategista',
                ${input.para_quando ?? null}, ${quem.userId}, 'lia', ${origem.conversationId}, ${origem.messageId})
        on conflict (origin_message_id) where origin_message_id is not null do nothing
        returning id`);
      if (!r.rows.length) {
        const ja = await tx.execute<LinhaDemanda>(sql`select ${COLUNAS} from liame.demand d left join liame.app_user u on u.id = d.requested_by where d.origin_message_id = ${origem.messageId}`);
        return { demanda: respostaDaDemanda(ja.rows[0]!), nova: false };
      }
      await writeAudit(tx, {
        tenantId: quem.tenantId,
        actorType: 'agent',
        actorId: null,
        actorLabel: `LIA, a pedido de ${actorLabel(quem)}`,
        action: 'demanda.abrir',
        resourceType: 'demand',
        resourceId: id,
        after: { kind: input.tipo, assignee: 'estrategista', requested_by: quem.userId, conversation_id: origem.conversationId },
        traceId: activeTraceId(),
        origin: 'api',
        agent: 'lia',
      });
      return { demanda: await this.porId(id), nova: true };
    });
  }

  /** Cancela a demanda aberta (na transação da rota; a auditoria é a da rota). Já em andamento ou encerrada: 409. */
  async cancelar(auth: AuthContext, id: string): Promise<DemandResponse> {
    const tx = currentTx();
    const atual = await tx.execute<{ status: string }>(sql`select status from liame.demand where id = ${id} for update`);
    const status = atual.rows[0]?.status;
    if (!status) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta demanda não existe nesta empresa.');
    if (status !== 'aberta') {
      throw new AppProblem(409, 'demanda-nao-aberta', 'A demanda não está mais aberta', 'Só a demanda aberta pode ser cancelada; esta já está em andamento ou encerrada.');
    }
    await tx.execute(sql`
      update liame.demand set status = 'cancelada', cancelled_by = ${auth.userId}, cancelled_at = now(), updated_at = now() where id = ${id}`);
    auditDetail({ resourceId: id, before: { status }, after: { status: 'cancelada' } });
    return this.porId(id);
  }

  private async porId(id: string): Promise<DemandResponse> {
    const r = await currentTx().execute<LinhaDemanda>(sql`select ${COLUNAS} from liame.demand d left join liame.app_user u on u.id = d.requested_by where d.id = ${id}`);
    return respostaDaDemanda(r.rows[0]!);
  }
}
