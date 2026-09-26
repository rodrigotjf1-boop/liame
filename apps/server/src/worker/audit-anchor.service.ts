import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { verifyChain } from '../audit/audit.js';
import { ANCHOR_GENESIS, type AnchorPublisher, anchorStatement, type ChainHead, computeRoot, RekorPublisher, TsaPublisher } from '../audit/anchor.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';

type AnchorRow = {
  day: string;
  root_hash: string;
  prev_root_hash: string;
  rekor_log_index: string | null;
  tsa_response: string | null;
  published_at: Date | string | null;
};

export interface AnchorCheck {
  ok: boolean;
  days: number;
  brokenDay: string | null;
  reason: string | null;
}

/** Destinos da publicação (testes passam os seus); sem isso, vêm da configuração. */
export const ANCHOR_PUBLISHERS = Symbol('ANCHOR_PUBLISHERS');

const DAY_MS = 86_400_000;
const MAX_DAYS_PER_RUN = 400;

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}

/**
 * Âncora diária (A1-6, ADR-011): uma raiz por dia fechado, encadeada à anterior, publicada no Rekor
 * e carimbada (RFC 3161). Roda no worker, uma vez por dia, e também verifica o que já foi ancorado.
 */
@Injectable()
export class AuditAnchorService {
  private readonly logger = new Logger('auditoria');
  private readonly publishers: AnchorPublisher[];

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(ANCHOR_PUBLISHERS) publishers?: AnchorPublisher[],
  ) {
    const a = config.auditAnchor;
    this.publishers = publishers ?? [
      ...(a.rekorUrl && a.signingKeyPem ? [new RekorPublisher(a.rekorUrl, a.signingKeyPem)] : []),
      ...(a.tsaUrl ? [new TsaPublisher(a.tsaUrl)] : []),
    ];
  }

  private get db() {
    if (!this.database) throw new Error('auditoria: sem banco');
    return this.database.db;
  }

  /** O job diário: ancora os dias fechados, publica o que falta e verifica. Falha vira log de erro (alerta). */
  async runDaily(now = new Date()): Promise<void> {
    const anchored = await this.anchorPending(now);
    await this.publishPending();
    const anchors = await this.verifyAnchors();
    if (!anchors.ok) this.logger.error(`âncoras não conferem no dia ${anchors.brokenDay}: ${anchors.reason}`);
    const chains = await this.verifyChangedChains(addDays(utcDay(now), -1));
    for (const c of chains.filter((x) => !x.ok)) this.logger.error(`cadeia ${c.chainKey} quebrada no evento ${c.brokenAtSeq}: ${c.reason}`);
    this.logger.log(`âncora: ${anchored} dia(s) novo(s); ${chains.length} cadeia(s) verificada(s)`);
  }

  /** Ancora, em ordem, cada dia fechado (UTC) ainda sem âncora. `from` só para testes. */
  async anchorPending(now = new Date(), options: { from?: string } = {}): Promise<number> {
    const yesterday = addDays(utcDay(now), -1);
    const start = await withSystem(this.db, async (tx) => {
      const last = await tx.execute<{ day: string }>(sql`select max(day)::text as day from liame.audit_anchor`);
      if (last.rows[0]?.day) return addDays(last.rows[0].day, 1);
      if (options.from) return options.from;
      const first = await tx.execute<{ day: string | null }>(sql`
        select (min(occurred_at) at time zone 'UTC')::date::text as day from liame.audit_event`);
      const firstDay = first.rows[0]?.day ?? yesterday;
      return firstDay < yesterday ? firstDay : yesterday;
    });
    let count = 0;
    for (let day = start; day <= yesterday && count < MAX_DAYS_PER_RUN; day = addDays(day, 1)) {
      await this.anchorDay(day);
      count++;
    }
    return count;
  }

  /** Grava a raiz de um dia. Idempotente: o dia já ancorado não muda. */
  async anchorDay(day: string): Promise<string> {
    return withSystem(this.db, async (tx) => {
      const existing = await tx.execute<{ root_hash: string }>(sql`select root_hash from liame.audit_anchor where day = ${day}::date`);
      if (existing.rows[0]) return existing.rows[0].root_hash;
      const prev = await tx.execute<{ day: string; root_hash: string }>(sql`
        select day::text, root_hash from liame.audit_anchor where day < ${day}::date order by day desc limit 1`);
      const p = prev.rows[0];
      if (p && p.day !== addDays(day, -1)) throw new Error(`auditoria: falta a âncora de ${addDays(p.day, 1)} antes de ${day}`);
      const prevRoot = p?.root_hash ?? ANCHOR_GENESIS;
      const heads = await this.headsAt(tx, day);
      const events = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from liame.audit_event
         where occurred_at >= (${day}::date)::timestamp at time zone 'UTC'
           and occurred_at < ((${day}::date + 1))::timestamp at time zone 'UTC'`);
      const root = computeRoot(this.config.auditAnchor.salt, prevRoot, day, heads);
      await tx.execute(sql`
        insert into liame.audit_anchor (day, root_hash, prev_root_hash, chains, events)
        values (${day}::date, ${root}, ${prevRoot}, ${heads.length}, ${Number(events.rows[0]?.n ?? 0)})`);
      return root;
    });
  }

  /** Publica as âncoras que ainda não saíram do banco (cada destino uma vez; falha tenta no próximo dia). */
  async publishPending(): Promise<number> {
    if (!this.publishers.length) {
      this.logger.warn('âncora da auditoria sem destino externo configurado (REKOR_URL, TSA_URL)');
      return 0;
    }
    const pending = await withSystem(this.db, (tx) =>
      tx.execute<AnchorRow>(sql`
        select day::text, root_hash, prev_root_hash, rekor_log_index, tsa_response, published_at
          from liame.audit_anchor where published_at is null order by day limit 60`),
    );
    let published = 0;
    for (const a of pending.rows) {
      const statement = anchorStatement(a.day, a.root_hash, a.prev_root_hash);
      let done = true;
      for (const p of this.publishers) {
        if ((p.name === 'rekor' && a.rekor_log_index !== null) || (p.name === 'tsa' && a.tsa_response !== null)) continue;
        try {
          const r = await p.publish(statement);
          await withSystem(this.db, (tx) =>
            tx.execute(sql`
              update liame.audit_anchor
                 set rekor_log_index = coalesce(${r.rekorLogIndex ?? null}, rekor_log_index),
                     rekor_entry = coalesce(${r.rekorEntry ?? null}, rekor_entry),
                     tsa_response = coalesce(${r.tsaResponse ?? null}, tsa_response)
               where day = ${a.day}::date`),
          );
        } catch (err) {
          done = false;
          this.logger.error(`âncora de ${a.day} não publicada em ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (done) {
        await withSystem(this.db, (tx) => tx.execute(sql`update liame.audit_anchor set published_at = now() where day = ${a.day}::date`));
        published++;
      }
    }
    return published;
  }

  /** Confere as âncoras: um dia depois do outro, sem buraco, cada raiz ligada à anterior e igual à recalculada. */
  async verifyAnchors(): Promise<AnchorCheck> {
    return withSystem(this.db, async (tx) => {
      const rows = await tx.execute<{ day: string; root_hash: string; prev_root_hash: string }>(sql`
        select day::text, root_hash, prev_root_hash from liame.audit_anchor order by day`);
      let prevDay: string | null = null;
      let prevRoot = ANCHOR_GENESIS;
      let days = 0;
      for (const a of rows.rows) {
        const fail = (reason: string): AnchorCheck => ({ ok: false, days, brokenDay: a.day, reason });
        if (prevDay && a.day !== addDays(prevDay, 1)) return fail(`falta a âncora de ${addDays(prevDay, 1)}`);
        if (a.prev_root_hash !== prevRoot) return fail('não liga com a raiz do dia anterior');
        const heads = await this.headsAt(tx, a.day);
        if (computeRoot(this.config.auditAnchor.salt, prevRoot, a.day, heads) !== a.root_hash) {
          return fail('raiz diferente da recalculada (evento alterado ou apagado)');
        }
        prevDay = a.day;
        prevRoot = a.root_hash;
        days++;
      }
      return { ok: true, days, brokenDay: null, reason: null };
    });
  }

  /** Verifica por inteiro as cadeias que mudaram no dia. */
  async verifyChangedChains(day: string): Promise<Array<{ chainKey: string } & Awaited<ReturnType<typeof verifyChain>>>> {
    return withSystem(this.db, async (tx) => {
      const keys = await tx.execute<{ chain_key: string }>(sql`
        select distinct chain_key from liame.audit_event
         where occurred_at >= (${day}::date)::timestamp at time zone 'UTC'
           and occurred_at < ((${day}::date + 1))::timestamp at time zone 'UTC'`);
      const out = [];
      for (const k of keys.rows) out.push({ chainKey: k.chain_key, ...(await verifyChain(tx, k.chain_key)) });
      return out;
    });
  }

  /** Cabeça de cada cadeia no fim do dia: o último evento com `occurred_at` antes da meia-noite (UTC). */
  private async headsAt(tx: Tx, day: string): Promise<ChainHead[]> {
    const r = await tx.execute<ChainHead>(sql`
      select c.chain_key, e.chain_seq, e.hash
        from liame.audit_chain c
        cross join lateral (
          select chain_seq, hash from liame.audit_event e
           where e.chain_key = c.chain_key and e.occurred_at < ((${day}::date + 1))::timestamp at time zone 'UTC'
           order by chain_seq desc limit 1
        ) e`);
    return r.rows;
  }
}
