import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

// Um autenticador de mentira para os testes das chaves de acesso (A7, W9): gera um par P-256 (ES256), monta os dados do
// autenticador como o WebAuthn define (o hash do domínio, as marcas, o contador e, no cadastro, a credencial com a chave
// pública em COSE) e assina como um aparelho de verdade. O servidor confere tudo com a mesma biblioteca de produção.

const UP = 0x01; // a pessoa estava lá
const UV = 0x04; // o aparelho confirmou a pessoa (digital, rosto, PIN)
const BE = 0x08; // a chave pode ser copiada (sincroniza)
const BS = 0x10; // a cópia já está guardada
const AT = 0x40; // os dados da credencial vêm junto (cadastro)

const b64 = (b: Uint8Array) => isoBase64URL.fromBuffer(new Uint8Array(b));

export class AparelhoDeTeste {
  private readonly par = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credencial = randomBytes(32);
  contador = 0;
  /** O identificador da pessoa que o servidor mandou no cadastro: a chave o guarda e o devolve a cada uso. */
  usuario: string | null = null;

  constructor(
    readonly rpId: string,
    readonly origem: string,
    /** O gerenciador (AAGUID); zeros = o aparelho não diz. */
    readonly aaguid = '00000000-0000-0000-0000-000000000000',
    readonly sincroniza = true,
  ) {}

  get id(): string {
    return b64(this.credencial);
  }

  private dados(marcas: number, comCredencial: boolean): Buffer {
    const contador = Buffer.alloc(4);
    contador.writeUInt32BE(this.contador);
    const partes: Buffer[] = [createHash('sha256').update(this.rpId).digest(), Buffer.from([marcas]), contador];
    if (comCredencial) {
      const jwk = this.par.publicKey.export({ format: 'jwk' });
      const cose = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, isoBase64URL.toBuffer(jwk.x!)],
        [-3, isoBase64URL.toBuffer(jwk.y!)],
      ]);
      const tamanho = Buffer.alloc(2);
      tamanho.writeUInt16BE(this.credencial.length);
      partes.push(Buffer.from(this.aaguid.replace(/-/g, ''), 'hex'), tamanho, this.credencial, Buffer.from(isoCBOR.encode(cose)));
    }
    return Buffer.concat(partes);
  }

  private marcas(uv: boolean, comCredencial: boolean): number {
    return UP | (uv ? UV : 0) | (this.sincroniza ? BE | BS : 0) | (comCredencial ? AT : 0);
  }

  /** O cadastro: o que `navigator.credentials.create` devolveria para as opções do servidor. */
  criar(opcoes: Record<string, unknown>, o: { uv?: boolean; origem?: string } = {}): Record<string, unknown> {
    this.usuario = (opcoes.user as { id?: string } | undefined)?.id ?? null;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opcoes.challenge, origin: o.origem ?? this.origem, crossOrigin: false }));
    const atestado = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.dados(this.marcas(o.uv ?? true, true), true)],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), attestationObject: b64(atestado), transports: ['internal', 'hybrid'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /**
   * O uso: o que `navigator.credentials.get` devolveria, assinado com a chave privada do aparelho. Leva o identificador
   * da pessoa (`userHandle`), como a chave de acesso faz; `usuario` troca o que vai (nulo = não manda).
   */
  assinar(opcoes: Record<string, unknown>, o: { uv?: boolean; origem?: string; usuario?: string | null } = {}): Record<string, unknown> {
    const usuario = o.usuario === undefined ? this.usuario : o.usuario;
    this.contador += 1;
    const dados = this.dados(this.marcas(o.uv ?? true, false), false);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opcoes.challenge, origin: o.origem ?? this.origem, crossOrigin: false }));
    const assinatura = sign('sha256', Buffer.concat([dados, createHash('sha256').update(clientData).digest()]), this.par.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(dados), signature: b64(assinatura), ...(usuario ? { userHandle: usuario } : {}) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
