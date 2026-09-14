/**
 * O que o ebb guarda. Neste estágio, só definições de processo publicadas —
 * o journal de execução entra quando o runtime entrar.
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

export interface CreateInstanceInput {
  id: string;
  processKey: string;
  version: number;
  status: InstanceStatus;
  command: CommandInput;
  state: EngineStateInput;
}

export interface AppendInput {
  instanceId: string;
  status: InstanceStatus;
  command: CommandInput;
  state: EngineStateInput;
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

  readInstance(id: string): Promise<InstanceRecord | undefined>;

  readInstanceState(id: string): Promise<StoredEngineState | undefined>;

  /** O journal de uma instância, do primeiro comando ao último. */
  journal(id: string): Promise<JournalEntry[]>;

  close(): void;
}
