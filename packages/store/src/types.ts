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

  close(): void;
}
