import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toInstance, toJournalEntry, toStoredState } from './instances.js';
import { toJob } from './jobs.js';
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
  JobProjection,
  JobRecord,
  JournalEntry,
  LockJobsInput,
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
 * Todo método deste store roda `db.prepare(...)` ou um mapeador de linha de
 * forma síncrona (chave estrangeira, disco, banco fechado, coluna com um
 * valor que `rows.ts` não reconhece podem lançar); um método que às vezes
 * lança e às vezes rejeita quebraria quem usa `.catch()` e a implementação
 * Postgres que um dia vai rejeitar sempre.
 */
function promised<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Quanto uma conexão espera por uma trava de escrita antes de lançar
 * `SQLITE_BUSY`, em ms.
 *
 * O motor e um `ebb worker` escrevem no mesmo arquivo; quem perde a corrida de
 * `BEGIN IMMEDIATE` (em `lockJobs`) tem de esperar a vez, não lançar na hora —
 * senão a exclusão mútua que `tx.ts` promete não existe de verdade. Travar e
 * devolver é questão de milissegundos, então 5s absorve contenção real sem
 * deixar uma chamada de CLI parecer travada.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteStoreOptions {
  /** Caminho do arquivo, ou `:memory:`. O diretório é criado se faltar. */
  path: string;
  /** Relógio, para que o teste não dependa do de verdade. */
  now?: () => Date;
  /** Sobrescreve {@link DEFAULT_BUSY_TIMEOUT_MS}, para um teste de contenção. */
  busyTimeoutMs?: number;
}

/**
 * O armazenamento padrão: um arquivo SQLite, via `node:sqlite`.
 *
 * Sem dependência nativa e sem build de instalação — é o que sustenta a
 * promessa de subir o ebb com um comando e nenhuma infraestrutura. Postgres
 * entra implementando {@link Store}, quando existir mais de um nó.
 */
