import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Testes das regras puras do web (formatos, frases) e do desenho de telas com dados prontos, pelo React no
// servidor (`renderToStaticMarkup`, sem DOM). As telas também são conferidas no navegador (docs/testes.md).
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['test/**/*.spec.ts'], environment: 'node' },
});
