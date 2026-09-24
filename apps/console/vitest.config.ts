import { defineConfig } from 'vitest/config';

// Só a lógica pura roda aqui (timeline, wire), em Node: o DOM é verificado no
// navegador, não simulado.
export default defineConfig({ test: { environment: 'node' } });
