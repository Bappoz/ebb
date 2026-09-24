/**
 * O que o ebb guarda: definições de processo publicadas e, para cada
 * instância, a linha atual, o journal de comandos aplicados e o snapshot do
 * motor que o último comando produziu.
 */

/** Uma definição de processo publicada, numa versão. */
export interface Deployment {
  /** Chave estável do processo: o id do `<bpmn:process>` executável. */
  processKey: string;
  /** Versão inteira, crescente por `processKey`, começando em 1. */
  version: number;
  /** Nome legível, quando o diagrama declara um. */
  name?: string;
  /** O BPMN 2.0, como chegou. */
  xml: string;
  /** SHA-256 do XML. Conteúdo idêntico não gera versão nova. */
  checksum: string;
  /** De onde veio, para o `ls` dizer algo útil. */
  source?: string;
  /** ISO-8601. */
  deployedAt: string;
}

export interface DeployInput {
  processKey: string;
  xml: string;
  checksum: string;
  name?: string;
  source?: string;
}

export interface DeployResult {
  deployment: Deployment;
  /**
   * Falso quando o conteúdo já estava publicado: publicar duas vezes o mesmo
   * arquivo é uma não-operação, não uma versão nova.
   */
  created: boolean;
}

/** Uma linha do `ebb ls`: o processo e a sua versão mais recente. */
export interface ProcessSummary {
  processKey: string;
  name?: string;
  latestVersion: number;
  /** Quantas versões existem no total. */
  versions: number;
  deployedAt: string;
  source?: string;
}

/**
 * O estado de execução de uma instância.
 *
 * Repete `ExecutionStatus` do `@bpmn-flow/core` de propósito: o store é
 * persistência e não conhece o motor. Os dois conjuntos têm de continuar
 * iguais, e é o `@ebb/runtime` que falha em compilar se divergirem, ao atribuir
 * um ao outro.
 */
export type InstanceStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'terminated' | 'failed';

/** Uma instância de processo em execução (ou já terminada). */
export interface InstanceRecord {
  id: string;
  processKey: string;
  /** A versão publicada com que ela começou, congelada aqui. */
  version: number;
  status: InstanceStatus;
  /** Número do último comando aplicado; o primeiro é 1. */
  seq: number;
  createdAt: string;
  updatedAt: string;
  /** A instância de onde esta foi bifurcada, quando foi. */
  forkedFrom?: string;
  /** O `seq` da original em que o corte foi feito. */
  forkedAt?: number;
}

/** Um comando aplicado a uma instância, como o journal o guarda. */
export interface JournalEntry {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  /** Relógio do motor, epoch ms — é isto que o replay reinjeta. */
  at: number;
  /** Relógio de parede, ISO-8601. Só serve para auditoria. */
  recordedAt: string;
}

/** O comando a gravar, sem o número de sequência, que é do store. */
export interface CommandInput {
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

/**
 * O snapshot do motor, já serializado: o store guarda texto e um número de
 * versão de esquema, e não sabe o que há dentro.
 */
export interface EngineStateInput {
  engineVersion: number;
  json: string;
}

export interface StoredEngineState extends EngineStateInput {
  /** O comando que produziu este estado. */
  seq: number;
}

/**
 * O que o motor sabe sobre um job parado num token, sem nada de trava — a
 * trava é do store, não do motor.
 */
export interface JobProjection {
  tokenId: string;
  nodeId: string;
  type: string;
  variables: Record<string, unknown>;
  /**
   * Projeção da contabilidade de incidente do motor, só para exibição: o
   * store guarda o número que recebe e nunca o incrementa sozinho.
   */
  attempts: number;
}

/** Uma linha da tabela `jobs`. */
export interface JobRecord extends JobProjection {
  instanceId: string;
  state: 'pending' | 'locked';
  worker?: string;
  lockedUntil?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LockJobsInput {
  type: string;
  worker: string;
  count: number;
  /** Epoch ms em que a trava vence. */
  until: number;
  /** Epoch ms de agora, para reconhecer trava vencida. */
  now: number;
}

export interface CreateInstanceInput {
  id: string;
  processKey: string;
  version: number;
  status: InstanceStatus;
  command: CommandInput;
  state: EngineStateInput;
  jobs: JobProjection[];
}

export interface AppendInput {
  instanceId: string;
  status: InstanceStatus;
  command: CommandInput;
  state: EngineStateInput;
  jobs: JobProjection[];
}

export interface ForkInstanceInput {
  id: string;
  from: string;
  /** O `seq` de corte: o journal novo é o `[1..at]` da original. */
  at: number;
  status: InstanceStatus;
  /** As entradas `[1..at]` como lidas da original — `at` e payload intactos. */
  journal: JournalEntry[];
  state: EngineStateInput;
  jobs: JobProjection[];
}

/**
 * O contrato de persistência.
 *
 * Existe para que SQLite (o padrão, sem infraestrutura) e Postgres (quando
 * houver mais de um nó) sejam a mesma coisa vista do runtime.
 */
export interface Store {
  /**
   * Publica uma definição. Conteúdo idêntico ao da última versão devolve essa
   * versão com `created: false`.
   */
  deploy(input: DeployInput): Promise<DeployResult>;

