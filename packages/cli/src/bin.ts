#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { EbbRuntime } from '@ebb/runtime';
import { SqliteStore } from '@ebb/store';
import { deploy, list, versions } from './commands.js';
import {
  completeTask,
  listInstances,
  showInstance,
  showJournal,
  signalInstance,
  startInstance,
  tickInstance,
} from './instances.js';
import { listIncidents, listJobs, resolveIncident, retryTask } from './jobs.js';
import { resolveStorePath } from './paths.js';
import { parseVars } from './vars.js';
import { runWorker } from './worker.js';

const USAGE = `ebb — processos BPMN que você pode rebobinar

Definições:
  ebb deploy <arquivo.bpmn> [--force]   valida e publica uma definição
  ebb ls                                o que está publicado
  ebb versions <chave>                  o histórico de uma definição

Instâncias:
  ebb start <chave> [--version N]       instancia um processo publicado
  ebb ps                                as instâncias e o estado de cada uma
  ebb show <id>                         estado, variáveis e o que está pendente
  ebb complete <id> <token>             conclui uma tarefa parada
  ebb signal <id> <nome>                entrega um evento ao diagrama
  ebb tick <id> [--at <iso>]            dispara os timers vencidos
  ebb journal <id>                      os comandos aplicados, em ordem

Trabalho:
  ebb jobs                              o trabalho esperando worker
  ebb incidents                         o que parou por falha
  ebb retry <id> <token>                roda a atividade de novo a partir do incidente
  ebb resolve <id> <token>              desiste e segue como se tivesse dado certo
  ebb worker <tipo> -- <comando>        executa os jobs de um tipo

O <id> aceita qualquer prefixo único, como o git.

Opções:
  --store <arquivo>   onde fica o banco (padrão: .ebb/ebb.db, ou $EBB_STORE)
  --force             publica mesmo com aviso de validação
  --var chave=valor   variável de processo; JSON quando parseia, texto quando não
  --at <iso>          instante que o tick usa, em vez do relógio de parede
  --retries N         tentativas automáticas antes de virar incidente (padrão: 0)
  --once              (worker) uma rodada e sai, em vez de laço
  --lease <ms>        (worker) por quanto tempo o job fica travado (padrão: 60000)
  --interval <ms>     (worker) intervalo entre sondagens sem job (padrão: 1000)
  --count <n>         (worker) jobs por rodada (padrão: 1)
`;

/** Valor de uma opção `--nome valor`. */
function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Sentinela: a opção veio, mas não parseou como inteiro positivo. */
const INVALID = Symbol('invalid');

