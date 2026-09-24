import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './tx.js';

/**
 * Uma migração de esquema. São aplicadas em ordem e registradas, para que um
 * banco criado por uma versão antiga do ebb continue abrindo.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'deployments',
    up: `
      CREATE TABLE deployments (
        process_key  TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        name         TEXT,
        xml          TEXT    NOT NULL,
        checksum     TEXT    NOT NULL,
        source       TEXT,
        deployed_at  TEXT    NOT NULL,
        PRIMARY KEY (process_key, version)
      );
      CREATE INDEX deployments_checksum ON deployments (process_key, checksum);
    `,
  },
  // `version` fica congelada na instância de propósito: um redeploy não pode
  // trocar o modelo debaixo de uma instância viva. `at` é o relógio do motor,
  // que o replay reinjeta; `recorded_at` é o relógio de parede, que só serve
  // para auditoria — os dois divergem num tick com instante explícito.
  {
    version: 2,
    name: 'instances',
    up: `
      CREATE TABLE instances (
        id           TEXT PRIMARY KEY,
        process_key  TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        status       TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        FOREIGN KEY (process_key, version) REFERENCES deployments (process_key, version)
      );
      CREATE INDEX instances_process ON instances (process_key, created_at DESC);

      CREATE TABLE instance_journal (
        instance_id  TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        type         TEXT    NOT NULL,
        payload      TEXT    NOT NULL,
        at           INTEGER NOT NULL,
        recorded_at  TEXT    NOT NULL,
        PRIMARY KEY (instance_id, seq),
        FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
      );

      CREATE TABLE instance_state (
        instance_id     TEXT PRIMARY KEY,
        seq             INTEGER NOT NULL,
        engine_version  INTEGER NOT NULL,
        state           TEXT    NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
      );
    `,
  },
  // `jobs` é índice, não verdade: a linha é derivada dos tokens parados no
  // motor e reconstruível a partir do journal. Existe para um worker varrer
  // trabalho pendente de todas as instâncias sem re-hidratar motor nenhum.
  // `locked_until` é lease e não heartbeat: um `ebb worker` morto não avisa
  // ninguém, e o vencimento é o que devolve o job.
  {
    version: 3,
    name: 'jobs',
    up: `
      CREATE TABLE jobs (
        instance_id   TEXT    NOT NULL,
        token_id      TEXT    NOT NULL,
        node_id       TEXT    NOT NULL,
        type          TEXT    NOT NULL,
        variables     TEXT    NOT NULL,
        state         TEXT    NOT NULL,
        worker        TEXT,
        locked_until  INTEGER,
        attempts      INTEGER NOT NULL,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL,
        PRIMARY KEY (instance_id, token_id),
        FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
      );
      CREATE INDEX jobs_pending ON jobs (type, state, locked_until);
    `,
  },
  // Proveniência de bifurcação. Sem FOREIGN KEY em `forked_from` de
  // propósito: apagar a original não pode apagar nem travar as bifurcações,
  // que carregam journal próprio e completo.
  {
    version: 4,
    name: 'fork provenance',
    up: `
      ALTER TABLE instances ADD COLUMN forked_from TEXT;
      ALTER TABLE instances ADD COLUMN forked_at   INTEGER;
    `,
  },
];

/** A versão de esquema que este código espera. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Leva o banco até {@link SCHEMA_VERSION}, aplicando o que falta numa
 * transação por migração.
 *
 * @throws quando o banco está numa versão mais nova do que este código conhece
 * — seguir em frente aí é corromper dado de um ebb mais novo.
 */
export function migrate(db: DatabaseSync): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  const current = applied.version ?? 0;

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `O banco está no esquema ${current} e esta versão do ebb conhece até ${SCHEMA_VERSION}. Atualize o ebb.`,
    );
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    transaction(db, () => {
      db.exec(migration.up);
      record.run(migration.version, new Date().toISOString());
    });
  }
  return SCHEMA_VERSION;
}
