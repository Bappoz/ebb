import type { Options } from 'tsup';

/**
 * Configuração de build compartilhada.
 *
 * `bundle: false` de propósito: aqui se publica biblioteca para Node, não
 * bundle para navegador. Empacotar não economizaria nada e custa surpresa —
 * o esbuild normaliza `node:fs` para `fs`, o que é inofensivo, e `node:sqlite`
 * para `sqlite`, o que não resolve e só aparece ao rodar o binário construído.
 * Sem bundle, cada arquivo vira um arquivo e o import sai como foi escrito.
 */
export function tsupBase(entry: string[]): Options {
  return {
    entry,
    format: ['esm'],
    bundle: false,
    sourcemap: true,
    clean: true,
    platform: 'node',
    target: 'node24',
  };
}
