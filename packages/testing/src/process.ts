import {
  BpmnError,
  executableProcess,
  parseBpmn,
  type ExecutionSnapshot,
  type PendingTask,
} from '@bpmn-flow/core';
import {
  EbbRuntime,
  type CommandResult,
  type InstanceCommand,
  type StartOptions,
} from '@ebb/runtime';
import {
  checksumOf,
  SqliteStore,
  type InstanceRecord,
  type JobRecord,
  type JournalEntry,
} from '@ebb/store';
import { type ClockInstant, type TestClock, withClock } from './clock.js';
import {
  flowDefinitions,
  processCoverage,
  type FlowCoverageEntry,
  type ProcessCoverage,
} from './coverage.js';

export type WorkerOutput = void | Record<string, unknown>;
export type WorkerDouble = (job: Readonly<JobRecord>) => WorkerOutput | Promise<WorkerOutput>;
export type WorkerDoubles = Record<string, WorkerDouble>;

export interface ProcessTestOptions {
  clock?: TestClock;
  /** Instante inicial, usado só quando `clock` não foi fornecido. */
  at?: ClockInstant;
  workers?: WorkerDoubles;
  /** Protege o teste de um processo que produz jobs para sempre. */
  maxWorkerOperations?: number;
}

export interface ProcessRunStartOptions extends StartOptions {
  /** Dublês só deste cenário; sobrescrevem os registrados na fixture. */
  workers?: WorkerDoubles;
}

