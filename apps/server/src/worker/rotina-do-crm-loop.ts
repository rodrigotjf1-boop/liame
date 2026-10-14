import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { MotivoDaMensagem } from '../ai/crm/mensagem.js';
import { DATABASE } from '../database/database.module.js';
import { MINUTOS_ENTRE_OLHADAS_DO_MODELO, proximaOlhada, type ResultadoDoOlhar } from '../mensageria/rotina-do-crm.js';
import { type Escrita, EscritaDoCrmService } from './escrita-do-crm.service.js';
import { type Acompanhamento, ModeloDoCrmService, type Rascunho } from './modelo-do-crm.service.js';
import { naOrdemDaFila, vezNaFila } from './ordem-da-fila.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';
import { type Olhada, RotinaDoCrmService } from './rotina-do-crm.service.js';

/** A linha reservada volta para a fila depois disto se o worker cair no meio da olhada. */
const RESERVA = '15 minutes';
/** A proposta reservada para a escrita volta para a fila depois disto se o worker cair no meio. */
const RESERVA_DA_ESCRITA = '10 minutes';

export type VezDoOlhar = { id: string; tenantId: string; brandId: string; motivo: MotivoDaMensagem; resultado: ResultadoDoOlhar; proposta?: string };
export type VezDaEscrita = { id: string; tenantId: string; feito: Escrita };
export type VezDoRascunho = { id: string; tenantId: string; feito: Rascunho };
export type VezDoAcompanhamento = { id: string; tenantId: string; visto: Acompanhamento };

type Reservada = { id: string; tenant_id: string; brand_id: string; motive: MotivoDaMensagem; vez: string };
/** A proposta reservada, com a vez dela na fila: o lote é tratado nessa ordem (ERR-135). */
type PropostaReservada = { id: string; tenant_id: string; vez: string };

/**
 * A fila do olhar da rotina do CRM e mensageria (A5, Y6; migration 0064). Cada marca com o RegemCast conectado tem
 * uma linha por tipo de mensagem; o laço reserva as devidas (SKIP LOCKED na mesma linha que a reserva altera, V35),
 * pede ao serviço que olhe cada uma e grava o que ele decidiu e quando olha de novo. A olhada sempre deixa registro:
 * a marca que não tem o que propor sai da frente da fila até a próxima vez, e não tira a vez das outras (V106).
 * A proposta aberta entra na segunda fila, a da escrita (`escreverLote`); com o texto conferido, na do rascunho do
 * modelo (`rascunharLote`); e, com o rascunho no RegemCast, na da espera pela Meta (`acompanharLote`).
 */
