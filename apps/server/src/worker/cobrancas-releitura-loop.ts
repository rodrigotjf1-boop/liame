import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { relerCobranca, type ResultadoDaReleitura } from '../cobranca/cobranca-pix.js';
import { MeioAsaas } from '../cobranca/meio-asaas.js';
import { PROVIDER_ASAAS } from '../connectors/asaas/api-asaas.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** A empresa com a função `cobranca` desligada: a fatura volta à fila depois disto (V106: a recusa grava a espera). */
const ESPERA_DESLIGADA = '1 hour';

export type VezDaReleitura = { fatura: string; tenantId: string; resultado: ResultadoDaReleitura['situacao'] | 'desligada' | 'falhou' };

/**
 * A releitura das cobranças no Asaas (A7, W2a, parte 2; D-A7-28 a D-A7-30): toda fatura com a cobrança no Asaas e a
 * próxima vez vencida é relida pelo mesmo caminho (`relerCobranca`), que paga, refaz, remove ou espera. A próxima vez é
 * a de agora quando chega um aviso (o processador `avisoDoAsaas`), quando o Liame cancela a fatura ou muda o valor dela;
 * senão, o dia seguinte: a conferência diária que cobre o aviso perdido. Sem o Asaas configurado, a rotina não faz nada.
 */
@Injectable()
export class CobrancasReleituraLoop {
  private readonly logger = new Logger('cobrancas-releitura');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly meio: MeioAsaas,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 10, scope: JobScope = {}, agora?: Date): Promise<VezDaReleitura[]> {
    const api = this.meio.api();
    if (!this.database || !api) return [];
    const db = this.database.db;
    const relogio = agora ?? new Date();
    const referencia = sql`${relogio.toISOString()}::timestamptz`;
    const devidas = await withSystem(db, (tx) =>
      tx.execute<{ id: string; tenant_id: string; brand_id: string }>(sql`
        select i.id, i.tenant_id, i.brand_id
          from liame.billing_invoice i
         where i.provider = ${PROVIDER_ASAAS} and i.external_id is not null and i.charge_next_at is not null
           and i.charge_next_at <= ${referencia}
           and (i.charge_locked_until is null or i.charge_locked_until <= ${referencia})
           ${tenantFilter(scope, sql`i.tenant_id`)}
         order by i.charge_next_at, i.id
         limit ${limite}`),
    );

    const vezes: VezDaReleitura[] = [];
    for (const f of devidas.rows) {
      try {
        const ligada = await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: f.tenant_id, brandId: f.brand_id }));
        if (!ligada) {
          await withSystem(db, (tx) =>
            tx.execute(sql`update liame.billing_invoice set charge_next_at = ${referencia} + ${ESPERA_DESLIGADA}::interval, updated_at = now() where id = ${f.id}`),
          );
          vezes.push({ fatura: f.id, tenantId: f.tenant_id, resultado: 'desligada' });
          continue;
        }
        const r = await relerCobranca((fn) => withSystem(db, fn), api, f.id, relogio);
        if (r.situacao === 'falhou' && r.falha !== 'limite_do_meio') this.logger.error(`fatura ${f.id}: a releitura da cobrança falhou (${r.falha})`);
        if (r.situacao === 'parada') this.logger.error(`fatura ${f.id}: a cobrança no Asaas pede uma pessoa da distribuição (${r.problema})`);
        vezes.push({ fatura: f.id, tenantId: f.tenant_id, resultado: r.situacao });
      } catch (err) {
        this.logger.error(`fatura ${f.id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ fatura: f.id, tenantId: f.tenant_id, resultado: 'falhou' });
      }
    }
    return vezes;
  }
}
