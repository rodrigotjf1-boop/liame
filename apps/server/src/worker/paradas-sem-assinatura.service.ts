import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { type AcertoDaParada, acertarParadaSemAssinatura, TEM_ASSINATURA_PAGA } from '../cobranca/parada-sem-assinatura.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

type Marca = { tenant_id: string; brand_id: string; paga: boolean; arquivada: boolean; parada: boolean };

export type ParadaDaRotina = { tenantId: string; brandId: string; resultado: AcertoDaParada };

/**
 * A rotina da equipe parada sem assinatura paga (A7, W3, parte 4c; D-A7-108). O fim da assinatura e o primeiro pagamento
 * já acertam a parada na hora (`cobranca/assinatura.ts`); esta rotina cuida do resto: a marca que nunca assinou (ou que
 * espera o primeiro pagamento) numa empresa com a cobrança ligada para, e a parada da marca que ficou paga, foi arquivada
 * ou teve a cobrança desligada sai. Passa pelas marcas candidatas em páginas (V106) e só grava quando algo muda. O relógio
 * vem de quem chama (V34).
 */
@Injectable()
export class ParadasSemAssinaturaService {
  private readonly logger = new Logger('paradas-sem-assinatura');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
  ) {}

  async executarLote(porPagina = 200, scope: JobScope = {}, agora = new Date()): Promise<ParadaDaRotina[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const feitos: ParadaDaRotina[] = [];
    let depoisDe: string | null = null;
    for (;;) {
      const cursor: string | null = depoisDe;
      const pagina: Marca[] = await withSystem(db, async (tx): Promise<Marca[]> =>
        (
          await tx.execute<Marca>(sql`
            select b.tenant_id, b.id as brand_id, ${TEM_ASSINATURA_PAGA(sql`b.id`)} as paga, b.archived_at is not null as arquivada,
                   exists (select 1 from liame.kill_switch k where k.brand_id = b.id and k.no_paid_subscription and k.deactivated_at is null) as parada
              from liame.brand b
              join liame.organization o on o.id = b.tenant_id
             where o.status = 'ativa' ${tenantFilter(scope, sql`b.tenant_id`)}
               and ((b.archived_at is null and not ${TEM_ASSINATURA_PAGA(sql`b.id`)})
                    or exists (select 1 from liame.kill_switch k where k.brand_id = b.id and k.no_paid_subscription and k.deactivated_at is null))
               ${cursor ? sql`and b.id > ${cursor}::uuid` : sql``}
             order by b.id
             limit ${porPagina}`)
        ).rows,
      );
      for (const m of pagina) {
        try {
          const ligada = await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: m.tenant_id, brandId: m.brand_id }));
          const deveParar = ligada && !m.paga && !m.arquivada;
          // Só grava quando muda: parar a que não está parada, soltar a que está e não deve.
          if (deveParar === m.parada) continue;
          const resultado = await withSystem(db, (tx) => acertarParadaSemAssinatura(tx, { tenantId: m.tenant_id, brandId: m.brand_id }, ligada, agora));
          if (resultado !== 'nada') {
            this.logger.log(`marca ${m.brand_id}: ${resultado === 'parou' ? 'a equipe parou (sem assinatura paga)' : 'a equipe voltou'}`);
            feitos.push({ tenantId: m.tenant_id, brandId: m.brand_id, resultado });
          }
        } catch (err) {
          // Uma marca que falha não segura as outras; a próxima volta tenta de novo.
          this.logger.error(`parada sem assinatura da marca ${m.brand_id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      if (pagina.length < porPagina) return feitos;
      depoisDe = pagina[pagina.length - 1]!.brand_id;
    }
  }
}
