import { defineConfig } from 'vite';

/**
 * Em `npm run dev -w @ebb/console`, a api é o `ebb console` rodando ao lado
 * (porta padrão): o proxy mantém o `Host` de loopback, que a api exige.
 */
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:4321' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
