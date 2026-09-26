import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

// POST para URL de terceiro (webhook de saída) sem virar porta para a rede interna (SSRF,
// security-model): só http(s), sem redirecionamento, e o endereço resolvido não pode ser privado,
// de loopback, link-local ou reservado — checado na hora da conexão (vale contra DNS rebinding).

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  // NAT64 (64:ff9b::/96) leva a IPv4 por trás de um gateway.
  ['64:ff9b::', 96],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return PRIVATE.check(address, 'ipv4');
  if (family === 6) {
    // IPv4 mapeado em IPv6, nas formas ::ffff:10.0.0.1 e ::ffff:a00:1.
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (dotted?.[1]) return PRIVATE.check(dotted[1], 'ipv4');
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
    if (hex?.[1] && hex[2]) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return PRIVATE.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return PRIVATE.check(address, 'ipv6');
  }
  return true;
}

export class UnsafeUrlError extends Error {}

export interface SafePostOptions {
  /** Só em desenvolvimento e testes: libera rede privada (o receptor de teste roda em 127.0.0.1). */
  allowPrivateNetwork: boolean;
  timeoutMs?: number;
}

export interface SafePostResult {
  status: number;
}

/** Confere a URL antes de gravar (cadastro do endpoint) e antes de enviar. */
export function assertSafeUrl(raw: string, allowPrivateNetwork: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('URL inválida');
  }
  if (url.protocol !== 'https:' && !(allowPrivateNetwork && url.protocol === 'http:')) {
    throw new UnsafeUrlError('use uma URL https');
  }
  if (url.username || url.password) throw new UnsafeUrlError('a URL não pode ter usuário e senha');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateNetwork && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host)))) {
    throw new UnsafeUrlError('a URL aponta para a rede interna');
  }
  return url;
}

export async function safePost(rawUrl: string, body: string, headers: Record<string, string>, options: SafePostOptions): Promise<SafePostResult> {
  const url = assertSafeUrl(rawUrl, options.allowPrivateNetwork);
  const guardedLookup = (
    hostname: string,
    opts: { all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err, opts.all ? [] : '');
      const allowed = options.allowPrivateNetwork ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
      if (!allowed.length) {
        return callback(Object.assign(new UnsafeUrlError('o nome resolve para a rede interna'), { code: 'EACCES' }), opts.all ? [] : '');
      }
      if (opts.all) return callback(null, allowed);
      return callback(null, allowed[0]!.address, allowed[0]!.family);
    });
  };
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body).toString(), 'user-agent': 'Liame-Webhooks/1', ...headers },
        lookup: guardedLookup as never,
        timeout: options.timeoutMs ?? 10_000,
      },
      (res) => {
        // O corpo da resposta não interessa: lê e descarta até 64 KB, para liberar a conexão.
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) res.destroy();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', reject);
    req.end(body);
  });
}
