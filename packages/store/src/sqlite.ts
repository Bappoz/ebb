import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toInstance, toJournalEntry, toStoredState } from './instances.js';
import { migrate } from './migrations.js';
import { integer, optionalText, text, type Row } from './rows.js';
import { transaction } from './tx.js';
import type {
  AppendInput,
  CommandInput,
  CreateInstanceInput,
  DeployInput,
  DeployResult,
  Deployment,
  EngineStateInput,
  InstanceRecord,
  JournalEntry,
  ProcessSummary,
  Store,
  StoredEngineState,
} from './types.js';

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

/**
 * Entrega um resultado síncrono como a interface promete — o erro inclusive.
 *
 * `createInstance` e `append` falham de verdade (chave estrangeira, disco), e
 * um método que às vezes lança e às vezes rejeita quebraria quem usa `.catch()`
 * e a implementação Postgres que um dia vai rejeitar sempre.
 */
function promised<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
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

  createInstance(input: CreateInstanceInput): Promise<InstanceRecord> {
    const at = this.now().toISOString();
    return promised(() =>
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO instances (id, process_key, version, status, seq, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(input.id, input.processKey, input.version, input.status, at, at);
        this.writeJournal(input.id, 1, input.command);
        this.writeEngineState(input.id, 1, input.state);
        return this.instanceRow(input.id);
      }),
    );
  }

  append(input: AppendInput): Promise<InstanceRecord> {
    return promised(() => {
      const seq = this.instanceRow(input.instanceId).seq + 1;
      return transaction(this.db, () => {
        this.writeJournal(input.instanceId, seq, input.command);
        this.writeEngineState(input.instanceId, seq, input.state);
        this.db
          .prepare('UPDATE instances SET status = ?, seq = ?, updated_at = ? WHERE id = ?')
          .run(input.status, seq, this.now().toISOString(), input.instanceId);
        return this.instanceRow(input.instanceId);
      });
    });
  }

  readInstance(id: string): Promise<InstanceRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    return Promise.resolve(row ? toInstance(row) : undefined);
  }

  readInstanceState(id: string): Promise<StoredEngineState | undefined> {
    const row = this.db.prepare('SELECT * FROM instance_state WHERE instance_id = ?').get(id);
    return Promise.resolve(row ? toStoredState(row) : undefined);
  }

  journal(id: string): Promise<JournalEntry[]> {
    const rows = this.db
      .prepare('SELECT * FROM instance_journal WHERE instance_id = ? ORDER BY seq')
      .all(id);
    return Promise.resolve(rows.map(toJournalEntry));
  }

  listInstances(): Promise<InstanceRecord[]> {
    const rows = this.db.prepare('SELECT * FROM instances ORDER BY created_at DESC, id DESC').all();
    return Promise.resolve(rows.map(toInstance));
  }

  findInstances(prefix: string): Promise<InstanceRecord[]> {
    // `substr` em vez de `LIKE`: num LIKE o `_` e o `%` que o usuário digitasse
    // virariam curinga, e um prefixo não é um padrão.
    const rows = this.db
      .prepare('SELECT * FROM instances WHERE substr(id, 1, length(?)) = ? ORDER BY id')
      .all(prefix, prefix);
    return Promise.resolve(rows.map(toInstance));
  }

  close(): void {
    this.db.close();
  }

  /**
   * A escrita do snapshot, separada por ser o passo que o teste de atomicidade
   * faz falhar: o journal já foi escrito quando ela roda, e é isso que a
   * transação tem de desfazer.
   */
  protected writeEngineState(instanceId: string, seq: number, state: EngineStateInput): void {
    this.db
      .prepare(
        `INSERT INTO instance_state (instance_id, seq, engine_version, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (instance_id) DO UPDATE SET seq = excluded.seq,
           engine_version = excluded.engine_version, state = excluded.state`,
      )
      .run(instanceId, seq, state.engineVersion, state.json);
  }

  private writeJournal(instanceId: string, seq: number, command: CommandInput): void {
    this.db
      .prepare(
        `INSERT INTO instance_journal (instance_id, seq, type, payload, at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instanceId,
        seq,
        command.type,
        JSON.stringify(command.payload),
        command.at,
        this.now().toISOString(),
      );
  }

  private instanceRow(id: string): InstanceRecord {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!row) throw new Error(`Nenhuma instância com o id "${id}".`);
    return toInstance(row);
  }

  private latestDeployment(processKey: string): Deployment | undefined {
    const row = this.db
      .prepare('SELECT * FROM deployments WHERE process_key = ? ORDER BY version DESC LIMIT 1')
      .get(processKey);
    return row ? toDeployment(row) : undefined;
  }
}
