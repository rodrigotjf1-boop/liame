import path from 'node:path';
import type { NextConfig } from 'next';
import { cspPublica, ROTAS_PUBLICAS } from './src/lib/csp';

// Cabeçalhos de segurança do webapp (security-hardening P1) e a CSP das telas de entrada.
// As telas de entrada são pré-renderizadas (Cache Components, ADR-001): a CSP delas vai aqui, fixa.
// Todas as outras rotas recebem a CSP com nonce no proxy (src/proxy.ts), a cada requisição.
const isDev = process.env.NODE_ENV !== 'production';
const api = new URL(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').origin;

const securityHeaders = [
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
    // Hash de cada script do build (integrity), nas duas CSPs.
    sri: { algorithm: 'sha256' },
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      ...ROTAS_PUBLICAS.map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: cspPublica({ isDev, api }) }] })),
    ];
  },
};

export default config;
