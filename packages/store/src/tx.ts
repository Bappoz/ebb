import type { DatabaseSync } from 'node:sqlite';

/**
 * Roda `fn` numa transação, desfazendo o que ela escreveu quando ela lança.
 *
 * Existe porque a entrada do journal e o snapshot que ela produziu têm de ser
 * gravados juntos ou não serem gravados: uma instância cujo journal passou do
 * seu estado (ou o contrário) não dá para retomar nem para replayar.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
