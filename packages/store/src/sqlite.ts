import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';
import { integer, optionalText, text, type Row } from './rows.js';
import type { DeployInput, DeployResult, Deployment, ProcessSummary, Store } from './types.js';

function toDeployment(row: Row): Deployment {
  const name = optionalText(row, 'name');
  const source = optionalText(row, 'source');
  return {
    processKey: text(row, 'process_key'),
    version: integer(row, 'version'),
    xml: text(row, 'xml'),
    checksum: text(row, 'checksum'),
    deployedAt: text(row, 'deployed_at'),
    ...(name === undefined ? {} : { name }),
    ...(source === undefined ? {} : { source }),
  };
}

function toSummary(row: Row): ProcessSummary {
  const name = optionalText(row, 'name');
  const source = optionalText(row, 'source');
  return {
    processKey: text(row, 'process_key'),
    latestVersion: integer(row, 'version'),
    versions: integer(row, 'total'),
    deployedAt: text(row, 'deployed_at'),
    ...(name === undefined ? {} : { name }),
    ...(source === undefined ? {} : { source }),
  };
}

export interface SqliteStoreOptions {
  /** Caminho do arquivo, ou `:memory:`. O diretório é criado se faltar. */
  path: string;
  /** Relógio, para que o teste não dependa do de verdade. */
  now?: () => Date;
}

/**
 * O armazenamento padrão: um arquivo SQLite, via `node:sqlite`.
 *
 * Sem dependência nativa e sem build de instalação — é o que sustenta a
 * promessa de subir o ebb com um comando e nenhuma infraestrutura. Postgres
 * entra implementando {@link Store}, quando existir mais de um nó.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(options: SqliteStoreOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path);
    // WAL deixa leitura e escrita conviverem; foreign_keys para o journal que vem.
    if (options.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  deploy(input: DeployInput): Promise<DeployResult> {
    const latest = this.latestDeployment(input.processKey);
    // Mesmo conteúdo que a última versão: publicar de novo não é versão nova.
    if (latest && latest.checksum === input.checksum) {
      return Promise.resolve({ deployment: latest, created: false });
    }

    const deployment: Deployment = {
      processKey: input.processKey,
      version: (latest?.version ?? 0) + 1,
      xml: input.xml,
      checksum: input.checksum,
      deployedAt: this.now().toISOString(),
      ...(input.name ? { name: input.name } : {}),
      ...(input.source ? { source: input.source } : {}),
    };

    this.db
      .prepare(
        `INSERT INTO deployments (process_key, version, name, xml, checksum, source, deployed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        deployment.processKey,
        deployment.version,
        deployment.name ?? null,
        deployment.xml,
        deployment.checksum,
        deployment.source ?? null,
        deployment.deployedAt,
      );

    return Promise.resolve({ deployment, created: true });
  }

  listProcesses(): Promise<ProcessSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT d.process_key, d.version, d.name, d.source, d.deployed_at, c.total
           FROM deployments d
           JOIN (SELECT process_key, MAX(version) AS version, COUNT(*) AS total
                   FROM deployments GROUP BY process_key) c
             ON c.process_key = d.process_key AND c.version = d.version
          ORDER BY d.process_key`,
      )
      .all();

    return Promise.resolve(rows.map(toSummary));
  }

  versions(processKey: string): Promise<Deployment[]> {
    const rows = this.db
      .prepare('SELECT * FROM deployments WHERE process_key = ? ORDER BY version DESC')
      .all(processKey);
    return Promise.resolve(rows.map(toDeployment));
  }

  read(processKey: string, version?: number): Promise<Deployment | undefined> {
    if (version === undefined) return Promise.resolve(this.latestDeployment(processKey));
    const row = this.db
      .prepare('SELECT * FROM deployments WHERE process_key = ? AND version = ?')
      .get(processKey, version);
    return Promise.resolve(row ? toDeployment(row) : undefined);
  }

  close(): void {
    this.db.close();
  }

  private latestDeployment(processKey: string): Deployment | undefined {
    const row = this.db
      .prepare('SELECT * FROM deployments WHERE process_key = ? ORDER BY version DESC LIMIT 1')
      .get(processKey);
    return row ? toDeployment(row) : undefined;
  }
}
