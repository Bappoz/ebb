import type { DatabaseSync } from 'node:sqlite';

/**
 * Uma migração de esquema. São aplicadas em ordem e registradas, para que um
 * banco criado por uma versão antiga do ebb continue abrindo.
 */
interface Migration {
  version: number;
  name: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
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
    db.exec('BEGIN');
    try {
      db.exec(migration.up);
      record.run(migration.version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return SCHEMA_VERSION;
}
