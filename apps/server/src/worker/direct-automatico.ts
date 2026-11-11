import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { recursoDaConversa } from '../actions/direct-plano.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { SOCIAL } from '../ai/social/prompt.js';
import { PROVEDOR_INSTAGRAM } from '../connectors/meta/publicacao.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { FERRAMENTA_DO_DIRECT_AUTOMATICO, oQueSeguraODirectAutomatico, RESPOSTAS_AUTOMATICAS_DO_DIRECT_POR_HORA } from '../direct/automatico.js';
import { JANELA_DO_DIRECT_HORAS } from '../direct/direct.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** As situações do pedido automático que contam no teto da hora (as mesmas do portão). */
const NO_TETO = ['aprovada', 'executando', 'executada'] as const;

type Candidata = { tenant_id: string; brand_id: string; connected_account_id: string; conversation_id: string; ultima: string };

/** O que a rotina fez com a conversa: respondeu sozinha (o pedido), deixou com uma pessoa (o porquê) ou nada. */
export type VezDoDirectAutomatico = { conversa: string } & ({ status: 'respondida'; pedido: string } | { status: 'com_a_pessoa'; motivo: string } | { status: 'fora' });

/**
 * O atendimento automático do Direct (A6, Z12, parte 5a; P39 versão 2; D-A6-115 e D-A6-119). Olha as conversas que
 * esperam resposta nas marcas com o automático ligado, cuja última mensagem da pessoa ainda não foi decidida
 * (`auto_checked_message`), dentro da janela da Meta e com a marca abaixo do teto da hora (a condição do teto fica na
 * consulta, para a marca no teto não travar a fila das outras: V84). Cada conversa é decidida na transação da empresa,
 * presa com SKIP LOCKED (dois workers não decidem a mesma) e marcada como decidida: ou o Social media pede a resposta
 * automática pelo trilho (o portão de novo no Action Service e no executor), ou ela fica com uma pessoa, com o porquê.
 * A mensagem seguinte da pessoa é decidida de novo.
 */
@Injectable()
export class DirectAutomaticoLoop {
  private readonly logger = new Logger('direct-automatico');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly acoes: ActionService,
  ) {}

  async executarLote(limite = 10, scope: JobScope = {}, agora: Date = new Date()): Promise<VezDoDirectAutomatico[]> {
    if (!this.database) return [];
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const candidatas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Candidata>(sql`
          select c.tenant_id, c.brand_id, c.connected_account_id, c.conversation_id, p.message_id as ultima
            from liame.direct_conversation c
            join liame.direct_auto_reply r on r.brand_id = c.brand_id and r.enabled
            join lateral (
              select m.message_id from liame.direct_message m
               where m.connected_account_id = c.connected_account_id and m.conversation_id = c.conversation_id and m.direction = 'entrada'
               order by m.sent_at desc, m.message_id desc limit 1) p on true
           where c.last_direction = 'entrada'
             and c.channel = 'instagram'
             and c.last_inbound_at > ${ref} - make_interval(hours => ${JANELA_DO_DIRECT_HORAS})
             and (c.concluded_at is null or c.concluded_at < c.last_inbound_at)
             and c.auto_checked_message is distinct from p.message_id
             and (select count(*) from liame.action_request q
                   where q.tenant_id = c.tenant_id and q.created_at > ${ref} - interval '1 hour'
                     and q.brand_id = c.brand_id and q.tool = ${FERRAMENTA_DO_DIRECT_AUTOMATICO} and q.status in ${[...NO_TETO]}) < ${RESPOSTAS_AUTOMATICAS_DO_DIRECT_POR_HORA}
             ${tenantFilter(scope, sql`c.tenant_id`)}
           order by c.last_inbound_at, c.conversation_id
           limit ${limite}`)
      ).rows,
    );
    const vezes: VezDoDirectAutomatico[] = [];
    for (const c of candidatas) {
      try {
        vezes.push(await this.decidir(c, agora));
      } catch (err) {
        // Falha fora do previsto: a conversa não foi marcada e volta na próxima volta (a resposta que saiu não sai duas
        // vezes: o conector confere pelo texto).
        this.logger.error(`conversa ${c.conversation_id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
    return vezes;
  }

  private async decidir(c: Candidata, agora: Date): Promise<VezDoDirectAutomatico> {
    const conversa = c.conversation_id;
    try {
      return await naTransacaoDaEmpresa(this.banco(), { tenantId: c.tenant_id, userId: null }, async (): Promise<VezDoDirectAutomatico> => {
        const tx = currentTx();
        const presa = (
          await tx.execute<{ auto_checked_message: string | null }>(sql`
            select auto_checked_message from liame.direct_conversation
             where connected_account_id = ${c.connected_account_id}::uuid and conversation_id = ${conversa}
             for update skip locked`)
        ).rows[0];
        if (!presa || presa.auto_checked_message === c.ultima) return { conversa, status: 'fora' };
        await this.marcar(c);
        const portao = await oQueSeguraODirectAutomatico(tx, this.flags, { tenantId: c.tenant_id, brandId: c.brand_id, connectedAccountId: c.connected_account_id, conversationId: conversa }, agora);
        if ('segura' in portao) return { conversa, status: 'com_a_pessoa', motivo: portao.segura };
        // Quem responde pelo que o funcionário manda é o dono da empresa (um por empresa).
        const dono = (
          await tx.execute<{ user_id: string }>(sql`
            select user_id from liame.membership where tenant_id = ${c.tenant_id} and role_key = 'dono' and revoked_at is null`)
        ).rows[0];
        if (!dono) return { conversa, status: 'com_a_pessoa', motivo: 'sem_dono' };
        const pedido = await this.acoes.responderSozinhoNoDirect(
          { tenantId: c.tenant_id, agentKey: SOCIAL.key, agentLabel: SOCIAL.name, emNomeDe: dono.user_id },
          {
            tool: FERRAMENTA_DO_DIRECT_AUTOMATICO,
            brand_id: c.brand_id,
            provider: PROVEDOR_INSTAGRAM,
            account_id: c.connected_account_id,
            resource_id: recursoDaConversa(conversa),
            params: { texto: portao.resposta.texto },
          },
          agora,
        );
        return { conversa, status: 'respondida', pedido };
      });
    } catch (err) {
      // O pedido foi recusado (o portão fechou entre a escolha e o pedido, a política pede outra coisa, o plano recusou):
      // a transação de cima desfez a marca; a conversa fica com uma pessoa, marcada numa transação nova.
      if (err instanceof AppProblem && err.getStatus() < 500) {
        await naTransacaoDaEmpresa(this.banco(), { tenantId: c.tenant_id, userId: null }, () => this.marcar(c));
        return { conversa, status: 'com_a_pessoa', motivo: err.code };
      }
      throw err;
    }
  }

  /** A última mensagem da pessoa foi decidida pelo automático: a mesma não volta à fila; a seguinte, sim. */
  private async marcar(c: Candidata): Promise<void> {
    await currentTx().execute(sql`
      update liame.direct_conversation set auto_checked_message = ${c.ultima}
       where connected_account_id = ${c.connected_account_id}::uuid and conversation_id = ${c.conversation_id}`);
  }

  private banco(): Database {
    if (!this.database) throw new Error('atendimento automático do Direct: sem banco');
    return this.database;
  }
}
