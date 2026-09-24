import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      // Todo arquivo de fonte, não só os que um teste importou: arquivo sem
      // teste deve puxar o número para baixo, não sumir do relatório.
      all: true,
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: [
        '**/src/bin.ts',
        // Fiação de navegador: DOM, fetch e o viewer. A lógica mora em
        // timeline.ts e wire.ts, que ficam na conta.
        'apps/console/src/main.ts',
        'apps/console/src/api.ts',
        'apps/console/src/diagram-view.ts',
      ],
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
