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
    // Cada cadastro/entrada roda o scrypt da senha (128 MB, parâmetros do OWASP; alguns testes fazem 14 seguidos).
    // Com um processo por núcleo mais o Postgres na mesma máquina, a suíte inteira local esgotava os 20 s:
    // metade dos núcleos e prazo maior. O teste confere o comportamento, não a velocidade.
    maxWorkers: '50%',
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
