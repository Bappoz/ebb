#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { SqliteStore } from '@ebb/store';
import { deploy, list, versions } from './commands.js';
import { resolveStorePath } from './paths.js';

const USAGE = `ebb — processos BPMN que você pode rebobinar

  ebb deploy <arquivo.bpmn> [--force]   valida e publica uma definição
  ebb ls                                o que está publicado
  ebb versions <chave>                  o histórico de uma definição

Opções:
  --store <arquivo>   onde fica o banco (padrão: .ebb/ebb.db, ou $EBB_STORE)
  --force             publica mesmo com aviso de validação
`;

/** Valor de uma opção `--nome valor`. */
function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  const store = new SqliteStore({ path: resolveStorePath(option(argv, 'store')) });
  try {
    switch (command) {
      case 'deploy': {
        const file = argv[1];
        if (!file || file.startsWith('--')) {
          console.error(`Informe o arquivo.\n\n${USAGE}`);
          return 2;
        }
        const result = await deploy(store, await readFile(file, 'utf8'), {
          source: file,
          force: argv.includes('--force'),
        });
        console.log(result.output);
        return result.exitCode;
      }
      case 'ls': {
        const result = await list(store);
        console.log(result.output);
        return result.exitCode;
      }
      case 'versions': {
        const key = argv[1];
        if (!key || key.startsWith('--')) {
          console.error(`Informe a chave do processo.\n\n${USAGE}`);
          return 2;
        }
        const result = await versions(store, key);
        console.log(result.output);
        return result.exitCode;
      }
      default:
        console.error(`Comando desconhecido "${command}".\n\n${USAGE}`);
        return 2;
    }
  } finally {
    store.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
