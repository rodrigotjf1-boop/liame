import path from 'node:path';
import type { NextConfig } from 'next';

// Cabeçalhos de segurança do webapp (security-hardening P1) e a CSP.
// CSP sem nonce: o app usa Cache Components (ADR-001), e nonce exige renderizar toda página por
// requisição. Os scripts inline que o React e o Next geram por página (payload do RSC, streaming) mudam a
// cada build: sem nonce, só passam com 'unsafe-inline' (testado: sem ele a hidratação quebra, React #412).
// O que a CSP ainda garante: script só do próprio app (com Subresource Integrity nos arquivos), nada de
// object, base, frame ou formulário para fora, conexão só com a API. A versão mais rígida (nonce, com as
// telas logadas renderizadas por requisição) está proposta em decisoes-design (changelog de 27/09/2026).
const isDev = process.env.NODE_ENV !== 'production';
const api = new URL(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').origin;

const csp = [
  "default-src 'self'",
  // No desenvolvimento, o React usa eval para mostrar os erros do servidor.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' ${api}${isDev ? ' ws:' : ''}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
];

const config: NextConfig = {
  // ADR-001: Cache Components desde o início; standalone para a imagem do EasyPanel.
  cacheComponents: true,
  output: 'standalone',
  // Monorepo: o rastreio de arquivos do standalone parte da raiz (o build roda em apps/web).
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Hash de cada script no build (integrity): permite a CSP rígida sem nonce e com páginas pré-renderizadas.
    sri: { algorithm: 'sha256' },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
