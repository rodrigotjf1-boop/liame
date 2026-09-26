import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { blindIndex, type EncryptionContext, open, packSealed, seal, unpackSealed } from './envelope.js';
import { type KeyProvider, KeyUnavailableError } from './key-provider.js';

export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

const TENANT_DEK_TTL_MS = 5 * 60 * 1000;
const PII_PREFIX = 'pii1.';

type SecretRow = {
  id: string;
  tenant_id: string | null;
  owner_user_id: string | null;
  purpose: string;
  key_version: number;
  wrapped_dek: string;
  iv: string;
  ciphertext: string;
};

export interface PutSecret {
  tenantId?: string | null;
  ownerUserId?: string | null;
  purpose: string;
  plaintext: string;
}

/**
 * Cofre (ADR-011, ADR-014, A1-13). Segredo = envelope próprio (chave de dados embrulhada pela chave mestra),
 * amarrado ao registro pelo contexto. Dado pessoal = chave de dados da empresa, com índice cego para busca.
 * O que sai daqui nunca vai para log, resposta de API, prompt ou auditoria visível (security-model §5).
 */
@Injectable()
export class VaultService {
  private readonly logger = new Logger('cofre');
  private readonly tenantDeks = new Map<string, { dek: Buffer; expiresAt: number }>();

  constructor(
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(DATABASE) private readonly database: Database | null,
  ) {}

  // ------------------------------------------------------------------ segredos

  async putSecret(tx: Tx, input: PutSecret): Promise<string> {
    const id = uuidv7();
    const context = secretContext({ id, tenant_id: input.tenantId ?? null, owner_user_id: input.ownerUserId ?? null, purpose: input.purpose });
    const { plaintext: dek, wrapped, keyVersion } = await this.keys.generateDataKey(context);
    try {
      const sealed = seal(dek, Buffer.from(input.plaintext, 'utf8'), context);
      await tx.execute(sql`
        insert into liame.secret (id, tenant_id, owner_user_id, purpose, key_version, wrapped_dek, iv, ciphertext)
        values (${id}, ${input.tenantId ?? null}, ${input.ownerUserId ?? null}, ${input.purpose}, ${keyVersion}, ${wrapped},
                ${sealed.iv.toString('base64url')}, ${sealed.ciphertext.toString('base64url')})`);
    } finally {
      dek.fill(0);
    }
    return id;
  }

  /** Lê um segredo visível no contexto da transação (a RLS decide o que é visível). */
  async readSecret(tx: Tx, id: string): Promise<string | null> {
    const r = await tx.execute<SecretRow>(sql`select * from liame.secret where id = ${id} and revoked_at is null`);
    return r.rows[0] ? this.decrypt(r.rows[0]) : null;
  }

  async findUserSecret(tx: Tx, userId: string, purpose: string): Promise<{ id: string; plaintext: string } | null> {
    const r = await tx.execute<SecretRow>(sql`
      select * from liame.secret
       where owner_user_id = ${userId} and tenant_id is null and purpose = ${purpose} and revoked_at is null`);
    const row = r.rows[0];
    return row ? { id: row.id, plaintext: await this.decrypt(row) } : null;
  }

  async revokeSecret(tx: Tx, id: string): Promise<void> {
    await tx.execute(sql`update liame.secret set revoked_at = now() where id = ${id} and revoked_at is null`);
  }

  /**
   * Recifra os segredos que estão numa versão antiga da chave mestra (A1-13). Job da distribuição:
   * enxerga todos os tenants; em teste, recebe o escopo explícito (`ids`) para não tocar o que não criou (LIC-083).
   */
  async rotateSecrets(options: { ids?: string[]; batchSize?: number } = {}): Promise<number> {
    const database = this.requireDb();
    const batch = options.batchSize ?? 200;
    let total = 0;
    for (;;) {
      const done = await withSystem(database.db, async (tx) => {
        if (options.ids && options.ids.length === 0) return 0;
        // O Drizzle expande o array em ($1, $2, ...): por isso `in`, e a lista vazia sai antes.
        const scope = options.ids ? sql` and id in ${options.ids}` : sql``;
        const r = await tx.execute<SecretRow>(sql`
          select * from liame.secret
           where key_version <> ${this.keys.currentVersion} and revoked_at is null${scope}
           order by id limit ${batch} for update skip locked`);
        for (const row of r.rows) {
          const plaintext = await this.decrypt(row);
          const context = secretContext(row);
          const { plaintext: dek, wrapped, keyVersion } = await this.keys.generateDataKey(context);
          try {
            const sealed = seal(dek, Buffer.from(plaintext, 'utf8'), context);
            await tx.execute(sql`
              update liame.secret
                 set key_version = ${keyVersion}, wrapped_dek = ${wrapped}, iv = ${sealed.iv.toString('base64url')},
                     ciphertext = ${sealed.ciphertext.toString('base64url')}, rotated_at = now()
               where id = ${row.id}`);
          } finally {
            dek.fill(0);
          }
        }
        return r.rows.length;
      });
      total += done;
      if (done < batch) break;
    }
    if (total) this.logger.log(`rotação: ${total} segredo(s) recifrado(s) na chave mestra v${this.keys.currentVersion}`);
    return total;
  }

