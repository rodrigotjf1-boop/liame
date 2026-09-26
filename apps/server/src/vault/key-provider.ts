import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type EncryptionContext, open, packSealed, seal, unpackSealed } from './envelope.js';

// O KMS registra o contexto de cifragem no CloudTrail: ele leva só ids e finalidade, nunca dado pessoal.

/**
 * Onde vivem as chaves que embrulham as chaves de dados (ADR-011): nunca no banco.
 * Produção: AWS KMS em São Paulo. Desenvolvimento e testes: chaves locais do ambiente.
 */
export interface KeyProvider {
  readonly name: string;
  /** Versão atual da chave mestra (KEK). Segredos em versão antiga são recifrados na rotação (A1-13). */
  readonly currentVersion: number;
  generateDataKey(context: EncryptionContext): Promise<{ plaintext: Buffer; wrapped: string; keyVersion: number }>;
  decryptDataKey(wrapped: string, keyVersion: number, context: EncryptionContext): Promise<Buffer>;
  /** Chave própria da empresa, para os dados pessoais (ADR-014). Devolve a referência. */
  createTenantKey(tenantId: string): Promise<string>;
  generateTenantDataKey(keyRef: string, context: EncryptionContext): Promise<{ plaintext: Buffer; wrapped: string }>;
  decryptTenantDataKey(keyRef: string, wrapped: string, context: EncryptionContext): Promise<Buffer>;
  /** Destrói a chave da empresa (expurgo). No KMS, com período de espera antes da exclusão definitiva. */
  scheduleTenantKeyDeletion(keyRef: string): Promise<void>;
}

export class KeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyUnavailableError';
  }
}

