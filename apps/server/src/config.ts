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
  /** Remetente dos e-mails do serviço (endereço do domínio verificado no SES; nome opcional: `Liame <nao-responda@...>`). */
  MAIL_FROM: z.string().trim().min(3).max(200).default('Liame <nao-responda@agencialiame.com>'),
  /** Região do SES (a mesma do KMS). */
  AWS_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).default('sa-east-1'),
  /** Conjunto de configuração do SES (eventos de entrega); vazio = sem conjunto. */
  SES_CONFIGURATION_SET: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
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
  /** Versão publicada dos Termos de Uso e da Política de Privacidade (o cadastro grava a que foi aceita). */
  TERMS_VERSION: z.string().trim().min(1).max(60).optional(),
  TERMS_URL: z.url().default('https://agencialiame.com/termos'),
  /** Endereços das plataformas: fixos em produção; fora dela, trocáveis para os testes com respostas gravadas. */
  META_GRAPH_URL: z.url().default('https://graph.facebook.com'),
  GOOGLE_ADS_URL: z.url().default('https://googleads.googleapis.com'),
  GA4_DATA_URL: z.url().default('https://analyticsdata.googleapis.com'),
  GA4_ADMIN_URL: z.url().default('https://analyticsadmin.googleapis.com'),
  /** Segredo do app da Meta (da distribuição): assina as chamadas com appsecret_proof. */
  META_APP_SECRET: z.string().min(16).optional(),
  /** Origem pública da API: monta o endereço de volta do OAuth (registrado no app de cada plataforma). */
  API_URL: z.url().default('http://localhost:3001'),
  /** App da Meta (da distribuição) e a configuração do Facebook Login for Business (token de usuário do sistema). */
  META_APP_ID: z.string().regex(/^\d{5,25}$/).optional(),
  META_LOGIN_CONFIG_ID: z.string().regex(/^\d{5,25}$/).optional(),
  META_DIALOG_URL: z.url().default('https://www.facebook.com'),
  /** Cliente OAuth do Google (da distribuição): Google Ads e GA4 na mesma autorização. */
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(10).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(10).optional(),
  GOOGLE_AUTH_URL: z.url().default('https://accounts.google.com'),
  GOOGLE_TOKEN_URL: z.url().default('https://oauth2.googleapis.com'),
  PRIVACY_URL: z.url().default('https://agencialiame.com/privacidade'),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  appUrl: string;
  allowedOrigins: Set<string>;
  cookieSecure: boolean;
  breachedPasswordCheck: boolean;
  mailTransport: 'memoria' | 'ses';
  /** Remetente e SES (usados só com `mailTransport = 'ses'`). */
  mail: { from: string; fromAddress: string; region: string; configurationSet: string | null };
  webhookAllowPrivateNetwork: boolean;
  /** Provedor da inbox → segredo de assinatura. Provedor fora daqui recebe 404. */
  inboxSecrets: ReadonlyMap<string, string>;
  auditAnchor: {
    salt: string;
    signingKeyPem: string | null;
    rekorUrl: string | null;
    tsaUrl: string | null;
  };
  /** Termos vigentes (A0-6): versão e endereços públicos. */
  terms: { version: string; termsUrl: string; privacyUrl: string };
  /** Plataformas (A2): endereço de cada API e o que assina as chamadas. */
  plataformas: { metaGraphUrl: string; googleAdsUrl: string; ga4DataUrl: string; ga4AdminUrl: string; metaAppSecret: string | null };
  /** Origem pública da API (volta do OAuth). */
  apiUrl: string;
  /** Apps OAuth da distribuição; nulo = a plataforma ainda não pode ser conectada. */
  oauth: {
    meta: { appId: string; appSecret: string; configId: string; dialogUrl: string } | null;
    google: { clientId: string; clientSecret: string; authUrl: string; tokenUrl: string } | null;
  };
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = Env.parse(source);
  const appUrl = new URL(env.APP_URL).origin;
  // Fail-fast (security-hardening P1): em produção, origem do app explícita e só por HTTPS, cookie seguro.
  if (env.NODE_ENV === 'production') {
    if (!source.APP_URL) throw new Error('config: em produção, defina APP_URL (origem do webapp)');
    const origins = [appUrl, ...env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)];
    if (origins.some((o) => !o.startsWith('https://'))) throw new Error('config: em produção, APP_URL e ALLOWED_ORIGINS só com https');
    if (env.COOKIE_SECURE === 'false') throw new Error('config: em produção, o cookie de sessão precisa ser só-HTTPS (COOKIE_SECURE)');
  }
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
  const OFICIAIS: Record<string, string> = {
    META_GRAPH_URL: 'https://graph.facebook.com',
    GOOGLE_ADS_URL: 'https://googleads.googleapis.com',
    GA4_DATA_URL: 'https://analyticsdata.googleapis.com',
    GA4_ADMIN_URL: 'https://analyticsadmin.googleapis.com',
    META_DIALOG_URL: 'https://www.facebook.com',
    GOOGLE_AUTH_URL: 'https://accounts.google.com',
    GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com',
  };
  if (env.NODE_ENV === 'production') {
    for (const [nome, oficial] of Object.entries(OFICIAIS)) {
      if (env[nome as keyof typeof env] !== oficial) throw new Error(`config: em produção, ${nome} é o endereço oficial (${oficial})`);
    }
  }
  const meta = env.META_APP_ID && env.META_APP_SECRET && env.META_LOGIN_CONFIG_ID
    ? { appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, configId: env.META_LOGIN_CONFIG_ID, dialogUrl: env.META_DIALOG_URL.replace(/\/$/, '') }
    : null;
  const google = env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
    ? { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, authUrl: env.GOOGLE_AUTH_URL.replace(/\/$/, ''), tokenUrl: env.GOOGLE_TOKEN_URL.replace(/\/$/, '') }
    : null;
  const apiUrl = new URL(env.API_URL).origin;
  // A volta do OAuth leva o código da plataforma: em produção, só por HTTPS e com a origem declarada.
  if (env.NODE_ENV === 'production' && (meta || google) && (!source.API_URL || !apiUrl.startsWith('https://'))) {
    throw new Error('config: em produção, com app OAuth configurado, defina API_URL com https');
  }
  // Ninguém cria conta em produção aceitando termos que não foram publicados (A0-6).
  if (env.NODE_ENV === 'production' && (!env.TERMS_VERSION || !source.TERMS_URL || !source.PRIVACY_URL)) {
    throw new Error('config: em produção, defina TERMS_VERSION, TERMS_URL e PRIVACY_URL (termos publicados)');
  }
  const fromAddress = enderecoDoRemetente(env.MAIL_FROM);
  if (!fromAddress) throw new Error('config: MAIL_FROM precisa ser um e-mail (com ou sem nome: "Liame <nao-responda@dominio>")');
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'ses' && !source.MAIL_FROM) {
    throw new Error('config: em produção, defina MAIL_FROM (remetente do domínio verificado no SES)');
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
    mail: { from: env.MAIL_FROM, fromAddress, region: env.AWS_REGION, configurationSet: env.SES_CONFIGURATION_SET ?? null },
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
    terms: { version: env.TERMS_VERSION ?? TERMS_VERSION_DEV, termsUrl: env.TERMS_URL, privacyUrl: env.PRIVACY_URL },
    plataformas: {
      metaGraphUrl: env.META_GRAPH_URL.replace(/\/$/, ''),
      googleAdsUrl: env.GOOGLE_ADS_URL.replace(/\/$/, ''),
      ga4DataUrl: env.GA4_DATA_URL.replace(/\/$/, ''),
      ga4AdminUrl: env.GA4_ADMIN_URL.replace(/\/$/, ''),
      metaAppSecret: env.META_APP_SECRET ?? null,
    },
    apiUrl,
    oauth: { meta, google },
  };
}

/** Endereço do remetente, com ou sem nome ("Liame <x@y>" → "x@y"); nulo se não for um e-mail. */
export function enderecoDoRemetente(from: string): string | null {
  const m = /^(?:[^<>]*<([^<>\s]+)>|([^<>\s]+))$/.exec(from.trim());
  const address = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
  return /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(address) ? address : null;
}

/** Versão dos termos fora de produção (rascunho v0.1 de docs/juridico, ainda não publicado). */
export const TERMS_VERSION_DEV = 'rascunho-2026-09-25';

export const APP_CONFIG = Symbol('APP_CONFIG');
