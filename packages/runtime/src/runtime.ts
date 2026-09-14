import { randomUUID } from 'node:crypto';
import {
  ENGINE_STATE_VERSION,
  executableProcess,
  parseBpmn,
  WorkflowEngine,
} from '@bpmn-flow/core';
import type { EngineState, ExecutionSnapshot, PendingTask } from '@bpmn-flow/core';
import type { InstanceRecord, JournalEntry, Store } from '@ebb/store';
import { applyCommand, payloadOf, type InstanceCommand } from './commands.js';
import { EngineStateMismatchError, InstanceNotFoundError } from './errors.js';

export interface EbbRuntimeOptions {
  store: Store;
  /** Relógio de parede. Injetável para o teste não depender do de verdade. */
  now?: () => Date;
  /** Gerador de id, pelo mesmo motivo. */
  newId?: () => string;
}

export interface StartOptions {
  /** A versão a instanciar. A mais recente quando omitida. */
  version?: number;
  variables?: Record<string, unknown>;
}

export interface CommandResult {
  instance: InstanceRecord;
  snapshot: ExecutionSnapshot;
  tasks: PendingTask[];
}

export interface InstanceView extends CommandResult {
  journal: JournalEntry[];
}

/**
 * O ciclo de vida de uma instância.
 *
 * Não guarda motor entre comandos: cada comando re-hidrata do snapshot,
 * aplica, grava e descarta. É por isso que uma instância sobrevive à morte do
 * processo sem nenhum mecanismo a mais — o caso normal e o caso do restart são
 * o mesmo caminho.
 */
export class EbbRuntime {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: EbbRuntimeOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** Instancia um processo publicado e o leva até o primeiro ponto de espera. */
  async start(processKey: string, options: StartOptions = {}): Promise<CommandResult> {
    const deployment = await this.store.read(processKey, options.version);
    if (!deployment) {
      const what = options.version === undefined ? processKey : `${processKey} v${options.version}`;
      throw new Error(`Nada publicado com a chave "${what}".`);
    }

    const model = await parseBpmn(deployment.xml);
    const process = executableProcess(model);
    const at = this.now().getTime();

    const engine = new WorkflowEngine(process, {
      processes: model.processes,
      now: () => at,
      ...(options.variables ? { variables: options.variables } : {}),
    });
    // mode, maxSteps e expressions não são passados acima — o motor nasce no
    // padrão de @bpmn-flow/core. Lemos os três de volta do próprio motor, em
    // vez de repetir esse padrão aqui, para o journal não ter uma segunda
    // fonte da verdade que possa divergir dele (é o mesmo motivo pelo qual
    // ENGINE_STATE_VERSION foi de 9 para 10: expressions passou a fazer parte
    // do estado). Sem isso, um replay a partir só do journal teria de
    // adivinhar com que opções a instância nasceu.
    const engineState = engine.getState();
    const command: InstanceCommand = {
      type: 'start',
      ...(options.variables ? { variables: options.variables } : {}),
      engine: {
        mode: engineState.mode,
        maxSteps: engineState.maxSteps,
        expressions: engineState.expressions,
      },
    };
    const snapshot = await applyCommand(engine, command);

    const instance = await this.store.createInstance({
      id: this.newId(),
      processKey: deployment.processKey,
      version: deployment.version,
      status: snapshot.status,
      command: { type: command.type, payload: payloadOf(command), at },
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
    });

    return { instance, snapshot, tasks: engine.tasks() };
  }

  /**
   * Aplica um comando a uma instância existente e grava o resultado.
   *
   * `at` é o relógio do motor para este comando; o padrão é o de parede. Dar um
   * explícito é como um `tick` anda até um timer vencer sem esperar.
   */
  async apply(instanceId: string, command: InstanceCommand, at?: number): Promise<CommandResult> {
    const when = at ?? this.now().getTime();
    const { instance, engine } = await this.hydrate(instanceId, when);
    const snapshot = await applyCommand(engine, command);

    const updated = await this.store.append({
      instanceId: instance.id,
      status: snapshot.status,
      command: { type: command.type, payload: payloadOf(command), at: when },
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
    });

    return { instance: updated, snapshot, tasks: engine.tasks() };
  }

  /** Lê uma instância sem aplicar nada. */
  async inspect(instanceId: string): Promise<InstanceView> {
    const journal = await this.store.journal(instanceId);
    // Nada vai ler este relógio, mas restore() exige um: o último instante
    // journalado mantém a leitura determinística.
    const at = journal.at(-1)?.at ?? this.now().getTime();
    const { instance, engine } = await this.hydrate(instanceId, at);
    return { instance, snapshot: engine.snapshot(), tasks: engine.tasks(), journal };
  }

  /** Reconstrói o motor de uma instância com o relógio congelado em `at`. */
  private async hydrate(
    instanceId: string,
    at: number,
  ): Promise<{ instance: InstanceRecord; engine: WorkflowEngine }> {
    const instance = await this.store.readInstance(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);

    // A versão com que a instância começou, não a mais recente: um redeploy não
    // troca o modelo debaixo de uma instância viva.
    const deployment = await this.store.read(instance.processKey, instance.version);
    if (!deployment) {
      throw new Error(
        `A instância ${instanceId} aponta para ${instance.processKey} v${instance.version}, que não está publicado.`,
      );
    }

    const stored = await this.store.readInstanceState(instanceId);
    if (!stored) throw new Error(`A instância ${instanceId} não tem estado gravado.`);
    if (stored.engineVersion !== ENGINE_STATE_VERSION) {
      throw new EngineStateMismatchError(instanceId, stored.engineVersion, ENGINE_STATE_VERSION);
    }

    const model = await parseBpmn(deployment.xml);
    const process = executableProcess(model);
    const state = JSON.parse(stored.json) as EngineState;
    const engine = WorkflowEngine.restore(process, state, {
      processes: model.processes,
      now: () => at,
    });
    return { instance, engine };
  }
}