/** `"1:<base64>,2:<base64>"` → versões da chave mestra local (32 bytes cada). */
export function parseLocalKeks(value: string | undefined): Map<number, Buffer> {
  const keks = new Map<number, Buffer>();
  for (const part of (value ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [version, material] = part.split(':');
    const key = Buffer.from(material ?? '', 'base64');
    if (!/^\d+$/.test(version ?? '') || key.length !== 32) throw new Error('LIAME_KEK_LOCAL: use "1:<32 bytes em base64>,2:..."');
    keks.set(Number(version), key);
  }
  return keks;
}

/** Provedor local: chaves mestras no ambiente; chaves das empresas em memória (e num arquivo, no desenvolvimento). */
export class LocalKeyProvider implements KeyProvider {
  readonly name = 'local';
  private readonly tenantKeys = new Map<string, Buffer>();

  constructor(
    private readonly keks: Map<number, Buffer>,
    readonly currentVersion: number,
    private readonly tenantKeyFile?: string,
  ) {
    if (!keks.has(currentVersion)) throw new Error(`chave mestra local v${currentVersion} não configurada`);
    if (tenantKeyFile && existsSync(tenantKeyFile)) {
      const saved = JSON.parse(readFileSync(tenantKeyFile, 'utf8')) as Record<string, string>;
      for (const [ref, key] of Object.entries(saved)) this.tenantKeys.set(ref, Buffer.from(key, 'base64'));
    }
  }

  async generateDataKey(context: EncryptionContext) {
    const plaintext = randomBytes(32);
    const kek = this.keks.get(this.currentVersion)!;
    return { plaintext, wrapped: packSealed(seal(kek, plaintext, context)), keyVersion: this.currentVersion };
  }

  async decryptDataKey(wrapped: string, keyVersion: number, context: EncryptionContext) {
    const kek = this.keks.get(keyVersion);
    if (!kek) throw new KeyUnavailableError(`chave mestra v${keyVersion} indisponível`);
    const { iv, ciphertext } = unpackSealed(wrapped);
    return open(kek, iv, ciphertext, context);
  }

  async createTenantKey(tenantId: string) {
    const ref = `local:tenant:${tenantId}:${randomBytes(6).toString('hex')}`;
    this.tenantKeys.set(ref, randomBytes(32));
    this.persist();
    return ref;
  }

  async generateTenantDataKey(keyRef: string, context: EncryptionContext) {
    const key = this.tenantKey(keyRef);
    const plaintext = randomBytes(32);
    return { plaintext, wrapped: packSealed(seal(key, plaintext, context)) };
  }

  async decryptTenantDataKey(keyRef: string, wrapped: string, context: EncryptionContext) {
    const { iv, ciphertext } = unpackSealed(wrapped);
    return open(this.tenantKey(keyRef), iv, ciphertext, context);
  }

  async scheduleTenantKeyDeletion(keyRef: string) {
    this.tenantKeys.delete(keyRef);
    this.persist();
  }

  private tenantKey(keyRef: string): Buffer {
    const key = this.tenantKeys.get(keyRef);
    if (!key) throw new KeyUnavailableError('chave da empresa destruída ou indisponível');
    return key;
  }

  private persist(): void {
    if (!this.tenantKeyFile) return;
    const data = Object.fromEntries([...this.tenantKeys].map(([ref, key]) => [ref, key.toString('base64')]));
    writeFileSync(this.tenantKeyFile, JSON.stringify(data, null, 2), 'utf8');
  }
}

type KmsModule = typeof import('@aws-sdk/client-kms');

/** Provedor AWS KMS (sa-east-1): GenerateDataKey e Decrypt com contexto de cifragem; chave própria por empresa. */
export class AwsKmsKeyProvider implements KeyProvider {
  readonly name = 'aws-kms';

  private constructor(
    private readonly kms: KmsModule,
    private readonly client: InstanceType<KmsModule['KMSClient']>,
    private readonly keks: Map<number, string>,
    readonly currentVersion: number,
  ) {}

  static async create(region: string, keks: Map<number, string>, currentVersion: number): Promise<AwsKmsKeyProvider> {
    if (!keks.has(currentVersion)) throw new Error(`KEK v${currentVersion} não configurada no KMS`);
    const kms = await import('@aws-sdk/client-kms');
    return new AwsKmsKeyProvider(kms, new kms.KMSClient({ region }), keks, currentVersion);
  }

  async generateDataKey(context: EncryptionContext) {
    const r = await this.client.send(
      new this.kms.GenerateDataKeyCommand({ KeyId: this.keks.get(this.currentVersion), KeySpec: 'AES_256', EncryptionContext: context }),
    );
    return {
      plaintext: Buffer.from(r.Plaintext ?? []),
      wrapped: Buffer.from(r.CiphertextBlob ?? []).toString('base64url'),
      keyVersion: this.currentVersion,
    };
  }

  async decryptDataKey(wrapped: string, keyVersion: number, context: EncryptionContext) {
    const keyId = this.keks.get(keyVersion);
    if (!keyId) throw new KeyUnavailableError(`KEK v${keyVersion} não configurada`);
    const r = await this.client.send(
      new this.kms.DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64url'), KeyId: keyId, EncryptionContext: context }),
    );
    return Buffer.from(r.Plaintext ?? []);
  }

  async createTenantKey(tenantId: string) {
    const r = await this.client.send(
      new this.kms.CreateKeyCommand({
        Description: `Liame: dados pessoais da empresa ${tenantId}`,
        KeySpec: 'SYMMETRIC_DEFAULT',
        KeyUsage: 'ENCRYPT_DECRYPT',
        Tags: [{ TagKey: 'liame:tenant', TagValue: tenantId }],
      }),
    );
    const keyId = r.KeyMetadata?.KeyId;
    if (!keyId) throw new Error('KMS não devolveu a chave da empresa');
    return keyId;
  }

  async generateTenantDataKey(keyRef: string, context: EncryptionContext) {
    const r = await this.client.send(new this.kms.GenerateDataKeyCommand({ KeyId: keyRef, KeySpec: 'AES_256', EncryptionContext: context }));
    return { plaintext: Buffer.from(r.Plaintext ?? []), wrapped: Buffer.from(r.CiphertextBlob ?? []).toString('base64url') };
  }

  async decryptTenantDataKey(keyRef: string, wrapped: string, context: EncryptionContext) {
    try {
      const r = await this.client.send(
        new this.kms.DecryptCommand({ CiphertextBlob: Buffer.from(wrapped, 'base64url'), KeyId: keyRef, EncryptionContext: context }),
      );
      return Buffer.from(r.Plaintext ?? []);
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'KMSInvalidStateException' || name === 'NotFoundException') {
        throw new KeyUnavailableError('chave da empresa destruída ou agendada para exclusão');
      }
      throw err;
    }
  }

  async scheduleTenantKeyDeletion(keyRef: string) {
    await this.client.send(new this.kms.ScheduleKeyDeletionCommand({ KeyId: keyRef, PendingWindowInDays: 30 }));
  }
}
