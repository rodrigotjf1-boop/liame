import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
