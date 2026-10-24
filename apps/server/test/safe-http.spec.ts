import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ResponseTooLargeError, safeGet, UnsupportedEncodingError } from '../src/events/safe-http.js';

// A compressão do GET de página de terceiro (o Pesquisador): o boletim do Node de 21/10/2026 corrigiu o decodificador
// do Brotli, e a página que a pessoa informa é o texto menos confiável que o Liame lê (LIC-451). O GET pede só gzip e
// deflate; a compressão que ele não pediu recusa a resposta, em vez de passar o corpo comprimido como texto.

const PAGINA = '<html><body><p>Smash Clássico, R$ 29,90</p></body></html>';

describe('safeGet: a compressão da resposta', () => {
  let site: Server;
  let base: string;
  let pedido: IncomingHttpHeaders = {};

  const ler = (caminho: string, maxBytes = 100_000) =>
    safeGet(`${base}${caminho}`, { allowPrivateNetwork: true, timeoutMs: 5_000, maxBytes, maxRedirects: 2, userAgent: 'Liame (teste)', accept: 'text/html' });

  beforeAll(async () => {
    site = createServer((req, res) => {
      pedido = req.headers;
      const responder = (codificacao: string | null, corpo: Buffer | string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(codificacao === null ? {} : { 'content-encoding': codificacao }) });
        res.end(corpo);
      };
      switch (req.url) {
        case '/simples':
          return responder(null, PAGINA);
        case '/identity':
          return responder('identity', PAGINA);
        case '/gzip':
          return responder('gzip', gzipSync(PAGINA));
        case '/deflate':
          return responder('deflate', deflateSync(PAGINA));
        // O servidor que manda Brotli sem ter sido pedido (fora do RFC 9110, mas acontece em CDN mal configurada).
        case '/brotli':
          return responder('br', brotliCompressSync(PAGINA));
        case '/brotli-maiusculo':
          return responder(' BR ', brotliCompressSync(PAGINA));
        case '/zstd':
          return responder('zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0, 0]));
        case '/duas':
          return responder('gzip, br', brotliCompressSync(gzipSync(PAGINA)));
        // A bomba: pequena comprimida, grande depois de aberta.
        case '/bomba':
          return responder('gzip', gzipSync(Buffer.alloc(2_000_000, 0x61)));
        default:
          res.writeHead(404);
          return res.end();
      }
    });
    await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((ok) => site.close(() => ok()));
  });

  it('pede só gzip e deflate: o Brotli não vai no Accept-Encoding', async () => {
    await ler('/simples');
    expect(pedido['accept-encoding']).toBe('gzip, deflate');
  });

  it.each(['/simples', '/identity', '/gzip', '/deflate'])('%s: o corpo chega aberto', async (caminho) => {
    const r = await ler(caminho);
    expect(r.status).toBe(200);
    expect(r.body.toString('utf8')).toBe(PAGINA);
  });

  it.each(['/brotli', '/brotli-maiusculo', '/zstd', '/duas'])('%s: a compressão que não pedimos recusa a resposta', async (caminho) => {
    await expect(ler(caminho)).rejects.toBeInstanceOf(UnsupportedEncodingError);
  });

  it('o tamanho máximo vale para o que sai da descompressão', async () => {
    await expect(ler('/bomba', 100_000)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
