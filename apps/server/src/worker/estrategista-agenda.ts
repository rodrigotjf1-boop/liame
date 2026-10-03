import type { PlanKind } from '@liame/contracts';
import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { mesesDoPlano } from '../ai/estrategista/contexto.js';
import { ESTRATEGISTA } from '../ai/estrategista/prompt.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { dia } from '../ai/registro/formatos.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { menosDias } from '../results/fora-do-normal.js';
import { HORA_LIMITE } from '../results/revisao-semanal.js';
import { TENTATIVAS } from './estrategista-loop.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// Os planos agendados do Estrategista (A3, I11b; protótipo P8, aguardando aprovação). Na segunda-feira, a partir da hora
// em que a revisão da semana já saiu (no fuso da loja), a rotina pede ao Estrategista a pauta da semana e, a cada 12
// semanas, o plano de 90 dias. O pedido é uma demanda aberta pela rotina, sem pessoa (`requested_by` nulo), e segue a
// fila de qualquer demanda (`estrategista-loop.ts`). Só para a marca com conta de anúncio, a flag `ia` ligada e o
// Estrategista ativo: com a IA desligada não se acumulam pedidos que venceriam antes de alguém ligá-la.

/** Um plano de 90 dias a cada 12 semanas: a rotina só pede outro 84 dias depois do último (pedido por quem for). */
export const DIAS_ENTRE_PLANOS_DE_90 = 84;
/** A pauta da rotina não sai se já houver uma pauta destes últimos dias (pedida na conversa, por exemplo). */
const DIAS_SEM_OUTRA_PAUTA = 3;
/** Teto de marcas por volta (a rotina passa por todas as devidas; o resto fica para a volta seguinte, em 10 minutos). */
export const MARCAS_POR_VOLTA = 5_000;

export type PedidoDaAgenda = { brandId: string; tenantId: string; kind: PlanKind; demandId: string };

type Devida = { brand_id: string; tenant_id: string; hoje: string; falta_pauta: boolean; falta_noventa: boolean };

/** O pedido da rotina, como a demanda guarda: título, o pedido e a chave da segunda-feira. */
export function pedidoDaRotina(kind: 'pauta' | 'noventa_dias', hoje: string): { tipo: 'pauta' | 'plano'; titulo: string; pedido: string; chave: string } {
  if (kind === 'pauta') {
    const domingo = menosDias(hoje, -6);
    return {
      tipo: 'pauta',
      titulo: `Pauta da semana de ${dia(hoje)!.slice(0, 5)} a ${dia(domingo)!.slice(0, 5)}`,
      pedido: `Monte a pauta desta semana, de ${dia(hoje)} a ${dia(domingo)}: um item por dia, a partir dos resultados da semana passada.`,
      chave: `pauta:${hoje}`,
    };
  }
  const meses = mesesDoPlano(hoje).map((m) => m.nome.toLowerCase());
  return {
    tipo: 'plano',
    titulo: `Plano de 90 dias: ${meses[0]} a ${meses[2]}`,
    pedido: `Monte o plano dos próximos 90 dias (${meses[0]}, ${meses[1]} e ${meses[2]}), com a verba por canal e as datas do calendário comercial.`,
    chave: `noventa_dias:${hoje}`,
  };
}

/**
 * A rotina de segunda-feira: acha as marcas em que já é segunda depois da hora (no fuso de cada uma) e que ainda não
 * têm o pedido desta segunda, e abre a demanda de cada plano que falta. O índice único da chave da rotina decide quando
 * duas voltas (ou dois workers) chegam juntas. Devolve os pedidos abertos nesta volta.
 */
