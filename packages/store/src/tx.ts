import type { DatabaseSync } from 'node:sqlite';

/**
 * Roda `fn` numa transação, desfazendo o que ela escreveu quando ela lança.
 *
 * Existe porque a entrada do journal e o snapshot que ela produziu têm de ser
 * gravados juntos ou não serem gravados: uma instância cujo journal passou do
 * seu estado (ou o contrário) não dá para retomar nem para replayar.
 *
 * `immediate` pega a trava de escrita já no `BEGIN`, em vez de na primeira
 * escrita. É o que impede dois processos de lerem o mesmo job pendente e
 * travarem os dois — o segundo espera, em vez de ganhar uma corrida.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T, immediate = false): T {
  db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
