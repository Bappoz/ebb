import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Testa contra os fontes do store, para a suíte nunca depender de build.
      '@ebb/store': fileURLToPath(new URL('../store/src/index.ts', import.meta.url)),
    },
  },
});
