import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, serveApp } from '@ebb/api';
import type { EbbRuntime } from '@ebb/runtime';
import type { Store } from '@ebb/store';

/** O `dist/` ao lado de um `package.json`, se o build já tiver rodado. */
export function assetsBeside(packageJson: string): string | undefined {
  const dist = join(dirname(packageJson), 'dist');
  return existsSync(join(dist, 'index.html')) ? dist : undefined;
}

/**
 * O build do console, achado pelo pacote e não por caminho relativo ao CLI:
 * funciona igual no workspace e num install.
 */
export function consoleAssets(): string | undefined {
  try {
    return assetsBeside(fileURLToPath(import.meta.resolve('@ebb/console/package.json')));
  } catch {
    // Pacote não instalado: mesmo tratamento de build ausente.
    return undefined;
  }
}

/**
 * Sobe a api com o console e fica até `SIGINT`/`SIGTERM`. Resolve com o
 * código de saída depois de fechar o servidor — o store é do chamador.
 */
export async function runConsole(options: {
  store: Store;
  runtime: EbbRuntime;
  port: number;
  assets: string;
  log?: (line: string) => void;
}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const app = createApp({ store: options.store, runtime: options.runtime, assets: options.assets });
  const running = await serveApp(app, { port: options.port });
  log(`console em ${running.url} — Ctrl+C para sair`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.close();
  return 0;
}