  private async decrypt(row: SecretRow): Promise<string> {
    const context = secretContext(row);
    const dek = await this.keys.decryptDataKey(row.wrapped_dek, row.key_version, context);
    try {
      return open(dek, Buffer.from(row.iv, 'base64url'), Buffer.from(row.ciphertext, 'base64url'), context).toString('utf8');
    } finally {
      dek.fill(0);
    }
  }

  // ------------------------------------------------------------------ dado pessoal por empresa (ADR-014)

  async encryptForTenant(tx: Tx, tenantId: string, field: string, plaintext: string): Promise<string> {
    const dek = await this.tenantDek(tx, tenantId);
    return PII_PREFIX + packSealed(seal(dek, Buffer.from(plaintext, 'utf8'), { tenant_id: tenantId, field }));
  }

  async decryptForTenant(tx: Tx, tenantId: string, field: string, value: string): Promise<string> {
    if (!value.startsWith(PII_PREFIX)) throw new Error('cofre: valor não está cifrado');
    const dek = await this.tenantDek(tx, tenantId);
    const { iv, ciphertext } = unpackSealed(value.slice(PII_PREFIX.length));
    return open(dek, iv, ciphertext, { tenant_id: tenantId, field }).toString('utf8');
  }

  /** Índice cego para busca exata (telefone, e-mail): o mesmo valor dá o mesmo índice só dentro da empresa. */
  async blindIndexFor(tx: Tx, tenantId: string, normalizedValue: string): Promise<string> {
    return blindIndex(await this.tenantDek(tx, tenantId), normalizedValue);
  }

  /**
   * Expurgo da empresa: agenda a destruição da chave dela no KMS e marca a linha. Depois disso, o dado
   * pessoal dela fica ilegível, inclusive em backup (crypto-shredding, ADR-014).
   */
  async destroyTenantKey(tenantId: string): Promise<void> {
    const database = this.requireDb();
    const keyRef = await withSystem(database.db, async (tx) => {
      const r = await tx.execute<{ key_ref: string }>(sql`
        update liame.tenant_key set destroyed_at = now() where tenant_id = ${tenantId} and destroyed_at is null returning key_ref`);
      return r.rows[0]?.key_ref ?? null;
    });
    this.tenantDeks.delete(tenantId);
    if (keyRef) await this.keys.scheduleTenantKeyDeletion(keyRef);
  }

  private async tenantDek(tx: Tx, tenantId: string): Promise<Buffer> {
    const cached = this.tenantDeks.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.dek;
    const context = { tenant_id: tenantId };
    let row = (await tx.execute<{ key_ref: string; wrapped_dek: string; destroyed_at: string | null }>(
      sql`select key_ref, wrapped_dek, destroyed_at from liame.tenant_key where tenant_id = ${tenantId}`,
    )).rows[0];
    if (row?.destroyed_at) throw new KeyUnavailableError('a chave desta empresa foi destruída (expurgo)');
    if (!row) {
      const keyRef = await this.keys.createTenantKey(tenantId);
      const { wrapped } = await this.keys.generateTenantDataKey(keyRef, context);
      const inserted = await tx.execute<{ key_ref: string }>(sql`
        insert into liame.tenant_key (tenant_id, key_ref, wrapped_dek) values (${tenantId}, ${keyRef}, ${wrapped})
        on conflict (tenant_id) do nothing returning key_ref`);
      if (!inserted.rows[0]) {
        // Outra requisição criou a chave ao mesmo tempo: a nossa sobrou e é destruída.
        await this.keys.scheduleTenantKeyDeletion(keyRef).catch((err: unknown) =>
          this.logger.warn(`chave de empresa órfã não destruída: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      row = (await tx.execute<{ key_ref: string; wrapped_dek: string; destroyed_at: string | null }>(
        sql`select key_ref, wrapped_dek, destroyed_at from liame.tenant_key where tenant_id = ${tenantId}`,
      )).rows[0];
      if (!row) throw new Error('cofre: chave da empresa não gravada');
    }
    const dek = await this.keys.decryptTenantDataKey(row.key_ref, row.wrapped_dek, context);
    this.tenantDeks.set(tenantId, { dek, expiresAt: Date.now() + TENANT_DEK_TTL_MS });
    return dek;
  }

  private requireDb(): Database {
    if (!this.database) throw new Error('cofre sem banco');
    return this.database;
  }
}

/** Contexto de cifragem de um segredo: amarra a cifra ao registro (id, dono, finalidade). */
function secretContext(row: { id: string; tenant_id: string | null; owner_user_id: string | null; purpose: string }): EncryptionContext {
  return {
    purpose: row.purpose,
    secret_id: row.id,
    ...(row.tenant_id ? { tenant_id: row.tenant_id } : {}),
    ...(row.owner_user_id ? { user_id: row.owner_user_id } : {}),
  };
}