  /** Cada processo publicado, com a sua versão mais recente. */
  listProcesses(): Promise<ProcessSummary[]>;

  /** As versões de um processo, da mais nova para a mais antiga. */
  versions(processKey: string): Promise<Deployment[]>;

  /** Uma versão específica, ou a mais recente quando `version` é omitido. */
  read(processKey: string, version?: number): Promise<Deployment | undefined>;

  /**
   * Cria uma instância: a linha, a primeira entrada do journal (`seq` 1) e o
   * estado que ela produziu — numa transação só.
   */
  createInstance(input: CreateInstanceInput): Promise<InstanceRecord>;

  /**
   * Grava mais um comando aplicado: a entrada do journal, o estado resultante
   * e a linha da instância — numa transação só.
   */
  append(input: AppendInput): Promise<InstanceRecord>;

  /**
   * Cria uma instância a partir do passo `at` de outra: a linha nova, a cópia
   * do journal até ali e o estado reconstruído — numa transação só. A
   * original não é tocada: journal é imutável.
   */
  forkInstance(input: ForkInstanceInput): Promise<InstanceRecord>;

  readInstance(id: string): Promise<InstanceRecord | undefined>;

  readInstanceState(id: string): Promise<StoredEngineState | undefined>;

  /** O journal de uma instância, do primeiro comando ao último. */
  journal(id: string): Promise<JournalEntry[]>;

  /** Toda instância, da mais nova para a mais antiga. */
  listInstances(): Promise<InstanceRecord[]>;

  /**
   * Instâncias cujo id começa por `prefix`, para que o CLI aceite um prefixo
   * curto como o git. Vazio quando nenhuma casa.
   */
  findInstances(prefix: string): Promise<InstanceRecord[]>;

  /**
   * Jobs pendentes ou travados, na ordem em que nasceram. Sem filtro, é toda
   * instância — é a varredura que um worker faz sem re-hidratar motor nenhum.
   */
  listJobs(filter?: { type?: string; instanceId?: string }): Promise<JobRecord[]>;

  /**
   * Trava até `count` jobs pendentes (ou cuja trava venceu) do tipo pedido,
   * para o worker que chamou. Um job só é entregue a quem ganhou a corrida.
   */
  lockJobs(input: LockJobsInput): Promise<JobRecord[]>;

  /**
   * Devolve um job travado à fila, sem tocar em mais nada da instância: só
   * este `tokenId` volta a `state: 'pending'`, sem worker nem lease.
   *
   * `worker` cerca a operação: só libera quando é quem hoje segura a trava.
   * Sem isto, um `w1` que demorou, perdeu o lease para um `w2` e só depois
   * reporta o resultado antigo derrubaria a trava legítima de `w2`. Não-op
   * (não lança) quando a linha já sumiu ou está travada para outro worker.
   */
  releaseJob(instanceId: string, tokenId: string, worker: string): Promise<void>;

  close(): void;
}
