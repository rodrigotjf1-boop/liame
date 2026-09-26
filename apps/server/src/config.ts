import { z } from 'zod';

// Configuração lida do ambiente e validada na subida: valor errado derruba o boot, não a requisição.
const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Origem do webapp: links dos e-mails e checagem de origem das mutações. */
  APP_URL: z.url().default('http://localhost:3000'),
  /** Origens aceitas em requisições que mudam dado (além do APP_URL), separadas por vírgula. */
  ALLOWED_ORIGINS: z.string().default(''),
  /** Cookie só por HTTPS. Desligar apenas em desenvolvimento local. */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /** Checagem de senha vazada (Have I Been Pwned, k-anonimato). */
  BREACHED_PASSWORD_CHECK: z.enum(['on', 'off']).default('on'),
  /** Transporte de e-mail: `memoria` (desenvolvimento e testes) ou `ses` (produção, quando a conta AWS existir). */
  MAIL_TRANSPORT: z.enum(['memoria', 'ses']).default('memoria'),
  /** Webhooks de saída para rede privada/loopback: só em desenvolvimento e testes (SSRF). */
  WEBHOOK_ALLOW_PRIVATE_NETWORK: z.enum(['true', 'false']).default('false'),
  /** Segredos Standard Webhooks por provedor da inbox: `regem:whsec_...,regemcast:whsec_...`. */
  INBOX_SECRETS: z.string().default(''),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  appUrl: string;
  allowedOrigins: Set<string>;
  cookieSecure: boolean;
  breachedPasswordCheck: boolean;
  mailTransport: 'memoria' | 'ses';
  webhookAllowPrivateNetwork: boolean;
  /** Provedor da inbox → segredo de assinatura. Provedor fora daqui recebe 404. */
  inboxSecrets: ReadonlyMap<string, string>;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = Env.parse(source);
  const appUrl = new URL(env.APP_URL).origin;
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'memoria') {
    throw new Error('config: em produção, MAIL_TRANSPORT precisa ser um transporte real');
  }
  if (env.NODE_ENV === 'production' && env.WEBHOOK_ALLOW_PRIVATE_NETWORK === 'true') {
    throw new Error('config: em produção, webhook para rede privada não é permitido (SSRF)');
  }
  const inboxSecrets = new Map<string, string>();
  for (const part of env.INBOX_SECRETS.split(',').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    const provider = part.slice(0, i);
    if (i < 1 || !/^[a-z0-9_-]+$/.test(provider)) throw new Error('config: INBOX_SECRETS no formato provedor:segredo');
    inboxSecrets.set(provider, part.slice(i + 1));
  }
  return {
    env: env.NODE_ENV,
    appUrl,
    allowedOrigins: new Set([appUrl, ...env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)]),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    breachedPasswordCheck: env.BREACHED_PASSWORD_CHECK === 'on',
    mailTransport: env.MAIL_TRANSPORT,
    webhookAllowPrivateNetwork: env.WEBHOOK_ALLOW_PRIVATE_NETWORK === 'true',
    inboxSecrets,
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