@Injectable()
export class RotinaDoCrmLoop {
  private readonly logger = new Logger('rotina-do-crm');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly rotina: RotinaDoCrmService,
    private readonly escrita: EscritaDoCrmService,
    private readonly modelo: ModeloDoCrmService,
  ) {}

  /**
   * A fila do rascunho: as propostas em `preparando` que já têm o texto conferido. Reserva como a da escrita, e pede
   * ao serviço que grave o rascunho do modelo no RegemCast.
   */
  async rascunharLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDoRascunho[]> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<PropostaReservada>(sql`
          with devidas as materialized (
            select p.id, ${vezNaFila(sql`coalesce(p.next_attempt_at, p.created_at)`)} as vez
              from liame.message_proposal p
             where p.status = 'preparando' and p.body is not null
               and (p.next_attempt_at is null or p.next_attempt_at <= ${ref})
               ${tenantFilter(scope, sql`p.tenant_id`)}
             order by coalesce(p.next_attempt_at, p.created_at), p.id
             limit ${limite}
             for update of p skip locked
          )
          update liame.message_proposal p
             set next_attempt_at = ${ref} + ${RESERVA_DA_ESCRITA}::interval, updated_at = now()
            from devidas x
           where p.id = x.id
          returning p.id, p.tenant_id, x.vez`)
      ).rows,
    );

    const vezes: VezDoRascunho[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      const alvo = { tenantId: l.tenant_id, id: l.id };
      let feito: Rascunho;
      try {
        feito = await this.modelo.rascunhar(alvo, quando);
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e a proposta volta (LIC-001).
        this.logger.error(`proposta ${l.id} (rascunho): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        try {
          feito = await this.modelo.falhou(alvo, 'erro', quando);
        } catch (err2) {
          this.logger.error(`proposta ${l.id}: não foi possível registrar a falha do rascunho: ${err2 instanceof Error ? err2.message : String(err2)}`);
          feito = { status: 'falhou', motivo: 'erro', deVez: false };
        }
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, feito });
    }
    return vezes;
  }

  /**
   * A fila da espera pela Meta: as propostas em `rascunho` que ninguém olhou no último intervalo. A reserva marca a
   * hora da olhada (é a mesma coluna que diz quando olhar de novo), e o serviço lê o modelo no RegemCast. A falha
   * fora do previsto só fica no log: a proposta volta no próximo intervalo, e o prazo do modelo segue contando.
   */
  async acompanharLote(limite = 10, scope: JobScope = {}, agora?: Date): Promise<VezDoAcompanhamento[]> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<PropostaReservada>(sql`
          with devidas as materialized (
            select p.id, ${vezNaFila(sql`coalesce(p.template_checked_at, p.drafted_at, p.created_at)`)} as vez
              from liame.message_proposal p
             where p.status = 'rascunho'
               and coalesce(p.template_checked_at, p.drafted_at, p.created_at) <= ${ref} - make_interval(mins => ${MINUTOS_ENTRE_OLHADAS_DO_MODELO})
               ${tenantFilter(scope, sql`p.tenant_id`)}
             order by coalesce(p.template_checked_at, p.drafted_at, p.created_at), p.id
             limit ${limite}
             for update of p skip locked
          )
          update liame.message_proposal p
             set template_checked_at = ${ref}, updated_at = now()
            from devidas x
           where p.id = x.id
          returning p.id, p.tenant_id, x.vez`)
      ).rows,
    );

    const vezes: VezDoAcompanhamento[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      let visto: Acompanhamento;
      try {
        visto = await this.modelo.acompanhar({ tenantId: l.tenant_id, id: l.id }, quando);
      } catch (err) {
        this.logger.error(`proposta ${l.id} (modelo): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        visto = { status: 'sem_leitura', motivo: 'erro' };
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, visto });
    }
    return vezes;
  }

  /**
   * A fila da escrita: as propostas em `preparando` que ainda não têm texto (migration 0062). Reserva com SKIP LOCKED,
   * empurrando `next_attempt_at` (se o worker cair no meio, a proposta volta sozinha), e pede ao serviço que escreva
   * cada uma. Toda vez deixa rastro na proposta: o texto guardado, o fim dela, a tentativa contada ou a espera.
   */
  async escreverLote(limite = 3, scope: JobScope = {}, agora?: Date): Promise<VezDaEscrita[]> {
    if (!this.database) return [];
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<PropostaReservada>(sql`
          with devidas as materialized (
            select p.id, ${vezNaFila(sql`coalesce(p.next_attempt_at, p.created_at)`)} as vez
              from liame.message_proposal p
             where p.status = 'preparando' and p.body is null
               and (p.next_attempt_at is null or p.next_attempt_at <= ${ref})
               ${tenantFilter(scope, sql`p.tenant_id`)}
             order by coalesce(p.next_attempt_at, p.created_at), p.id
             limit ${limite}
             for update of p skip locked
          )
          update liame.message_proposal p
             set next_attempt_at = ${ref} + ${RESERVA_DA_ESCRITA}::interval, updated_at = now()
            from devidas x
           where p.id = x.id
          returning p.id, p.tenant_id, x.vez`)
      ).rows,
    );

    const vezes: VezDaEscrita[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      const alvo = { tenantId: l.tenant_id, id: l.id };
      let feito: Escrita;
      try {
        feito = await this.escrita.escrever(alvo, quando);
      } catch (err) {
        // Falha fora do previsto: conta como tentativa; se nem isso gravar, a reserva vence e a proposta volta (LIC-001).
        this.logger.error(`proposta ${l.id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        try {
          feito = await this.escrita.falhou(alvo, 'erro', quando);
        } catch (err2) {
          this.logger.error(`proposta ${l.id}: não foi possível registrar a falha: ${err2 instanceof Error ? err2.message : String(err2)}`);
          feito = { status: 'falhou', motivo: 'erro', deVez: false };
        }
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, feito });
    }
    return vezes;
  }

  async olharLote(limite = 5, scope: JobScope = {}, agora?: Date): Promise<VezDoOlhar[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const quando = agora ?? new Date();
    const ref = sql`${quando.toISOString()}::timestamptz`;
    const reservadas = await withSystem(db, async (tx) => {
      // As marcas com o RegemCast conectado ganham as duas linhas, uma vez só: é por elas que a fila anda.
      await tx.execute(sql`
        insert into liame.message_routine (id, tenant_id, brand_id, motive, next_check_at)
        select gen_random_uuid(), c.tenant_id, c.brand_id, m.motive, ${ref}
          from (select distinct a.tenant_id, a.brand_id
                  from liame.connected_account a
                 where a.provider = 'regemcast' and a.disconnected_at is null and a.brand_id is not null
                   ${tenantFilter(scope, sql`a.tenant_id`)}) c
         cross join (values ('promocao'), ('volte_a_pedir')) as m (motive)
        on conflict (brand_id, motive) do nothing`);
      return (
        await tx.execute<Reservada>(sql`
          with devidas as materialized (
            select r.id, ${vezNaFila(sql`r.next_check_at`)} as vez
              from liame.message_routine r
             where r.next_check_at <= ${ref}
               ${tenantFilter(scope, sql`r.tenant_id`)}
             order by r.next_check_at, r.id
             limit ${limite}
             for update of r skip locked
          )
          update liame.message_routine r
             set next_check_at = ${ref} + ${RESERVA}::interval, updated_at = now()
            from devidas x
           where r.id = x.id
          returning r.id, r.tenant_id, r.brand_id, r.motive, x.vez`)
      ).rows;
    });

    const vezes: VezDoOlhar[] = [];
    for (const l of naOrdemDaFila(reservadas)) {
      let olhada: Olhada;
      try {
        olhada = await this.rotina.olhar({ tenantId: l.tenant_id, brandId: l.brand_id, motivo: l.motive }, quando);
      } catch (err) {
        // Falha fora do previsto: a causa fica no log e a olhada fica marcada, para ele tentar de novo em 1 hora.
        this.logger.error(`marca ${l.brand_id} (${l.motive}): ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        olhada = { resultado: 'erro' };
      }
      try {
        const volta = proximaOlhada(olhada.resultado, quando, olhada.ate);
        await withSystem(db, (tx) =>
          tx.execute(sql`
            update liame.message_routine
               set checked_at = ${ref}, outcome = ${olhada.resultado}, next_check_at = ${volta.toISOString()}::timestamptz, updated_at = now()
             where id = ${l.id} and tenant_id = ${l.tenant_id}`),
        );
      } catch (err) {
        // Se nem isso gravar, a reserva vence e a linha volta sozinha (LIC-001).
        this.logger.error(`marca ${l.brand_id} (${l.motive}): não foi possível registrar a olhada: ${err instanceof Error ? err.message : String(err)}`);
      }
      vezes.push({ id: l.id, tenantId: l.tenant_id, brandId: l.brand_id, motivo: l.motive, resultado: olhada.resultado, ...(olhada.proposta ? { proposta: olhada.proposta } : {}) });
    }
    return vezes;
  }
}
