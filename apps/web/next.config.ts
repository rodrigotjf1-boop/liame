import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // ADR-001: Cache Components desde o início; standalone para a imagem do EasyPanel.
  cacheComponents: true,
  output: 'standalone',
  // Monorepo: o rastreio de arquivos do standalone parte da raiz (o build roda em apps/web).
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
