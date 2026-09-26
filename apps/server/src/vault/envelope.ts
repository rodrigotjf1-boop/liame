import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

// AES-256-GCM com dados associados (AAD): o texto cifrado só abre com o mesmo contexto
// (tenant, finalidade, id do registro). Trocar a cifra de linha não decifra.

export type EncryptionContext = Record<string, string>;

const TAG_LENGTH = 16;

/** Contexto canônico (chaves ordenadas), igual ao "encryption context" do KMS. */
export function canonicalContext(context: EncryptionContext): Buffer {
  const sorted = Object.keys(context)
    .sort()
    .map((k) => [k, context[k]]);
  return Buffer.from(JSON.stringify(sorted), 'utf8');
}

export function seal(key: Buffer, plaintext: Buffer, context: EncryptionContext): { iv: Buffer; ciphertext: Buffer } {
  if (key.length !== 32) throw new Error('cofre: a chave precisa ter 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(canonicalContext(context));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

export function open(key: Buffer, iv: Buffer, ciphertext: Buffer, context: EncryptionContext): Buffer {
  if (key.length !== 32) throw new Error('cofre: a chave precisa ter 32 bytes');
  // Tag de tamanho fixo: sem isso, uma tag encurtada seria aceita e enfraqueceria a integridade.
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(canonicalContext(context));
  if (ciphertext.length < TAG_LENGTH) throw new Error('cofre: cifra curta demais');
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_LENGTH));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_LENGTH)), decipher.final()]);
}

/** Envelope compacto: `iv.cifra` em base64url (a AAD não viaja: é recalculada do contexto). */
export function packSealed(s: { iv: Buffer; ciphertext: Buffer }): string {
  return `${s.iv.toString('base64url')}.${s.ciphertext.toString('base64url')}`;
}

export function unpackSealed(packed: string): { iv: Buffer; ciphertext: Buffer } {
  const [iv, ct] = packed.split('.');
  if (!iv || !ct) throw new Error('cofre: envelope malformado');
  return { iv: Buffer.from(iv, 'base64url'), ciphertext: Buffer.from(ct, 'base64url') };
}

/** Chave derivada para uma finalidade (ex.: índice cego), sem reutilizar a chave de cifra. */
export function deriveKey(key: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `liame:${purpose}`, 32));
}

/** Índice cego (ADR-014): HMAC do valor normalizado, para busca exata sem guardar o dado em claro. */
export function blindIndex(key: Buffer, normalizedValue: string): string {
  return createHmac('sha256', deriveKey(key, 'indice-cego')).update(normalizedValue, 'utf8').digest('hex');
}