@Injectable()
export class EstrategistaAgenda {
  private readonly logger = new Logger('estrategista');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
  ) {}

  async agendarLote(scope: JobScope = {}, agora?: Date): Promise<PedidoDaAgenda[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const ref = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const devidas = await withSystem(db, async (tx) =>
      (
        await tx.execute<Devida>(sql`
          with marcas as (
            select b.id as brand_id, b.tenant_id,
                   (${ref} at time zone coalesce((select u.timezone from liame.unit u where u.brand_id = b.id order by u.created_at, u.id limit 1), 'America/Sao_Paulo')) as local
              from liame.brand b
             where b.archived_at is null ${tenantFilter(scope, sql`b.tenant_id`)}
               and exists (select 1 from liame.connected_account a
                            where a.brand_id = b.id and a.provider in ('meta_ads', 'google_ads') and a.disconnected_at is null)
          ), segunda as (
            select m.brand_id, m.tenant_id, m.local::date::text as hoje
              from marcas m
             where extract(isodow from m.local) = 1 and extract(hour from m.local) >= ${HORA_LIMITE}
          ), devidas as (
            select s.*,
                   (not exists (select 1 from liame.demand d where d.brand_id = s.brand_id and d.routine_key = 'pauta:' || s.hoje)
                    and not exists (select 1 from liame.demand d where d.brand_id = s.brand_id and d.kind = 'pauta'
                                      and d.status in ('aberta', 'em_andamento') and d.attempts < ${TENTATIVAS})
                    and not exists (select 1 from liame.plan p where p.brand_id = s.brand_id and p.kind = 'pauta'
                                      and p.created_at > ${ref} - make_interval(days => ${DIAS_SEM_OUTRA_PAUTA}))) as falta_pauta,
                   (not exists (select 1 from liame.demand d where d.brand_id = s.brand_id and d.routine_key = 'noventa_dias:' || s.hoje)
                    and not exists (select 1 from liame.demand d where d.brand_id = s.brand_id and d.kind = 'plano'
                                      and d.status in ('aberta', 'em_andamento') and d.attempts < ${TENTATIVAS})
                    and not exists (select 1 from liame.plan p where p.brand_id = s.brand_id and p.kind = 'noventa_dias'
                                      and p.created_at > ${ref} - make_interval(days => ${DIAS_ENTRE_PLANOS_DE_90}))) as falta_noventa
              from segunda s
          )
          select brand_id, tenant_id, hoje, falta_pauta, falta_noventa
            from devidas
           where falta_pauta or falta_noventa
           order by brand_id
           limit ${MARCAS_POR_VOLTA}`)
      ).rows,
    );

    const abertos: PedidoDaAgenda[] = [];
    for (const m of devidas) {
      try {
        // Sem a IA ligada, nada se pede: o pedido venceria antes de alguém ligá-la.
        if (!(await this.flags.isEnabled('ia', this.flags.context({ tenantId: m.tenant_id, brandId: m.brand_id })))) continue;
        const tipos = [...(m.falta_pauta ? (['pauta'] as const) : []), ...(m.falta_noventa ? (['noventa_dias'] as const) : [])];
        abertos.push(...(await withSystem(db, (tx) => this.abrir(tx, m, tipos))));
      } catch (err) {
        // Uma marca com problema não segura as outras; a volta seguinte tenta de novo (LIC-001).
        this.logger.error(`agenda da marca ${m.brand_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (abertos.length) this.logger.log(`agenda: ${abertos.length} pedido(s) da rotina de segunda-feira para o Estrategista`);
    return abertos;
  }

  /** Abre as demandas da rotina numa marca, com a auditoria, se o Estrategista está ativo nela. */
  private async abrir(tx: Tx, m: Devida, tipos: Array<'pauta' | 'noventa_dias'>): Promise<PedidoDaAgenda[]> {
    if (!(await funcionarioAtivo(tx, { tenantId: m.tenant_id, brandId: m.brand_id, agentKey: ESTRATEGISTA.key, ativoPorPadrao: ESTRATEGISTA.ativoPorPadrao }))) return [];
    const abertos: PedidoDaAgenda[] = [];
    for (const kind of tipos) {
      const p = pedidoDaRotina(kind, m.hoje);
      const id = uuidv7();
      const r = await tx.execute<{ id: string }>(sql`
        insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, assignee_agent, opened_by_agent, routine_key)
        values (${id}, ${m.tenant_id}, ${m.brand_id}, ${p.tipo}, ${p.titulo}, ${p.pedido}, ${ESTRATEGISTA.key}, ${ESTRATEGISTA.key}, ${p.chave})
        on conflict (brand_id, routine_key) where routine_key is not null do nothing
        returning id`);
      if (!r.rows.length) continue;
      await writeAudit(tx, {
        tenantId: m.tenant_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Rotina de segunda-feira do Estrategista',
        action: 'demanda.abrir',
        resourceType: 'demand',
        resourceId: id,
        after: { kind: p.tipo, assignee: ESTRATEGISTA.key, routine_key: p.chave },
        traceId: activeTraceId(),
        origin: 'worker',
        agent: ESTRATEGISTA.key,
      });
      abertos.push({ brandId: m.brand_id, tenantId: m.tenant_id, kind: kind === 'pauta' ? 'pauta' : 'noventa_dias', demandId: id });
    }
    return abertos;
  }
}
