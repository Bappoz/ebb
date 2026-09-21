import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksumOf } from '../src/checksum.js';
import { toJob } from '../src/jobs.js';
import { SqliteStore } from '../src/sqlite.js';
import type { AppendInput, InstanceRecord, JobProjection, JobRecord } from '../src/types.js';

const XML = '<definitions><process id="Pedido" /></definitions>';
const VARS = { pedido: 42 };
const CMD = { type: 'completeTask', payload: { tokenId: 't1' }, at: 1_700_000_001_000 };
const STATE = { engineVersion: 10, json: '{"version":10,"steps":2}' };

/** Uma linha crua de `jobs`, válida, para os testes de mapeamento. */
const ROW = {
  instance_id: 'i1',
  token_id: 't1',
  node_id: 'Charge',
  type: 'charge',
  variables: JSON.stringify(VARS),
  state: 'pending',
  worker: null,
  locked_until: null,
  attempts: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

let dir: string;
let store: SqliteStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-jobs-'));
  store = new SqliteStore({ path: join(dir, 'ebb.db') });
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function projection(tokenId: string, attempts = 0): JobProjection {
  return { tokenId, nodeId: 'Charge', type: 'charge', variables: VARS, attempts };
}

/** Publica `Pedido` v1 e cria uma instância já com os jobs dados. */
async function seeded(
  input: { jobs: JobProjection[] } = { jobs: [] },
): Promise<{ store: SqliteStore; instance: InstanceRecord }> {
  await store.deploy({ processKey: 'Pedido', xml: XML, checksum: checksumOf(XML) });
  const instance = await store.createInstance({
    id: 'i1',
    processKey: 'Pedido',
    version: 1,
    status: 'waiting',
    command: { type: 'start', payload: { variables: VARS }, at: 1_700_000_000_000 },
    state: { engineVersion: 10, json: '{"version":10,"steps":1}' },
    jobs: input.jobs,
  });
  return { store, instance };
}

/** `append` que preenche tudo, exceto o que o chamador quer variar. */
function appendOf(overrides: Partial<AppendInput> & { instanceId: string }): AppendInput {
  return { status: 'waiting', command: CMD, state: STATE, jobs: [], ...overrides };
}

describe('jobs', () => {
  it('nasce da criação da instância', async () => {
    const { instance } = await seeded({ jobs: [projection('t1')] });
    expect(await store.listJobs()).toMatchObject([
      { instanceId: instance.id, tokenId: 't1', type: 'charge', state: 'pending' },
    ]);
  });

  it('a reconciliação apaga o que saiu e insere o que entrou', async () => {
    const { instance } = await seeded({ jobs: [projection('t1')] });
    await store.append(appendOf({ instanceId: instance.id, jobs: [projection('t2')] }));

    expect(await store.listJobs()).toMatchObject([{ tokenId: 't2' }]);
  });

  it('a reconciliação preserva a trava de um job que continua parado', async () => {
    const { instance } = await seeded({ jobs: [projection('t1')] });
    const [locked] = await store.lockJobs({
      type: 'charge',
      worker: 'w1',
      count: 1,
      until: 5_000,
      now: 1_000,
    });
    await store.append(appendOf({ instanceId: instance.id, jobs: [projection('t1')] }));

    expect(locked).toMatchObject({ state: 'locked', worker: 'w1', lockedUntil: 5_000 });
    expect(await store.listJobs()).toMatchObject([{ state: 'locked', worker: 'w1' }]);
  });

  it('a reconciliação atualiza node_id e type de um job que sobrevive', async () => {
    const { instance } = await seeded({ jobs: [projection('t1')] });
    await store.append(
      appendOf({
        instanceId: instance.id,
        jobs: [{ ...projection('t1'), nodeId: 'Ship', type: 'ship' }],
      }),
    );

    expect(await store.listJobs()).toMatchObject([{ tokenId: 't1', nodeId: 'Ship', type: 'ship' }]);
  });

  it('não entrega duas vezes o mesmo job', async () => {
    await seeded({ jobs: [projection('t1')] });
    const first = await store.lockJobs({
      type: 'charge',
      worker: 'w1',
      count: 5,
      until: 5_000,
      now: 1_000,
    });
    const second = await store.lockJobs({
      type: 'charge',
      worker: 'w2',
      count: 5,
      until: 5_000,
      now: 1_000,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('devolve o job cuja trava venceu', async () => {
    await seeded({ jobs: [projection('t1')] });
    await store.lockJobs({ type: 'charge', worker: 'w1', count: 1, until: 5_000, now: 1_000 });

    const retaken = await store.lockJobs({
      type: 'charge',
      worker: 'w2',
      count: 1,
      until: 12_000,
      now: 6_000,
    });

    expect(retaken).toMatchObject([{ worker: 'w2', lockedUntil: 12_000 }]);
  });

  it('devolve o job cuja trava vence exatamente agora', async () => {
    await seeded({ jobs: [projection('t1')] });
    await store.lockJobs({ type: 'charge', worker: 'w1', count: 1, until: 5_000, now: 1_000 });

    // `locked_until <= now`: uma trava que vence neste instante já é resgatável,
    // não só a que já ficou para trás.
    const retaken = await store.lockJobs({
      type: 'charge',
      worker: 'w2',
      count: 1,
      until: 12_000,
      now: 5_000,
    });

    expect(retaken).toMatchObject([{ worker: 'w2' }]);
  });

  it('recusa travar com um "until" que não é depois de "now"', async () => {
    await seeded({ jobs: [projection('t1')] });
    await expect(
      store.lockJobs({ type: 'charge', worker: 'w1', count: 1, until: 1_000, now: 1_000 }),
    ).rejects.toThrow(/until/);
  });

  it('não entrega o mesmo job a dois processos disputando o mesmo arquivo', async () => {
    await seeded({ jobs: [projection('t1')] });
    // Uma segunda conexão para o mesmo arquivo simula um segundo `ebb worker`:
    // o `store` do teste e este `second` não compartilham nem transação nem
    // memória, só o disco — a mesma disputa de um processo de verdade.
    const second = new SqliteStore({ path: join(dir, 'ebb.db') });
    try {
      const results = await Promise.allSettled([
        store.lockJobs({ type: 'charge', worker: 'w1', count: 1, until: 5_000, now: 1_000 }),
        second.lockJobs({ type: 'charge', worker: 'w2', count: 1, until: 5_000, now: 1_000 }),
      ]);

      for (const result of results) {
        if (result.status === 'rejected') {
          throw new Error(
            `lockJobs lançou em vez de esperar a trava do outro processo — o busy timeout ` +
              `não está funcionando: ${String(result.reason)}`,
          );
        }
      }

      const jobs = (results as PromiseFulfilledResult<JobRecord[]>[]).flatMap((r) => r.value);
      expect(jobs).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('filtra por tipo e por instância', async () => {
    const { instance } = await seeded({
      jobs: [projection('t1'), { ...projection('t2'), type: 'ship' }],
    });
    expect(await store.listJobs({ type: 'ship' })).toHaveLength(1);
    expect(await store.listJobs({ instanceId: instance.id })).toHaveLength(2);
    expect(await store.listJobs({ instanceId: 'outra' })).toHaveLength(0);
  });
});

// Caminho feliz dos testes acima só passa por `state` válido; o gate de
// cobertura do repo cobra o desvio que ele não toca.
describe('mapeamento de linha do banco', () => {
  it('rejeita um estado que este código não conhece', () => {
    expect(() => toJob({ ...ROW, state: 'zumbi' })).toThrow(TypeError);
  });
});
