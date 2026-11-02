import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

// O lacre do documento da recuperação da conta (A7, W8, parte 4a; D-A7-64; D-A7-85). O servidor cifra o arquivo com uma
// chave AES-256-GCM nova e embrulha essa chave com a chave PÚBLICA da DMS (RSA-OAEP com SHA-256). A chave privada fica
// só com a DMS, fora do servidor: nem o banco, nem a API, nem quem lê o banco abre o documento. Só o comando da
// distribuição (`recuperacao-da-conta`), com a chave privada, abre para conferir.

/** O tamanho mínimo da chave RSA da DMS. */
export const MENOR_CHAVE_RSA = 3072;

export type Lacrado = { keyId: string; wrappedKey: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer };

/**
 * A chave pública da DMS, como vem do ambiente (`RECUPERACAO_CHAVE_PUBLICA`): o DER (SPKI) em base64, numa linha, ou o
 * PEM. Recusa o que não é RSA com pelo menos 3.072 bits.
 */
export function chavePublicaDaDms(texto: string): KeyObject {
  const limpo = texto.trim();
  const chave = limpo.startsWith('-----BEGIN')
    ? createPublicKey(limpo.replace(/\\n/g, '\n'))
    : createPublicKey({ key: Buffer.from(limpo, 'base64'), format: 'der', type: 'spki' });
  if (chave.asymmetricKeyType !== 'rsa' || (chave.asymmetricKeyDetails?.modulusLength ?? 0) < MENOR_CHAVE_RSA) {
    throw new Error(`a chave pública da recuperação precisa ser RSA com pelo menos ${MENOR_CHAVE_RSA} bits`);
  }
  return chave;
}

/** A impressão digital da chave pública: os 16 primeiros caracteres do SHA-256 do DER (SPKI). */
export function impressaoDigital(publica: KeyObject): string {
  return createHash('sha256').update(publica.export({ format: 'der', type: 'spki' })).digest('hex').slice(0, 16);
}

/** Lacra o arquivo com a chave pública da DMS. */
export function lacrar(publica: KeyObject, bytes: Buffer): Lacrado {
  const chave = randomBytes(32);
  const iv = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', chave, iv);
  const ciphertext = Buffer.concat([cifra.update(bytes), cifra.final()]);
  const tag = cifra.getAuthTag();
  const wrappedKey = publicEncrypt({ key: publica, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, chave);
  chave.fill(0);
  return { keyId: impressaoDigital(publica), wrappedKey, iv, tag, ciphertext };
}

/** Abre o lacre com a chave privada da DMS (só o comando da distribuição). Recusa a chave que não é a do lacre. */
export function abrir(privada: KeyObject, lacrado: Lacrado): Buffer {
  const publica = createPublicKey(privada);
  if (impressaoDigital(publica) !== lacrado.keyId) throw new Error('esta chave privada não é a que lacrou o documento');
  const chave = privateDecrypt({ key: privada, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, lacrado.wrappedKey);
  const decifra = createDecipheriv('aes-256-gcm', chave, lacrado.iv);
  decifra.setAuthTag(lacrado.tag);
  const bytes = Buffer.concat([decifra.update(lacrado.ciphertext), decifra.final()]);
  chave.fill(0);
  return bytes;
}

/** A chave privada da DMS, do arquivo PEM que o comando `--gerar-chaves` gravou. */
export function chavePrivadaDaDms(pem: string): KeyObject {
  const chave = createPrivateKey(pem);
  if (chave.asymmetricKeyType !== 'rsa') throw new Error('a chave privada da recuperação precisa ser RSA');
  return chave;
}

/** Um par novo para a DMS: a pública em base64 (para o ambiente da API) e a privada em PEM (só com a DMS). */
export function gerarChaves(bits = 4096): { publica: string; privadaPem: string; keyId: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    publica: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privadaPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyId: impressaoDigital(publicKey),
  };
}
