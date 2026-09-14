import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      // Todo arquivo de fonte, não só os que um teste importou: arquivo sem
      // teste deve puxar o número para baixo, não sumir do relatório.
      all: true,
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/src/bin.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
