import type { EbbRuntime, InstanceView } from '@ebb/runtime';
import type { InstanceRecord, Store } from '@ebb/store';
import type { CommandResult } from './commands.js';
import { CHECK, CROSS, table } from './output.js';

/** Quanto de um id aparece numa listagem; o CLI aceita qualquer prefixo único. */
export const SHORT = 8;

export interface StartCliOptions {
  version?: number;
  variables?: Record<string, unknown>;
  engine?: { onHandlerError?: 'fail' | 'incident'; retry?: { attempts: number } };
}

/** `ebb start <chave>` — instancia um processo publicado. */
export async function startInstance(
  runtime: EbbRuntime,
  processKey: string,
  options: StartCliOptions,
): Promise<CommandResult> {
  try {
    const started = await runtime.start(processKey, options);
    return {
      output: [
        `${CHECK} instância ${started.instance.id} — ${started.snapshot.status}`,
        ...pendingLines(started.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  } catch (error) {
    return { output: `${CROSS} ${message(error)}`, exitCode: 1 };
  }
}

/** `ebb ps` — as instâncias, da mais nova para a mais antiga. */
export async function listInstances(store: Store): Promise<CommandResult> {
  const instances = await store.listInstances();
  if (instances.length === 0) {
    return { output: 'Nenhuma instância. Comece com: ebb start <chave>', exitCode: 0 };
  }
  const rows = instances.map((entry) => [
    entry.id.slice(0, SHORT),
    entry.processKey,
    `v${entry.version}`,
    entry.status,
    `${entry.seq}`,
    entry.updatedAt,
  ]);
  return {
    output: table(['ID', 'PROCESSO', 'VERSÃO', 'ESTADO', 'COMANDOS', 'ATUALIZADA'], rows),
    exitCode: 0,
  };
}

/** `ebb show <id>` — estado, variáveis e o que está pendente. */
export async function showInstance(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const view = await runtime.inspect(instance.id);
    return { output: describe(view), exitCode: 0 };
  });
}

/** `ebb complete <id> <tokenId>` — conclui uma tarefa parada. */
export async function completeTask(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  tokenId: string,
  output: Record<string, unknown>,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, {
      type: 'completeTask',
      tokenId,
      ...(hasKeys(output) ? { output } : {}),
    });
    return {
      output: [
        `${CHECK} ${instance.id} — ${result.snapshot.status}`,
        ...pendingLines(result.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  });
}

/** `ebb signal <id> <nome>` — entrega um evento ao diagrama. */
export async function signalInstance(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  name: string,
  output: Record<string, unknown>,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, {
      type: 'signal',
      name,
      ...(hasKeys(output) ? { output } : {}),
    });
    return {
      output: [
        `${CHECK} ${instance.id} — ${result.snapshot.status}`,
        ...pendingLines(result.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  });
}

/** `ebb tick <id> [--at <iso>]` — dispara os timers vencidos. */
export async function tickInstance(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  at?: number,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, { type: 'tick' }, at);
    return {
      output: [
        `${CHECK} ${instance.id} — ${result.snapshot.status}`,
        ...pendingLines(result.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  });
}

/** `ebb journal <id>` — os comandos aplicados, em ordem. */
export async function showJournal(store: Store, prefix: string): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const entries = await store.journal(instance.id);
    const rows = entries.map((entry) => [
      `${entry.seq}`,
      entry.type,
      entry.recordedAt,
      JSON.stringify(entry.payload),
    ]);
    return { output: table(['#', 'COMANDO', 'QUANDO', 'PAYLOAD'], rows), exitCode: 0 };
  });
}

/**
 * Resolve o prefixo numa instância e roda `fn`, ou explica por que não deu.
 *
 * Prefixo ambíguo lista as candidatas em vez de escolher uma: aplicar um
 * comando na instância errada não tem desfazer.
 *
 * Exportado porque `jobs.ts` (retry/resolve por prefixo de instância) é o
 * segundo consumidor desta regra — duplicá-la lá reabriria a chance de os
 * dois divergirem sobre o que é "ambíguo".
 */
export async function withInstance(
  store: Store,
  prefix: string,
  fn: (instance: InstanceRecord) => Promise<CommandResult>,
): Promise<CommandResult> {
  const [first, ...rest] = await store.findInstances(prefix);
  if (!first) {
    return { output: `${CROSS} nenhuma instância com o id "${prefix}"`, exitCode: 1 };
  }
  if (rest.length > 0) {
    return {
      output: [
        `${CROSS} "${prefix}" casa com ${rest.length + 1} instâncias:`,
        ...[first, ...rest].map((entry) => `  ${entry.id}  ${entry.processKey}  ${entry.status}`),
      ].join('\n'),
      exitCode: 1,
    };
  }
  try {
    return await fn(first);
  } catch (error) {
    return { output: `${CROSS} ${message(error)}`, exitCode: 1 };
  }
}

function describe(view: InstanceView): string {
  const { instance, snapshot } = view;
  const lines = [
    table(
      ['INSTÂNCIA', 'PROCESSO', 'VERSÃO', 'ESTADO', 'COMANDOS'],
      [
        [
          instance.id,
          instance.processKey,
          `v${instance.version}`,
          instance.status,
          `${instance.seq}`,
        ],
      ],
    ),
  ];

  const variables = Object.entries(snapshot.variables);
  if (variables.length > 0) {
    lines.push(
      '',
      table(
        ['VARIÁVEL', 'VALOR'],
        variables.map(([key, value]) => [key, JSON.stringify(value) ?? 'undefined']),
      ),
    );
  }

  const pending = pendingLines(view.tasks);
  if (pending.length > 0) lines.push('', ...pending);

  return lines.join('\n');
}

function pendingLines(tasks: InstanceView['tasks']): string[] {
  if (tasks.length === 0) return [];
  return [
    table(
      ['TOKEN', 'ATIVIDADE', 'NOME', 'ESPERANDO'],
      tasks.map((task) => [task.tokenId, task.nodeId, task.name ?? '', task.reason]),
    ),
  ];
}

function hasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
