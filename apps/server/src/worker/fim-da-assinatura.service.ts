import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { decidirApagamento, type DecisaoDoApagamento, MOTIVO_DO_APAGAMENTO, situacaoDaMarca } from '../cobranca/fim-da-assinatura.js';
import { diaNoFuso } from '../cobranca/vida.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { LifecyclePurgeService } from './lifecycle-purge.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// O apagamento no fim da assinatura (A7, W3, parte 4a; Termos 11.2; D-A7-106). A marca cuja última assinatura paga
// terminou e chegou ao dia do apagamento (`subscription.purge_on`, gravado no fim: o fim + 30 dias, ou o 60º dia de
// atraso), sem assinatura viva e sem nada pendente no meio de pagamento, sai: só ela, quando outra marca da empresa
// segue viva; a empresa inteira (o expurgo que já existe, com a chave destruída e o certificado ao Dono), quando todas
// estão na mesma situação. Com a função `cobranca` desligada para a marca, nada sai. O relógio vem de quem chama (V34).

/** A cobrança a cancelar ou a devolução em andamento no meio de pagamento, nas faturas da marca. */
const PENDENTE_NO_MEIO = (marca: SQL) => sql`exists (
  select 1 from liame.billing_invoice i
   where i.brand_id = ${marca}
     and ((i.status in ('aberta', 'cancelada') and i.charge_next_at is not null)
          or (i.refund_requested_at is not null and i.refunded_at is null)))`;

/** O dia do apagamento da última assinatura paga da marca. */
const APAGAR_EM = (marca: SQL) => sql`(
  select s.purge_on from liame.subscription s
   where s.brand_id = ${marca} and s.first_paid_at is not null
   order by s.first_paid_at desc limit 1)`;

const VIVA = (marca: SQL) => sql`exists (select 1 from liame.subscription v where v.brand_id = ${marca} and v.status <> 'encerrada')`;

type Devida = { tenant_id: string; brand_id: string; timezone: string; apagar_em: string };
type Outra = { id: string; viva: boolean; apagar_em: string | null; pendente: boolean };

export type ApagamentoDaRotina = {
  tenantId: string;
  brandId: string;
  resultado: DecisaoDoApagamento | 'desligada' | 'apagada' | 'empresa_apagada' | 'falhou';
};

@Injectable()
export class FimDaAssinaturaService {
  private readonly logger = new Logger('fim-da-assinatura');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly expurgo: LifecyclePurgeService,
  ) {}

  /** Uma volta: até `n` marcas que chegaram ao dia, a mais antiga primeiro. */
  async executarLote(n = 20, scope: JobScope = {}, agora: Date = new Date()): Promise<ApagamentoDaRotina[]> {
    if (!this.database) return [];
    const instante = sql`${agora.toISOString()}::timestamptz`;
    const devidas = await withSystem(this.database.db, (tx) =>
      tx.execute<Devida>(sql`
        select b.tenant_id, b.id as brand_id, o.timezone, ${APAGAR_EM(sql`b.id`)}::text as apagar_em
          from liame.brand b
          join liame.organization o on o.id = b.tenant_id
         where b.archived_at is null and o.status = 'ativa' and o.legal_hold_at is null ${tenantFilter(scope, sql`b.tenant_id`)}
           and ${APAGAR_EM(sql`b.id`)} <= (${instante} at time zone o.timezone)::date
           and not ${VIVA(sql`b.id`)}
           and not ${PENDENTE_NO_MEIO(sql`b.id`)}
         order by apagar_em, b.id
         limit ${n}`),
    );
    const feitos: ApagamentoDaRotina[] = [];
    const empresasApagadas = new Set<string>();
    for (const d of devidas.rows) {
      if (empresasApagadas.has(d.tenant_id)) continue;
      const r = await this.apagar(d, agora);
      if (r.resultado === 'empresa_apagada') empresasApagadas.add(d.tenant_id);
      feitos.push(r);
    }
    return feitos;
  }

  private async apagar(d: Devida, agora: Date): Promise<ApagamentoDaRotina> {
    const base = { tenantId: d.tenant_id, brandId: d.brand_id };
    if (!(await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: d.tenant_id, brandId: d.brand_id })))) {
      return { ...base, resultado: 'desligada' };
    }
    const hoje = diaNoFuso(agora, d.timezone);
    const outras = await withSystem(this.database!.db, (tx) =>
      tx.execute<Outra>(sql`
        select b.id, ${VIVA(sql`b.id`)} as viva, ${APAGAR_EM(sql`b.id`)}::text as apagar_em, ${PENDENTE_NO_MEIO(sql`b.id`)} as pendente
          from liame.brand b
         where b.tenant_id = ${d.tenant_id} and b.archived_at is null and b.id <> ${d.brand_id}`),
    );
    const decisao = decidirApagamento(
      outras.rows.map((o) => situacaoDaMarca({ viva: o.viva, apagarEm: o.apagar_em, pendenteNoMeio: o.pendente }, hoje)),
    );
    try {
      if (decisao === 'marca') {
        const apagou = await this.expurgo.purgeBrand(d.tenant_id, d.brand_id);
        if (apagou) this.logger.log(`marca ${d.brand_id} apagada no fim da assinatura (o dia era ${d.apagar_em}); outra marca da empresa segue`);
        return { ...base, resultado: apagou ? 'apagada' : 'falhou' };
      }
      if (decisao === 'empresa') {
        await withSystem(this.database!.db, (tx) =>
          tx.execute(sql`update liame.organization set purge_reason = ${MOTIVO_DO_APAGAMENTO} where id = ${d.tenant_id} and legal_hold_at is null`),
        );
        await this.expurgo.purgeTenant(d.tenant_id);
        this.logger.log(`empresa ${d.tenant_id} apagada no fim da assinatura, com o certificado ao Dono`);
        return { ...base, resultado: 'empresa_apagada' };
      }
      return { ...base, resultado: 'esperar' };
    } catch (err) {
      this.logger.error(`apagamento da marca ${d.brand_id} falhou: ${err instanceof Error ? err.message : String(err)}`);
      return { ...base, resultado: 'falhou' };
    }
  }
}
