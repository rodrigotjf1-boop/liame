import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { canonicalJson, sha256 } from './audit.js';

// Âncora diária da auditoria (ADR-011, base §13.3): uma raiz por dia (UTC) que resume a cabeça de
// todas as cadeias até o fim do dia, encadeada à raiz do dia anterior e publicada fora do banco.

export const ANCHOR_GENESIS = sha256('liame:auditoria:ancora:inicio');

export type ChainHead = {
  chain_key: string;
  chain_seq: number | string;
  hash: string;
};

/** Raiz do dia: sal interno + raiz anterior + dia + cabeças das cadeias em ordem. */
export function computeRoot(salt: string, prevRoot: string, day: string, heads: ChainHead[]): string {
  const lines = [...heads]
    .sort((a, b) => (a.chain_key < b.chain_key ? -1 : a.chain_key > b.chain_key ? 1 : 0))
    .map((h) => `${h.chain_key}:${Number(h.chain_seq)}:${h.hash}`);
  return sha256(`${salt}\n${prevRoot}\n${day}\n${lines.join('\n')}`);
}

/** O que se publica (e se assina): só hashes, nunca conteúdo (o Rekor é público e permanente). */
export function anchorStatement(day: string, rootHash: string, prevRootHash: string): Buffer {
  return Buffer.from(canonicalJson({ liame_audit_anchor: 1, day, root_hash: rootHash, prev_root_hash: prevRootHash }), 'utf8');
}

// ------------------------------------------------------------------ RFC 3161 (DER à mão, só o necessário)

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derInteger(value: Buffer): Buffer {
  let v = value;
  while (v.length > 1 && v[0] === 0 && (v[1]! & 0x80) === 0) v = v.subarray(1);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return der(0x02, v);
}

const SHA256_ALGORITHM = Buffer.from('300d06096086480165030402010500', 'hex');

/**
 * TimeStampReq (RFC 3161 §2.4.1): versão 1, impressão SHA-256 da declaração, nonce aleatório e
 * pedido do certificado da TSA na resposta.
 */
export function buildTimeStampRequest(statement: Buffer, nonce: Buffer = randomBytes(8)): { der: Buffer; nonce: Buffer } {
  const digest = createHash('sha256').update(statement).digest();
  const messageImprint = der(0x30, Buffer.concat([SHA256_ALGORITHM, der(0x04, digest)]));
  const body = Buffer.concat([derInteger(Buffer.from([1])), messageImprint, derInteger(nonce), Buffer.from([0x01, 0x01, 0xff])]);
  return { der: der(0x30, body), nonce };
}

/** Lê o `PKIStatus` do TimeStampResp: 0 (concedido) e 1 (concedido com mudanças) valem. */
export function timeStampStatus(response: Buffer): number {
  // TimeStampResp ::= SEQUENCE { status PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }, token ... }
  let i = 0;
  const readHeader = (expectedTag: number): number => {
    if (response[i] !== expectedTag) throw new Error('resposta RFC 3161 inválida');
    i++;
    let len = response[i++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | response[i++]!;
    }
    return len;
  };
  readHeader(0x30);
  readHeader(0x30);
  const len = readHeader(0x02);
  let status = 0;
  for (let k = 0; k < len; k++) status = (status << 8) | response[i++]!;
  return status;
}

// ------------------------------------------------------------------ publicadores

export interface Publication {
  rekorLogIndex?: number;
  rekorEntry?: string;
  tsaResponse?: string;
}

export interface AnchorPublisher {
  readonly name: 'rekor' | 'tsa';
  publish(statement: Buffer): Promise<Publication>;
}

async function post(url: string, body: string | Uint8Array, contentType: string, timeoutMs: number): Promise<Response> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} respondeu HTTP ${res.status}`);
  return res;
}

/** Sigstore Rekor v2 (base §13.3): `hashedRekordRequestV002` assinado com ECDSA P-256. */
export class RekorPublisher implements AnchorPublisher {
  readonly name = 'rekor' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly signingKeyPem: string,
  ) {}

  async publish(statement: Buffer): Promise<Publication> {
    const key = createPrivateKey(this.signingKeyPem);
    const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' });
    const request = {
      hashedRekordRequestV002: {
        digest: createHash('sha256').update(statement).digest('base64'),
        signature: {
          content: sign('sha256', statement, key).toString('base64'),
          verifier: { publicKey: { rawBytes: publicDer.toString('base64') }, keyDetails: 'PKIX_ECDSA_P256_SHA_256' },
        },
      },
    };
    // A v2 agrupa pedidos: tempo limite de pelo menos 20 s (base §13.3).
    const res = await post(`${this.baseUrl.replace(/\/$/, '')}/api/v2/log/entries`, JSON.stringify(request), 'application/json', 30_000);
    const entry = (await res.json()) as { logIndex?: string | number };
    return { rekorLogIndex: Number(entry.logIndex ?? -1), rekorEntry: JSON.stringify(entry) };
  }
}

/** Carimbo de tempo RFC 3161: o Rekor v2 não dá tempo (`integratedTime` = 0), então o tempo vem daqui. */
export class TsaPublisher implements AnchorPublisher {
  readonly name = 'tsa' as const;

  constructor(private readonly url: string) {}

  async publish(statement: Buffer): Promise<Publication> {
    const { der: request } = buildTimeStampRequest(statement);
    const res = await post(this.url, new Uint8Array(request), 'application/timestamp-query', 20_000);
    const response = Buffer.from(await res.arrayBuffer());
    const status = timeStampStatus(response);
    if (status !== 0 && status !== 1) throw new Error(`carimbo recusado pela TSA (status ${status})`);
    return { tsaResponse: response.toString('base64') };
  }
}