export class SqliteStore implements Store {
  /**
   * `protected`, não `private`: é o seam que o teste de atomicidade
   * (`instances.test.ts`) e o de `busy_timeout` (`jobs.test.ts`) usam para
   * inspecionar a conexão de dentro de uma subclasse, sem expor nada no
   * contrato {@link Store}.
   */
  protected readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(options: SqliteStoreOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.db = new DatabaseSync(options.path, {
      timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    });
    // WAL deixa leitura e escrita conviverem; foreign_keys para o journal que vem.
    if (options.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  deploy(input: DeployInput): Promise<DeployResult> {
    return promised(() => {
      const latest = this.latestDeployment(input.processKey);
      // Mesmo conteúdo que a última versão: publicar de novo não é versão nova.
      if (latest && latest.checksum === input.checksum) {
        return { deployment: latest, created: false };
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

      return { deployment, created: true };
    });
  }

  listProcesses(): Promise<ProcessSummary[]> {
    return promised(() => {
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

      return rows.map(toSummary);
    });
  }

  versions(processKey: string): Promise<Deployment[]> {
    return promised(() => {
      const rows = this.db
        .prepare('SELECT * FROM deployments WHERE process_key = ? ORDER BY version DESC')
        .all(processKey);
      return rows.map(toDeployment);
    });
  }

  read(processKey: string, version?: number): Promise<Deployment | undefined> {
    return promised(() => {
      if (version === undefined) return this.latestDeployment(processKey);
      const row = this.db
        .prepare('SELECT * FROM deployments WHERE process_key = ? AND version = ?')
        .get(processKey, version);
      return row ? toDeployment(row) : undefined;
    });
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
        this.reconcileJobs(input.id, input.jobs);
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
        this.reconcileJobs(input.instanceId, input.jobs);
        return this.instanceRow(input.instanceId);
      });
    });
  }

  listJobs(filter: { type?: string; instanceId?: string } = {}): Promise<JobRecord[]> {
    return promised(() => {
      const where: string[] = [];
      const args: string[] = [];
      if (filter.type !== undefined) {
        where.push('type = ?');
        args.push(filter.type);
      }
      if (filter.instanceId !== undefined) {
        where.push('instance_id = ?');
        args.push(filter.instanceId);
      }
      const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      return this.db
        .prepare(`SELECT * FROM jobs${clause} ORDER BY created_at, token_id`)
        .all(...args)
        .map(toJob);
    });
  }

  lockJobs(input: LockJobsInput): Promise<JobRecord[]> {
    return promised(() => {
      // `until` no passado travaria um job que qualquer outro `lockJobs`
      // reconhece como vencido na mesma leitura — entrega dupla instantânea.
      if (input.until <= input.now) {
        throw new Error(
          `lockJobs: "until" (${input.until}) tem de ser depois de "now" (${input.now}).`,
        );
      }
      return transaction(
        this.db,
        () => {
          const candidates = this.db
            .prepare(
              `SELECT instance_id, token_id FROM jobs
               WHERE type = ? AND (state = 'pending' OR locked_until <= ?)
               ORDER BY created_at, token_id LIMIT ?`,
            )
            .all(input.type, input.now, input.count)
            .map((row) => [text(row, 'instance_id'), text(row, 'token_id')] as const);
          const lock = this.db.prepare(
            `UPDATE jobs SET state = 'locked', worker = ?, locked_until = ?, updated_at = ?
             WHERE instance_id = ? AND token_id = ?`,
          );
          const read = this.db.prepare('SELECT * FROM jobs WHERE instance_id = ? AND token_id = ?');
          const at = this.now().toISOString();
          return candidates.map(([instanceId, tokenId]) => {
            lock.run(input.worker, input.until, at, instanceId, tokenId);
            const row = read.get(instanceId, tokenId);
            if (!row) {
              throw new Error(`Job "${tokenId}" da instância "${instanceId}" sumiu após travar.`);
            }
            return toJob(row);
          });
        },
        true,
      );
    });
  }

  releaseJob(instanceId: string, tokenId: string): Promise<void> {
    return promised(() => {
      this.db
        .prepare(
          `UPDATE jobs SET state = 'pending', worker = NULL, locked_until = NULL, updated_at = ?
           WHERE instance_id = ? AND token_id = ?`,
        )
        .run(this.now().toISOString(), instanceId, tokenId);
    });
  }

  readInstance(id: string): Promise<InstanceRecord | undefined> {
    return promised(() => {
      const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
      return row ? toInstance(row) : undefined;
    });
  }

  readInstanceState(id: string): Promise<StoredEngineState | undefined> {
    return promised(() => {
      const row = this.db.prepare('SELECT * FROM instance_state WHERE instance_id = ?').get(id);
      return row ? toStoredState(row) : undefined;
    });
  }

  journal(id: string): Promise<JournalEntry[]> {
    return promised(() => {
      const rows = this.db
        .prepare('SELECT * FROM instance_journal WHERE instance_id = ? ORDER BY seq')
        .all(id);
      return rows.map(toJournalEntry);
    });
  }

  listInstances(): Promise<InstanceRecord[]> {
    return promised(() => {
      const rows = this.db
        .prepare('SELECT * FROM instances ORDER BY created_at DESC, id DESC')
        .all();
      return rows.map(toInstance);
    });
  }

  findInstances(prefix: string): Promise<InstanceRecord[]> {
    return promised(() => {
      // `substr` em vez de `LIKE`: num LIKE o `_` e o `%` que o usuário digitasse
      // virariam curinga, e um prefixo não é um padrão.
      const rows = this.db
        .prepare('SELECT * FROM instances WHERE substr(id, 1, length(?)) = ? ORDER BY id')
        .all(prefix, prefix);
      return rows.map(toInstance);
    });
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

  /**
   * Alinha a tabela com os jobs que o motor ainda tem parados: o que sumiu sai,
   * o que entrou entra, o que continua fica como está — trava inclusive, para
   * um comando concorrente não roubar o job de quem já o pegou.
   */
  private reconcileJobs(instanceId: string, jobs: JobProjection[]): void {
    const at = this.now().toISOString();
    const keep = jobs.map((job) => job.tokenId);
    const placeholders = keep.map(() => '?').join(', ');
    this.db
      .prepare(
        `DELETE FROM jobs WHERE instance_id = ?${
          keep.length > 0 ? ` AND token_id NOT IN (${placeholders})` : ''
        }`,
      )
      .run(instanceId, ...keep);
    const upsert = this.db.prepare(
      `INSERT INTO jobs (instance_id, token_id, node_id, type, variables, state,
                         attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT (instance_id, token_id) DO UPDATE SET
         node_id = excluded.node_id, type = excluded.type,
         variables = excluded.variables, attempts = excluded.attempts, updated_at = excluded.updated_at`,
    );
    for (const job of jobs) {
      upsert.run(
        instanceId,
        job.tokenId,
        job.nodeId,
        job.type,
        JSON.stringify(job.variables),
        job.attempts,
        at,
        at,
      );
    }
  }

  private latestDeployment(processKey: string): Deployment | undefined {
    const row = this.db
      .prepare('SELECT * FROM deployments WHERE process_key = ? ORDER BY version DESC LIMIT 1')
      .get(processKey);
    return row ? toDeployment(row) : undefined;
  }
}
