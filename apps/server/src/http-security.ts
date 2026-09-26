import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from './config.js';

// Borda HTTP da API (security-hardening P1, security-model §8): cabeçalhos de segurança em toda
// resposta, sem `X-Powered-By`, e CORS só para as origens do app, com credenciais (cookie de sessão).

interface Res {
  setHeader(name: string, value: string): void;
}

/** A API só devolve JSON: nada de ser embutida, farejada, cacheada ou usada como página. */
export function securityHeaders(config: Pick<AppConfig, 'cookieSecure'>) {
  return (_req: unknown, res: Res, next: () => void): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Resposta de API pode ter dado pessoal: nunca em cache de navegador ou proxy.
    res.setHeader('Cache-Control', 'no-store');
    // HSTS só quando o cookie já é só-HTTPS (produção): em desenvolvimento local, sem HTTPS, travaria o navegador.
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/** Cabeçalhos e CORS na aplicação Nest (Express). */
export function applyHttpSecurity(app: INestApplication, config: Pick<AppConfig, 'cookieSecure' | 'allowedOrigins'>): void {
  const instance = app.getHttpAdapter().getInstance() as { disable?: (setting: string) => void };
  instance.disable?.('x-powered-by');
  app.use(securityHeaders(config));
  app.enableCors({
    // Só as origens do app (APP_URL + ALLOWED_ORIGINS). Sem Origin (servidor a servidor, webhook), não há CORS.
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) =>
      callback(null, origin === undefined || config.allowedOrigins.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'idempotency-key', 'if-none-match'],
    exposedHeaders: ['etag', 'idempotent-replayed', 'retry-after'],
    maxAge: 600,
  });
}
