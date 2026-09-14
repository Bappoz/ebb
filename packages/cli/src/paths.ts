import { resolve } from 'node:path';

/** Onde o banco mora quando ninguém disse. */
export const DEFAULT_STORE_PATH = '.ebb/ebb.db';

/**
 * Resolve o caminho do banco, na ordem: `--store`, `EBB_STORE`, padrão.
 *
 * O padrão é relativo ao diretório de trabalho de propósito: um projeto tem o
 * seu `.ebb/`, como tem o seu `node_modules/`, e trocar de projeto não leva
 * junto o que foi publicado no outro.
 */
export function resolveStorePath(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const chosen = flag ?? env.EBB_STORE ?? DEFAULT_STORE_PATH;
  return chosen === ':memory:' ? chosen : resolve(cwd, chosen);
}
