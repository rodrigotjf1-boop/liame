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
  /** Sal interno da raiz diária da auditoria (ADR-011). Em produção, obrigatório e secreto. */
  AUDIT_ANCHOR_SALT: z.string().min(16).optional(),
  /** Chave privada ECDSA P-256 (PEM PKCS#8) que assina a declaração publicada no Rekor. */
  AUDIT_ANCHOR_SIGNING_KEY: z.string().optional(),
  /** Log Rekor v2 (o shard muda: vem da configuração, base §13.3). Ex.: https://log2025-1.rekor.sigstore.dev */
  REKOR_URL: z.url().optional(),
  /** Carimbo de tempo RFC 3161. Ex.: https://timestamp.sigstore.dev/api/v1/timestamp */
  TSA_URL: z.url().optional(),
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
  auditAnchor: {
    salt: string;
    signingKeyPem: string | null;
    rekorUrl: string | null;
    tsaUrl: string | null;
  };
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
  if (env.NODE_ENV === 'production' && (!env.AUDIT_ANCHOR_SALT || !env.REKOR_URL || !env.AUDIT_ANCHOR_SIGNING_KEY || !env.TSA_URL)) {
    throw new Error('config: em produção, a âncora da auditoria precisa de AUDIT_ANCHOR_SALT, REKOR_URL, AUDIT_ANCHOR_SIGNING_KEY e TSA_URL');
  }
  if (env.REKOR_URL && !env.AUDIT_ANCHOR_SIGNING_KEY) throw new Error('config: REKOR_URL exige AUDIT_ANCHOR_SIGNING_KEY');
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
    auditAnchor: {
      // Fora de produção, um sal fixo e conhecido: as raízes precisam se repetir entre execuções.
      salt: env.AUDIT_ANCHOR_SALT ?? 'liame-sal-de-desenvolvimento-nao-secreto',
      // PEM numa linha só (variável de ambiente): "\n" literal vira quebra de linha.
      signingKeyPem: env.AUDIT_ANCHOR_SIGNING_KEY?.replace(/\\n/g, '\n') ?? null,
      rekorUrl: env.REKOR_URL ?? null,
      tsaUrl: env.TSA_URL ?? null,
    },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
