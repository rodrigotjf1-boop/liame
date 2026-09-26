import createClient, { type ClientOptions } from 'openapi-fetch';
import type { components, paths } from './schema.js';

export type { components, paths };

/** Erro da API no formato RFC 9457 (arquitetura §14). */
export type ProblemDetails = components['schemas'] extends { ProblemDetails: infer P } ? P : Record<string, unknown>;

/**
 * Cliente tipado da API do Liame. Os tipos vêm do contrato OpenAPI 3.1 (`docs/openapi.json`),
 * regerados a cada build: se o contrato mudar de forma incompatível, o uso quebra na compilação.
 */
export function createLiameClient(options: ClientOptions & { baseUrl: string }) {
  return createClient<paths>(options);
}

export type LiameClient = ReturnType<typeof createLiameClient>;
