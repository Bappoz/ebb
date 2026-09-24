import { checksumOf, SqliteStore } from '@ebb/store';
import { describe, expect, it } from 'vitest';
import { InstanceNotFoundError } from '../src/errors.js';
import { ReplayRangeError } from '../src/replay.js';
import { EbbRuntime } from '../src/runtime.js';
import { EXTERNAL_JOB, GATEWAY } from './fixtures.js';

const AT = 1_700_000_000_000;

async function fixture() {
  const store = new SqliteStore({ path: ':memory:', now: () => new Date(AT) });
  await store.deploy({ processKey: 'Aprovacao', xml: GATEWAY, checksum: checksumOf(GATEWAY) });
  await store.deploy({ processKey: 'Job', xml: EXTERNAL_JOB, checksum: checksumOf(EXTERNAL_JOB) });
  let ids = 0;
  const runtime = new EbbRuntime({ store, now: () => new Date(AT), newId: () => `inst-${++ids}` });
  return { store, runtime };
}

/** Aprovação de valor alto, concluída: inst-1 com três comandos. Devolve o token de Avaliar. */
async function approvedHigh(runtime: EbbRuntime): Promise<string> {
  const started = await runtime.start('Aprovacao');
  const avaliar = started.tasks[0]?.tokenId ?? '';
  const high = await runtime.apply('inst-1', {
    type: 'completeTask',
    tokenId: avaliar,
    output: { valor: 150 },
  });
  await runtime.apply('inst-1', { type: 'completeTask', tokenId: high.tasks[0]?.tokenId ?? '' });
  return avaliar;
}

describe('EbbRuntime.replay', () => {
  it('devolve todos os passos, o xml da versão congelada e a instância', async () => {
    const { store, runtime } = await fixture();
    await approvedHigh(runtime);

    const view = await runtime.replay('inst-1');

    expect(view.instance.id).toBe('inst-1');
    expect(view.xml).toBe(GATEWAY);
    expect(view.steps.map((step) => step.command.type)).toEqual([
      'start',
      'completeTask',
      'completeTask',
    ]);
    expect(view.steps[1]?.decisions[0]?.taken).toEqual(['Flow_Alto']);
    store.close();
  });

  it('corta em upTo e não escreve nada', async () => {
    const { store, runtime } = await fixture();
    await approvedHigh(runtime);
    const before = await store.readInstanceState('inst-1');

    const view = await runtime.replay('inst-1', 1);

    expect(view.steps).toHaveLength(1);
    expect(await store.readInstanceState('inst-1')).toEqual(before);
    store.close();
  });

  it('diz quando a instância não existe', async () => {
    const { store, runtime } = await fixture();
    await expect(runtime.replay('nada')).rejects.toThrow(InstanceNotFoundError);
    store.close();
  });
});

describe('EbbRuntime.fork', () => {
  it('bifurca no passo 1 e segue por outro ramo, sem tocar a original', async () => {
    const { store, runtime } = await fixture();
    const avaliar = await approvedHigh(runtime);
    const originalJournal = await store.journal('inst-1');

    const forked = await runtime.fork('inst-1', 1);
    expect(forked.instance).toMatchObject({
      id: 'inst-2',
      seq: 1,
      forkedFrom: 'inst-1',
      forkedAt: 1,
    });
    // O mesmo token existe na bifurcação: ids do motor são determinísticos.
    expect(forked.tasks.map((task) => task.tokenId)).toEqual([avaliar]);

    const low = await runtime.apply('inst-2', {
      type: 'completeTask',
      tokenId: avaliar,
      output: { valor: 50 },
    });
    expect(low.snapshot.status).toBe('completed');
    expect(low.snapshot.completedNodes).toContain('EndBaixo');
    expect(await store.journal('inst-1')).toEqual(originalJournal);
    store.close();
  });

  it('aplica o comando novo quando vem junto', async () => {
    const { store, runtime } = await fixture();
    const avaliar = await approvedHigh(runtime);

    const forked = await runtime.fork('inst-1', 1, {
      type: 'completeTask',
      tokenId: avaliar,
      output: { valor: 50 },
    });

    expect(forked.instance).toMatchObject({ id: 'inst-2', seq: 2, forkedFrom: 'inst-1' });
    expect(forked.snapshot.status).toBe('completed');
    store.close();
  });

  it('bifurca de uma bifurcação apontando para a intermediária', async () => {
    const { store, runtime } = await fixture();
    const avaliar = await approvedHigh(runtime);
    await runtime.fork('inst-1', 1);
    await runtime.apply('inst-2', {
      type: 'completeTask',
      tokenId: avaliar,
      output: { valor: 50 },
    });

    const again = await runtime.fork('inst-2', 2);

    expect(again.instance).toMatchObject({ id: 'inst-3', forkedFrom: 'inst-2', forkedAt: 2 });
    expect(again.snapshot.status).toBe('completed');
    store.close();
  });

  it('leva o job pendente do corte para a bifurcação, livre de trava', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Job');
    await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    const forked = await runtime.fork('inst-1', 1);

    expect(await store.listJobs({ instanceId: forked.instance.id })).toMatchObject([
      { nodeId: 'Charge', state: 'pending' },
    ]);
    expect(await store.listJobs({ instanceId: 'inst-1' })).toMatchObject([
      { state: 'locked', worker: 'w1' },
    ]);
    store.close();
  });

  it('recusa passo fora do journal', async () => {
    const { store, runtime } = await fixture();
    await approvedHigh(runtime);
    await expect(runtime.fork('inst-1', 9)).rejects.toThrow(ReplayRangeError);
    expect(await store.readInstance('inst-2')).toBeUndefined();
    store.close();
  });
});
