import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Os dois leitores de corpo que o Nest liga sozinho (JSON e formulário), com as opções de antes e sem descomprimir. O
 * body-parser 2 abre `gzip`, `deflate` e `br` por padrão em toda rota, inclusive as públicas (o aviso do Asaas, a inbox,
 * o login), e o decodificador do Brotli é a peça do Node que o boletim de 21/10/2026 corrigiu (LIC-451). Nenhum remetente
 * do Liame comprime o corpo (o navegador, o Regem, o RegemCast, o Hub DMS e o Asaas, conferidos em 24/10/2026): o pedido
 * comprimido recebe 415 em problem+json, como a compressão desconhecida (ERR-144), antes de chegar à rota.
 *
 * Registrados aqui, antes do `init`, eles ocupam o lugar dos padrão: o Nest só acrescenta o leitor cujo nome
 * (`jsonParser`, `urlencodedParser`) ainda não está na pilha. O corpo cru (`rawBody`) segue as opções da aplicação.
 */
export function leitorDoCorpoSemCompressao(app: INestApplication): void {
  // O adaptador do Liame é sempre o do Express (`@nestjs/platform-express`).
  const express = app as NestExpressApplication;
  express.useBodyParser('json', { inflate: false });
  express.useBodyParser('urlencoded', { extended: true, inflate: false });
}