function isOutput(value: unknown): value is Record<string, unknown> | undefined {
  return (
    value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Uma execução isolada e seu histórico observável. */
export class ProcessRun {
  private result: CommandResult;
  private readonly taken = new Set<string>();

  constructor(
    private readonly runtime: EbbRuntime,
    private readonly clock: TestClock,
    result: CommandResult,
    private readonly workers: Map<string, WorkerDouble>,
    private readonly maxWorkerOperations: number,
    private readonly recordCoverage: (flows: ReadonlySet<string>) => void,
  ) {
    this.result = result;
  }

  get instance(): InstanceRecord {
    return this.result.instance;
  }

  get snapshot(): ExecutionSnapshot {
    return this.result.snapshot;
  }

  get tasks(): PendingTask[] {
    return this.result.tasks;
  }

  get incidents(): CommandResult['incidents'] {
    return this.result.incidents;
  }

  get visitedNodes(): ReadonlySet<string> {
    return new Set(
      this.snapshot.history.filter((entry) => entry.event === 'enter').map((entry) => entry.nodeId),
    );
  }

  get takenFlows(): ReadonlySet<string> {
    return new Set(this.taken);
  }

  /** @internal Completa a inicialização assíncrona depois do construtor. */
  async initialize(): Promise<this> {
    await this.driveWorkers();
    await this.refreshPath();
    return this;
  }

  /** Aplica qualquer comando do runtime e depois executa os dublês disponíveis. */
  async apply(command: InstanceCommand): Promise<this> {
    this.result = await this.runtime.apply(this.instance.id, command);
    await this.driveWorkers();
    await this.refreshPath();
    return this;
  }

  /** Conclui uma espera pelo id do nó (ou pelo token, quando há multi-instância). */
  async complete(nodeOrTokenId: string, output?: Record<string, unknown>): Promise<this> {
    const matches = this.tasks.filter(
      (task) => task.nodeId === nodeOrTokenId || task.tokenId === nodeOrTokenId,
    );
    if (matches.length === 0) {
      const pending = this.tasks.map((task) => `${task.nodeId} (${task.tokenId})`).join(', ');
      throw new Error(
        `Nenhuma tarefa pendente casa com "${nodeOrTokenId}".${pending ? ` Pendentes: ${pending}.` : ''}`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Há ${matches.length} tarefas em "${nodeOrTokenId}"; use o tokenId para escolher uma.`,
      );
    }
    const [task] = matches;
    if (!task) throw new Error('Tarefa desapareceu durante a seleção.');
    if (task.reason === 'job') {
      throw new Error(
        `"${task.nodeId}" é um job; registre um dublê de worker para ${task.job?.type}.`,
      );
    }
    return this.apply({
      type: 'completeTask',
      tokenId: task.tokenId,
      ...(output ? { output } : {}),
    });
  }

  async signal(name: string, output?: Record<string, unknown>): Promise<this> {
    return this.apply({ type: 'signal', name, ...(output ? { output } : {}) });
  }

  async tick(): Promise<this> {
    this.result = await this.runtime.apply(this.instance.id, { type: 'tick' }, this.clock.time);
    await this.driveWorkers();
    await this.refreshPath();
    return this;
  }

  async advanceTo(instant: ClockInstant): Promise<this> {
    this.clock.advanceTo(instant);
    return this.tick();
  }

  async advanceBy(milliseconds: number): Promise<this> {
    this.clock.advanceBy(milliseconds);
    return this.tick();
  }

  /** Executa jobs que ficaram pendentes depois de um dublê ser registrado. */
  async runWorkers(): Promise<this> {
    await this.driveWorkers();
    await this.refreshPath();
    return this;
  }

  /** Registra ou substitui um dublê nesta execução. */
  worker(type: string, handler: WorkerDouble): this {
    this.workers.set(type, handler);
    return this;
  }

  /** Journal real produzido pelo cenário, útil para afirmar o contrato externo. */
  async journal(): Promise<JournalEntry[]> {
    return (await this.runtime.inspect(this.instance.id)).journal;
  }

  private async driveWorkers(): Promise<void> {
    let operations = 0;
    const worker = `ebb-test-${this.instance.id}`;
    while (true) {
      let progressed = false;
      for (const [type, handler] of this.workers) {
        const jobs = await this.runtime.activateJobs({
          type,
          worker,
          count: Math.max(1, this.maxWorkerOperations - operations),
        });
        for (const job of jobs) {
          if (operations >= this.maxWorkerOperations) {
            throw new Error(
              `O teste passou de ${this.maxWorkerOperations} operações de worker; provável loop sem fim.`,
            );
          }
          operations += 1;
          progressed = true;
          let output: Record<string, unknown> | undefined;
          try {
            const returned: unknown = await handler(job);
            if (!isOutput(returned)) {
              throw new Error(`O worker "${type}" deve devolver um objeto ou undefined.`);
            }
            output = returned ?? undefined;
          } catch (error) {
            this.result = await this.runtime.failJob(
              job.instanceId,
              job.tokenId,
              error instanceof BpmnError
                ? { code: error.code, message: error.message }
                : { message: errorMessage(error) },
              { worker },
            );
            continue;
          }
          this.result = await this.runtime.completeJob(job.instanceId, job.tokenId, output);
        }
      }
      if (!progressed) return;
    }
  }

  private async refreshPath(): Promise<void> {
    const replay = await this.runtime.replay(this.instance.id);
    this.taken.clear();
    for (const step of replay.steps) for (const flow of step.flows) this.taken.add(flow);
    this.recordCoverage(this.taken);
  }
}

/** Fixture de um diagrama; agrega cobertura entre todos os seus cenários. */
export class ProcessTest {
  readonly clock: TestClock;
  readonly processKey: string;
  private readonly workers: Map<string, WorkerDouble>;
  private readonly stores: SqliteStore[] = [];
  private readonly observed = new Set<string>();
  private nextId = 0;

  constructor(
    private readonly xml: string,
    clock: TestClock,
    processKey: string,
    private readonly definitions: readonly Omit<FlowCoverageEntry, 'covered'>[],
    workers: WorkerDoubles,
    private readonly maxWorkerOperations: number,
  ) {
    this.clock = clock;
    this.processKey = processKey;
    this.workers = new Map(Object.entries(workers));
  }

  /** Registra ou substitui um dublê para os próximos cenários. */
  worker(type: string, handler: WorkerDouble): this {
    this.workers.set(type, handler);
    return this;
  }

  async start(options: ProcessRunStartOptions = {}): Promise<ProcessRun> {
    const store = new SqliteStore({ path: ':memory:', now: this.clock.now });
    this.stores.push(store);
    await store.deploy({
      processKey: this.processKey,
      xml: this.xml,
      checksum: checksumOf(this.xml),
    });
    const runtime = new EbbRuntime({
      store,
      now: this.clock.now,
      newId: () => `test-${++this.nextId}`,
    });
    const { workers, ...startOptions } = options;
    const result = await runtime.start(this.processKey, startOptions);
    const doubles = new Map(this.workers);
    for (const [type, handler] of Object.entries(workers ?? {})) doubles.set(type, handler);
    return new ProcessRun(
      runtime,
      this.clock,
      result,
      doubles,
      this.maxWorkerOperations,
      (flows) => {
        for (const flow of flows) this.observed.add(flow);
      },
    ).initialize();
  }

  coverage(): ProcessCoverage {
    return processCoverage(this.definitions, this.observed);
  }

  close(): void {
    for (const store of this.stores) store.close();
    this.stores.length = 0;
  }
}

export async function testProcess(
  xml: string,
  options: ProcessTestOptions = {},
): Promise<ProcessTest> {
  const model = await parseBpmn(xml);
  const process = executableProcess(model);
  const clock = options.clock ?? withClock(options.at);
  return new ProcessTest(
    xml,
    clock,
    process.id,
    flowDefinitions(model, process),
    options.workers ?? {},
    options.maxWorkerOperations ?? 1_000,
  );
}
