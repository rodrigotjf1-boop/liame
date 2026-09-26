import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // O transformador padrão do Vite não emite metadados de decorators, e a DI do Nest depende deles.
    swc.vite({
      module: { type: 'es6' },
      jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } },
    }),
  ],
  test: {
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
