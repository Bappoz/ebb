import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { transaction } from '../src/tx.js';

function db(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t (x INTEGER)');
  return database;
}

describe('transaction', () => {
  it('devolve o valor da função e mantém o que ela escreveu', () => {
    const database = db();
    const written = transaction(database, () => {
      database.prepare('INSERT INTO t (x) VALUES (1)').run();
      return 'pronto';
    });

    expect(written).toBe('pronto');
    expect(database.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  it('desfaz o que a função escreveu quando ela lança', () => {
    const database = db();

    expect(() =>
      transaction(database, () => {
        database.prepare('INSERT INTO t (x) VALUES (1)').run();
        throw new Error('meio do caminho');
      }),
    ).toThrow('meio do caminho');

    // O ponto inteiro: a primeira escrita não pode sobreviver à segunda falhar.
    expect(database.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
  });
});