/** Opção `--nome N` como inteiro > 0, `undefined` quando ausente, `INVALID` quando inválida. */
function positiveInteger(argv: string[], name: string): number | undefined | typeof INVALID {
  const raw = option(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : INVALID;
}

function invalidOption(name: string, raw: string | undefined): string {
  return `--${name} esperava um inteiro positivo e veio "${raw ?? ''}".`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  const store = new SqliteStore({ path: resolveStorePath(option(argv, 'store')) });
  const runtime = new EbbRuntime({ store });
  try {
    switch (command) {
      case 'deploy': {
        const file = argv[1];
        if (!file || file.startsWith('--')) return usageError('Informe o arquivo.');
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
        if (!key || key.startsWith('--')) return usageError('Informe a chave do processo.');
        const result = await versions(store, key);
        console.log(result.output);
        return result.exitCode;
      }
      case 'start': {
        const key = argv[1];
        if (!key || key.startsWith('--')) return usageError('Informe a chave do processo.');
        const versionArg = option(argv, 'version');
        let version: number | undefined;
        if (versionArg !== undefined) {
          version = Number(versionArg);
          if (!Number.isInteger(version)) {
            return usageError(`--version esperava um inteiro e veio "${versionArg}".`);
          }
        }
        const retriesArg = option(argv, 'retries');
        let attempts: number | undefined;
        if (retriesArg !== undefined) {
          attempts = Number(retriesArg);
          if (!Number.isInteger(attempts) || attempts < 0) {
            return usageError(`--retries esperava um inteiro >= 0 e veio "${retriesArg}".`);
          }
        }
        const result = await startInstance(runtime, key, {
          variables: parseVars(argv),
          ...(version === undefined ? {} : { version }),
          ...(attempts === undefined ? {} : { engine: { retry: { attempts } } }),
        });
        console.log(result.output);
        return result.exitCode;
      }
      case 'ps': {
        const result = await listInstances(store);
        console.log(result.output);
        return result.exitCode;
      }
      case 'show': {
        const id = argv[1];
        if (!id || id.startsWith('--')) return usageError('Informe o id da instância.');
        const result = await showInstance(store, runtime, id);
        console.log(result.output);
        return result.exitCode;
      }
      case 'complete': {
        const id = argv[1];
        const token = argv[2];
        if (!id || id.startsWith('--') || !token || token.startsWith('--')) {
          return usageError('Informe o id da instância e o token da tarefa.');
        }
        const result = await completeTask(store, runtime, id, token, parseVars(argv));
        console.log(result.output);
        return result.exitCode;
      }
      case 'signal': {
        const id = argv[1];
        const name = argv[2];
        if (!id || id.startsWith('--') || !name || name.startsWith('--')) {
          return usageError('Informe o id da instância e o nome do evento.');
        }
        const result = await signalInstance(store, runtime, id, name, parseVars(argv));
        console.log(result.output);
        return result.exitCode;
      }
      case 'tick': {
        const id = argv[1];
        if (!id || id.startsWith('--')) return usageError('Informe o id da instância.');
        const iso = option(argv, 'at');
        const at = iso === undefined ? undefined : Date.parse(iso);
        if (at !== undefined && Number.isNaN(at)) {
          return usageError(`--at esperava uma data ISO-8601 e veio "${iso ?? ''}".`);
        }
        const result = await tickInstance(store, runtime, id, at);
        console.log(result.output);
        return result.exitCode;
      }
      case 'journal': {
        const id = argv[1];
        if (!id || id.startsWith('--')) return usageError('Informe o id da instância.');
        const result = await showJournal(store, id);
        console.log(result.output);
        return result.exitCode;
      }
      case 'jobs': {
        const result = await listJobs(store, {});
        console.log(result.output);
        return result.exitCode;
      }
      case 'incidents': {
        const result = await listIncidents(store, runtime);
        console.log(result.output);
        return result.exitCode;
      }
      case 'retry': {
        const id = argv[1];
        const token = argv[2];
        if (!id || id.startsWith('--') || !token || token.startsWith('--')) {
          return usageError('Informe o id da instância e o token da tarefa.');
        }
        const result = await retryTask(store, runtime, id, token);
        console.log(result.output);
        return result.exitCode;
      }
      case 'resolve': {
        const id = argv[1];
        const token = argv[2];
        if (!id || id.startsWith('--') || !token || token.startsWith('--')) {
          return usageError('Informe o id da instância e o token da tarefa.');
        }
        const result = await resolveIncident(store, runtime, id, token, parseVars(argv));
        console.log(result.output);
        return result.exitCode;
      }
      case 'worker': {
        const type = argv[1];
        if (!type || type.startsWith('--')) return usageError('Informe o tipo do job.');
        const separator = argv.indexOf('--');
        const command = separator >= 0 ? argv.slice(separator + 1) : [];
        if (command.length === 0) {
          return usageError('Informe o comando depois de --.');
        }
        const flags = argv.slice(0, separator);
        const lease = positiveInteger(flags, 'lease');
        if (lease === INVALID) return usageError(invalidOption('lease', option(flags, 'lease')));
        const interval = positiveInteger(flags, 'interval');
        if (interval === INVALID) {
          return usageError(invalidOption('interval', option(flags, 'interval')));
        }
        const count = positiveInteger(flags, 'count');
        if (count === INVALID) return usageError(invalidOption('count', option(flags, 'count')));
        const result = await runWorker(runtime, {
          type,
          command,
          once: flags.includes('--once'),
          ...(lease === undefined ? {} : { lease }),
          ...(interval === undefined ? {} : { interval }),
          ...(count === undefined ? {} : { count }),
        });
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

/** Argumento faltando: a mensagem, o uso, e o código que um script reconhece. */
function usageError(what: string): number {
  console.error(`${what}\n\n${USAGE}`);
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
