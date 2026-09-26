import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, uuidv7, withContext } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyUnavailableError, LocalKeyProvider } from '../../src/vault/key-provider.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ownerQuery } from '../helpers/api.js';
import { APP_URL, OWNER_URL, hasDb } from './env.js';

// A1-13: segredo cifrado com envelope; chave mestra fora do banco; rotação para a versão 2 com recifragem.
describe.skipIf(!hasDb)('cofre', () => {
  const v1 = randomBytes(32);
  const v2 = randomBytes(32);
  const tenantA = uuidv7();
  const tenantB = uuidv7();
  const userA = uuidv7();
  const userB = uuidv7();
  let database: Database;
  let vault: VaultService;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await ownerQuery(`insert into liame.organization (id, name) values ($1, 'Cofre A'), ($2, 'Cofre B')`, [tenantA, tenantB]);
    await ownerQuery(
      `insert into liame.app_user (id, email, name, password_hash) values ($1, $2, 'A', 'x'), ($3, $4, 'B', 'x')`,
      [userA, `cofre.a.${userA}@teste.liame.dev`, userB, `cofre.b.${userB}@teste.liame.dev`],
    );
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    vault = new VaultService(new LocalKeyProvider(new Map([[1, v1]]), 1), database);
  });

  afterAll(async () => {
    await database?.close();
    await ownerQuery(`delete from liame.organization where id in ($1, $2)`, [tenantA, tenantB]);
    await ownerQuery(`delete from liame.app_user where id in ($1, $2)`, [userA, userB]);
  });

  it('o banco guarda só a cifra: nem o segredo nem a chave de dados em claro', async () => {
    const segredo = `token-da-meta-${randomBytes(8).toString('hex')}`;
    const id = await withContext(database.db, { tenantId: tenantA }, (tx) =>
      vault.putSecret(tx, { tenantId: tenantA, purpose: 'meta_token', plaintext: segredo }),
    );
    const [row] = await ownerQuery<Record<string, string>>(`select * from liame.secret where id = $1`, [id]);
    expect(JSON.stringify(row)).not.toContain(segredo);
    expect(JSON.stringify(row)).not.toContain(v1.toString('base64'));
    expect(row?.key_version).toBe(1);
    expect(await withContext(database.db, { tenantId: tenantA }, (tx) => vault.readSecret(tx, id))).toBe(segredo);
  });

  it('a cifra fica amarrada ao registro: copiada para outra linha, não abre', async () => {
    const [a, b] = await withContext(database.db, { tenantId: tenantA }, async (tx) => [
      await vault.putSecret(tx, { tenantId: tenantA, purpose: 'meta_token', plaintext: 'segredo A' }),
      await vault.putSecret(tx, { tenantId: tenantA, purpose: 'meta_token', plaintext: 'segredo B' }),
    ]);
    await ownerQuery(
      `update liame.secret set wrapped_dek = s.wrapped_dek, iv = s.iv, ciphertext = s.ciphertext
         from liame.secret s where s.id = $1 and liame.secret.id = $2`,
      [a, b],
    );
    await expect(withContext(database.db, { tenantId: tenantA }, (tx) => vault.readSecret(tx, b))).rejects.toThrow();
  });

  it('outra empresa não enxerga o segredo (RLS)', async () => {
    const id = await withContext(database.db, { tenantId: tenantA }, (tx) =>
      vault.putSecret(tx, { tenantId: tenantA, purpose: 'google_token', plaintext: 'só da A' }),
    );
    expect(await withContext(database.db, { tenantId: tenantB }, (tx) => vault.readSecret(tx, id))).toBeNull();
  });

  it('segredo pessoal (app autenticador) só aparece para a própria pessoa', async () => {
    await withContext(database.db, { userId: userA }, (tx) => vault.putSecret(tx, { ownerUserId: userA, purpose: 'totp', plaintext: 'JBSWY3DPEHPK3PXP' }));
    const daPropria = await withContext(database.db, { userId: userA }, (tx) => vault.findUserSecret(tx, userA, 'totp'));
    const deOutra = await withContext(database.db, { userId: userB }, (tx) => vault.findUserSecret(tx, userA, 'totp'));
    expect(daPropria?.plaintext).toBe('JBSWY3DPEHPK3PXP');
    expect(deOutra).toBeNull();
  });

  it('A1-13: rotação para a chave mestra v2 recifra tudo; depois, só a v2 basta', async () => {
    const ids = await withContext(database.db, { tenantId: tenantA }, async (tx) => [
      await vault.putSecret(tx, { tenantId: tenantA, purpose: 'meta_token', plaintext: 'um' }),
      await vault.putSecret(tx, { tenantId: tenantA, purpose: 'meta_token', plaintext: 'dois' }),
    ]);
    const rotator = new VaultService(new LocalKeyProvider(new Map([[1, v1], [2, v2]]), 2), database);
    expect(await rotator.rotateSecrets({ ids })).toBe(2);

    const rows = await ownerQuery<{ key_version: number; rotated_at: string | null }>(
      `select key_version, rotated_at from liame.secret where id = any($1::uuid[])`,
      [ids],
    );
    expect(rows.every((r) => r.key_version === 2 && r.rotated_at)).toBe(true);

    const soV2 = new VaultService(new LocalKeyProvider(new Map([[2, v2]]), 2), database);
    const lidos = await withContext(database.db, { tenantId: tenantA }, (tx) => Promise.all(ids.map((id) => soV2.readSecret(tx, id))));
    expect(lidos).toEqual(['um', 'dois']);

    const soV1 = new VaultService(new LocalKeyProvider(new Map([[1, v1]]), 1), database);
    await expect(withContext(database.db, { tenantId: tenantA }, (tx) => soV1.readSecret(tx, ids[0]!))).rejects.toThrow(KeyUnavailableError);
  });

  it('dado pessoal com a chave da empresa: cifra, índice cego e expurgo (crypto-shredding)', async () => {
    const provider = new LocalKeyProvider(new Map([[1, v1]]), 1);
    const pii = new VaultService(provider, database);
    const cifrado = await withContext(database.db, { tenantId: tenantB }, (tx) => pii.encryptForTenant(tx, tenantB, 'telefone', '+5521999990000'));
    expect(cifrado).not.toContain('99999');
    expect(await withContext(database.db, { tenantId: tenantB }, (tx) => pii.decryptForTenant(tx, tenantB, 'telefone', cifrado))).toBe('+5521999990000');

    const indiceB = await withContext(database.db, { tenantId: tenantB }, (tx) => pii.blindIndexFor(tx, tenantB, '+5521999990000'));
    const indiceA = await withContext(database.db, { tenantId: tenantA }, (tx) => pii.blindIndexFor(tx, tenantA, '+5521999990000'));
    expect(indiceB).not.toBe(indiceA);

    await pii.destroyTenantKey(tenantB);
    const depois = new VaultService(provider, database);
    await expect(
      withContext(database.db, { tenantId: tenantB }, (tx) => depois.decryptForTenant(tx, tenantB, 'telefone', cifrado)),
    ).rejects.toThrow(KeyUnavailableError);
    const [chave] = await ownerQuery<{ destroyed_at: string | null }>(`select destroyed_at from liame.tenant_key where tenant_id = $1`, [tenantB]);
    expect(chave?.destroyed_at).toBeTruthy();
  });
});
