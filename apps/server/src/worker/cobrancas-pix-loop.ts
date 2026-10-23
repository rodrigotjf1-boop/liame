import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { garantirCobrancaPix, type ResultadoDaCobranca } from '../cobranca/cobranca-pix.js';
import { MeioAsaas } from '../cobranca/meio-asaas.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** A empresa com a função `cobranca` desligada: a fatura volta à fila depois disto (V106: a recusa grava a espera). */
const ESPERA_DESLIGADA = '1 hour';

export type VezDaCobrancaPix = { fatura: string; tenantId: string; resultado: ResultadoDaCobranca['situacao'] | 'desligada' | 'falhou' };

/**
 * A cobrança PIX das faturas que nascem (A7, W2a; D-A7-30): toda fatura em aberto, ainda sem cobrança no Asaas, de uma
 * assinatura no PIX, ganha a cobrança dela, pelo mesmo caminho da rota do QR Code (`garantirCobrancaPix`, que procura
 * antes de criar e trava a fatura enquanto cria). A primeira mensalidade nasce ao assinar; as seguintes, 5 dias antes do
 * vencimento (W1). A falha grava a próxima vez (1 minuto, 5, 30, 2 horas, ou a espera que o Asaas pediu) e o porquê em
 * código; sem o CNPJ da empresa, a fatura volta em 2 horas. Sem o Asaas configurado, a rotina não faz nada.
 */
@Injectable()
export class CobrancasPixLoop {
  private readonly logger = new Logger('cobrancas-pix');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly meio: MeioAsaas,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 10, scope: JobScope = {}, agora?: Date): Promise<VezDaCobrancaPix[]> {
    const api = this.meio.api();
    if (!this.database || !api) return [];
    const db = this.database.db;
    const relogio = agora ?? new Date();
    const referencia = sql`${relogio.toISOString()}::timestamptz`;
    const devidas = await withSystem(db, (tx) =>
      tx.execute<{ id: string; tenant_id: string; brand_id: string }>(sql`
        select i.id, i.tenant_id, i.brand_id
          from liame.billing_invoice i
          join liame.subscription s on s.id = i.subscription_id
         where i.status = 'aberta' and i.external_id is null and s.method = 'pix' and s.status <> 'encerrada'
           and (i.charge_next_at is null or i.charge_next_at <= ${referencia})
           and (i.charge_locked_until is null or i.charge_locked_until <= ${referencia})
           ${tenantFilter(scope, sql`i.tenant_id`)}
         order by i.charge_next_at nulls first, i.due_date, i.id
         limit ${limite}`),
    );

    const vezes: VezDaCobrancaPix[] = [];
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
        const r = await garantirCobrancaPix((fn) => withSystem(db, fn), api, f.id, relogio);
        if (r.situacao === 'falhou' && r.falha !== 'limite_do_meio') this.logger.error(`fatura ${f.id}: a cobrança PIX não foi criada (${r.falha})`);
        vezes.push({ fatura: f.id, tenantId: f.tenant_id, resultado: r.situacao });
      } catch (err) {
        this.logger.error(`fatura ${f.id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ fatura: f.id, tenantId: f.tenant_id, resultado: 'falhou' });
      }
    }
    return vezes;
  }
}
