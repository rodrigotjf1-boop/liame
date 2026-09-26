import path from 'node:path';
import type { NextConfig } from 'next';

// Cabeçalhos de segurança do webapp (security-hardening P1). A CSP com nonce entra com as telas.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
];

const config: NextConfig = {
  // ADR-001: Cache Components desde o início; standalone para a imagem do EasyPanel.
  cacheComponents: true,
  output: 'standalone',
  // Monorepo: o rastreio de arquivos do standalone parte da raiz (o build roda em apps/web).
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
