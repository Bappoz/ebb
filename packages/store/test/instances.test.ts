import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksumOf } from '../src/checksum.js';
import { toInstance, toJournalEntry } from '../src/instances.js';
import { SqliteStore } from '../src/sqlite.js';
import type { EngineStateInput } from '../src/types.js';

const XML = '<definitions><process id="Pedido" /></definitions>';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-instances-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Uma loja com o processo `Pedido` v1 já publicado. */
async function seeded(store: SqliteStore): Promise<SqliteStore> {
  await store.deploy({ processKey: 'Pedido', xml: XML, checksum: checksumOf(XML) });
  return store;
}

function creation(id = 'i1') {
  return {
    id,
    processKey: 'Pedido',
    version: 1,
    status: 'waiting' as const,
    command: { type: 'start', payload: { variables: { total: 42 } }, at: 1_700_000_000_000 },
    state: { engineVersion: 10, json: '{"version":10,"steps":1}' },
  };
}

describe('escrita de instância', () => {
  it('cria a linha, a primeira entrada do journal e o estado de uma vez', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    const instance = await store.createInstance(creation());

    expect(instance).toMatchObject({ id: 'i1', processKey: 'Pedido', version: 1, seq: 1 });
    expect(await store.readInstance('i1')).toMatchObject({ status: 'waiting', seq: 1 });
    expect(await store.readInstanceState('i1')).toEqual({
      seq: 1,
      engineVersion: 10,
      json: '{"version":10,"steps":1}',
    });
    store.close();
  });

  it('numera cada comando aplicado a partir de 1', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await store.createInstance(creation());

    const after = await store.append({
      instanceId: 'i1',
      status: 'completed',
      command: { type: 'completeTask', payload: { tokenId: 't1' }, at: 1_700_000_001_000 },
      state: { engineVersion: 10, json: '{"version":10,"steps":2}' },
    });

    expect(after).toMatchObject({ seq: 2, status: 'completed' });
    expect(await store.readInstanceState('i1')).toMatchObject({ seq: 2 });
    store.close();
  });

  it('recusa uma instância de uma versão que não está publicada', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await expect(store.createInstance({ ...creation(), version: 7 })).rejects.toThrow();
    store.close();
  });

  it('não avança journal nem estado quando a escrita falha no meio', async () => {
    /** Grava o primeiro estado e falha do segundo em diante. */
    class FailsOnSecondState extends SqliteStore {
      private writes = 0;

      protected override writeEngineState(
        instanceId: string,
        seq: number,
        state: EngineStateInput,
      ): void {
        this.writes += 1;
        if (this.writes > 1) throw new Error('disco cheio no meio da escrita');
        super.writeEngineState(instanceId, seq, state);
      }
    }

    const store = await seeded(new FailsOnSecondState({ path: join(dir, 'ebb.db') }));
    await store.createInstance(creation());

    await expect(
      store.append({
        instanceId: 'i1',
        status: 'completed',
        command: { type: 'completeTask', payload: { tokenId: 't1' }, at: 1_700_000_001_000 },
        state: { engineVersion: 10, json: '{"version":10,"steps":2}' },
      }),
    ).rejects.toThrow('disco cheio');

    // Nem um nem o outro: a entrada do journal não pode sobreviver ao estado
    // que ela deveria ter produzido.
    expect(await store.readInstance('i1')).toMatchObject({ seq: 1, status: 'waiting' });
    expect(await store.readInstanceState('i1')).toMatchObject({ seq: 1 });
    expect(await store.journal('i1')).toHaveLength(1);
    store.close();
  });
});

// Os testes acima só exercitam o caminho feliz dos mapeadores e das leituras;
// o gate de cobertura do repo (85% de branch) cobra os desvios que eles não
// tocam — não fazem parte do brief, mas sem eles o `npm run verify` fica vermelho.
describe('mapeamento de linha do banco', () => {
  it('rejeita um status que este código não conhece', () => {
    expect(() =>
      toInstance({
        id: 'i1',
        process_key: 'Pedido',
        version: 1,
        status: 'bogus',
        seq: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow('status');
  });

  it('rejeita um payload de journal que não é um objeto JSON', () => {
    expect(() =>
      toJournalEntry({
        seq: 1,
        type: 'start',
        payload: '[1,2,3]',
        at: 1,
        recorded_at: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow('objeto JSON');
  });
});

describe('leituras e escritas sem a instância', () => {
  it('devolve undefined quando a instância ou o estado não existem', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    expect(await store.readInstance('fantasma')).toBeUndefined();
    expect(await store.readInstanceState('fantasma')).toBeUndefined();
    store.close();
  });

  it('append rejeita uma instância inexistente', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await expect(
      store.append({
        instanceId: 'fantasma',
        status: 'completed',
        command: { type: 'completeTask', payload: {}, at: 1 },
        state: { engineVersion: 1, json: '{}' },
      }),
    ).rejects.toThrow('Nenhuma instância');
    store.close();
  });
});
