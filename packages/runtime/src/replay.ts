import { executableProcess, parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type {
  ExecutionSnapshot,
  GatewayDecision,
  HistoryEntry,
  IncidentState,
  PendingTask,
} from '@bpmn-flow/core';
import type { JournalEntry } from '@ebb/store';
import {
  applyCommand,
  commandFromEntry,
  JournalShapeError,
  type InstanceCommand,
} from './commands.js';

/** Por que um gateway foi por onde foi, no instante em que decidiu. */
export interface GatewayTrace {
  nodeId: string;
  name?: string;
  options: { flowId: string; targetId: string; condition?: string; isDefault: boolean }[];
  taken: string[];
  variables: Record<string, unknown>;
}

/** Um comando do journal e o que ele fez com a instância. */
export interface ReplayStep {
  seq: number;
  at: number;
  command: InstanceCommand;
  /** Estado logo depois do comando. */
  snapshot: ExecutionSnapshot;
  /** O que este comando acrescentou à history do motor. */
  entered: HistoryEntry[];
  /** Fluxos tomados durante o comando, em ordem. */
  flows: string[];
  decisions: GatewayTrace[];
  tasks: PendingTask[];
  incidents: IncidentState[];
}

/** Pediram um passo que o journal não tem. */
export class ReplayRangeError extends Error {
  constructor(
    readonly upTo: number,
    readonly last: number,
  ) {
    super(
      last === 0
        ? 'O journal está vazio: não há passo para reconstruir.'
        : `Passo ${upTo} fora do journal: os passos vão de [1, ${last}].`,
    );
    this.name = 'ReplayRangeError';
  }
}

function trace(decision: GatewayDecision): GatewayTrace {
  return {
    nodeId: decision.nodeId,
    ...(decision.name ? { name: decision.name } : {}),
    options: decision.options.map((option) => ({
      flowId: option.flowId,
      targetId: option.targetId,
      isDefault: option.isDefault,
      ...(option.condition ? { condition: option.condition } : {}),
    })),
    taken: [...decision.suggested],
    // Cópia de propósito: o motor pode entregar o objeto vivo do escopo, e o
    // próximo comando reescreveria o "porquê" deste passo.
    variables: structuredClone(decision.variables),
  };
}

/**
 * Reconstrói uma instância a partir do journal, sem tocar store nenhum.
 *
 * Um motor só, com os comandos aplicados em sequência e o relógio posto no
 * `at` de cada um antes de aplicá-lo — a mesma disciplina do relógio congelado
 * do caminho ao vivo. O `decide` só registra e devolve `undefined`, que pelo
 * contrato do hook deixa a decisão com os dados: é assim que a razão do
 * gateway sai sem mudar o motor nem o journal.
 */
export async function replayJournal(
  xml: string,
  journal: JournalEntry[],
  options: { upTo?: number } = {},
): Promise<{ engine: WorkflowEngine; steps: ReplayStep[] }> {
  const last = journal.at(-1)?.seq ?? 0;
  const upTo = options.upTo ?? last;
  if (last === 0 || !Number.isInteger(upTo) || upTo < 1 || upTo > last) {
    throw new ReplayRangeError(upTo, last);
  }
  const entries = journal.slice(0, upTo);
  entries.forEach((entry, index) => {
    if (entry.seq !== index + 1) {
      throw new JournalShapeError(entry.seq, 'seq', `deveria ser ${index + 1}: journal com buraco`);
    }
  });
  const commands = entries.map(commandFromEntry);
  const [birth] = commands;
  if (birth?.type !== 'start') {
    throw new JournalShapeError(1, 'type', 'deveria ser start: é o comando que cria a instância');
  }

  const model = await parseBpmn(xml);
  const process = executableProcess(model);
  let clock = entries[0]?.at ?? 0;
  let decisions: GatewayTrace[] = [];
  let flows: string[] = [];
  const engine = new WorkflowEngine(process, {
    processes: model.processes,
    now: () => clock,
    ...birth.engine,
    ...(birth.variables ? { variables: birth.variables } : {}),
    decide: (decision) => {
      decisions.push(trace(decision));
      return undefined;
    },
  });
  engine.on('flow.take', ({ flowId }) => flows.push(flowId));

  const steps: ReplayStep[] = [];
  let seen = 0;
  for (const [index, command] of commands.entries()) {
    const entry = entries[index];
    if (!entry) break;
    clock = entry.at;
    decisions = [];
    flows = [];
    const snapshot = await applyCommand(engine, command);
    steps.push({
      seq: entry.seq,
      at: entry.at,
      command,
      snapshot,
      entered: snapshot.history.slice(seen),
      flows,
      decisions,
      tasks: engine.tasks(),
      incidents: engine.incidentList(),
    });
    seen = snapshot.history.length;
  }
  return { engine, steps };
}
