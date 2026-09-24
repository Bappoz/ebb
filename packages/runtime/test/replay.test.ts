import { checksumOf, SqliteStore } from '@ebb/store';
import type { JournalEntry } from '@ebb/store';
import { describe, expect, it } from 'vitest';
import { commandFromEntry, JournalShapeError } from '../src/commands.js';
import { replayJournal, ReplayRangeError } from '../src/replay.js';
import { EbbRuntime } from '../src/runtime.js';
import { EXTERNAL_JOB, GATEWAY, JOB_WITH_BOUNDARY, PEDIDO, TIMER } from './fixtures.js';

const AT = 1_700_000_000_000;
const HOUR = 3_600_000;

const XML: Record<string, string> = {
  Pedido: PEDIDO,
  Aprovacao: GATEWAY,
  Espera: TIMER,
  Job: EXTERNAL_JOB,
  JobBoundary: JOB_WITH_BOUNDARY,
};

async function fixture() {
  const store = new SqliteStore({ path: ':memory:', now: () => new Date(AT) });
  for (const [processKey, xml] of Object.entries(XML)) {
    await store.deploy({ processKey, xml, checksum: checksumOf(xml) });
  }
  let ids = 0;
  const runtime = new EbbRuntime({ store, now: () => new Date(AT), newId: () => `inst-${++ids}` });
  return { store, runtime };
}

/** O primeiro item, falhando alto se não houver. */
function first<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('esperava ao menos um item');
  return item;
}

type Scenario = (runtime: EbbRuntime) => Promise<string>;

/**
 * Roteiros que passam por cada tipo de comando. Cada um devolve o id da
 * instância; o estado ao vivo de cada passo é o que o store gravou.
 */
const SCENARIOS: Record<string, Scenario> = {
  'tarefa simples': async (runtime) => {
    const started = await runtime.start('Pedido', { variables: { total: 42 } });
    await runtime.apply(started.instance.id, {
      type: 'completeTask',
      tokenId: first(started.tasks).tokenId,
    });
    return started.instance.id;
  },
  'gateway exclusivo': async (runtime) => {
    const started = await runtime.start('Aprovacao');
    const id = started.instance.id;
    const avaliado = await runtime.apply(id, {
      type: 'completeTask',
      tokenId: first(started.tasks).tokenId,
      output: { valor: 150 },
    });
    await runtime.apply(id, {
      type: 'completeTask',
      tokenId: first(avaliado.tasks).tokenId,
      output: { valor: 999 },
    });
    return id;
  },
  'timer com relógio andando': async (runtime) => {
    const started = await runtime.start('Espera');
    const id = started.instance.id;
    await runtime.apply(id, { type: 'tick' }, AT + HOUR / 2);
    await runtime.apply(id, { type: 'tick' }, AT + HOUR);
    return id;
  },
  'retry até incidente e resolução': async (runtime) => {
    const started = await runtime.start('Job', { engine: { retry: { attempts: 1 } } });
    const id = started.instance.id;
    const again = await runtime.failJob(id, first(started.tasks).tokenId, { message: 'timeout' });
    const stuck = await runtime.failJob(id, first(again.tasks).tokenId, { message: 'timeout' });
    await runtime.apply(id, {
      type: 'resolveIncident',
      tokenId: first(stuck.incidents).tokenId,
      output: { manual: true },
    });
    return id;
  },
  'erro de negócio no boundary': async (runtime) => {
    const started = await runtime.start('JobBoundary');
    await runtime.failJob(started.instance.id, first(started.tasks).tokenId, {
      message: 'recusado',
      code: 'DECLINED',
    });
    return started.instance.id;
  },
};

function scenario(name: string): Scenario {
  const found = SCENARIOS[name];
  if (!found) throw new Error(`roteiro desconhecido: ${name}`);
  return found;
}

describe('replayJournal — equivalência com o caminho ao vivo', () => {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(`reconstrói cada passo de: ${name}`, async () => {
      const { store, runtime } = await fixture();
      // O store só guarda o último snapshot, então o ao vivo de cada passo é
      // capturado relendo-o depois de cada comando do roteiro.
      const live: unknown[] = [];
      const capture = async (id: string) => {
        const stored = await store.readInstanceState(id);
        live.push(JSON.parse(stored?.json ?? 'null'));
      };
      const apply = runtime.apply.bind(runtime);
      runtime.apply = async (...args) => {
        const result = await apply(...args);
        await capture(result.instance.id);
        return result;
      };
      const start = runtime.start.bind(runtime);
      runtime.start = async (...args) => {
        const result = await start(...args);
        await capture(result.instance.id);
        return result;
      };

      const id = await run(runtime);
      const instance = await store.readInstance(id);
      const journal = await store.journal(id);
      const xml = XML[instance?.processKey ?? ''] ?? '';

      expect(journal).toHaveLength(live.length);
      for (let seq = 1; seq <= journal.length; seq++) {
        const { engine } = await replayJournal(xml, journal, { upTo: seq });
        expect(engine.getState(), `passo ${seq}`).toEqual(live[seq - 1]);
      }
      store.close();
    });
  }
});

describe('replayJournal — o que cada passo explica', () => {
  it('grava a razão do gateway com as variáveis daquele instante', async () => {
    const { store, runtime } = await fixture();
    const id = await scenario('gateway exclusivo')(runtime);
    const { steps } = await replayJournal(GATEWAY, await store.journal(id));

    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3]);
    const [, second, third] = steps;
    const decision = second?.decisions[0];
    expect(decision).toMatchObject({
      nodeId: 'Gateway_Valor',
      name: 'Valor alto?',
      taken: ['Flow_Alto'],
      variables: { valor: 150 },
    });
    expect(decision?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flowId: 'Flow_Alto',
          condition: 'valor > 100',
          isDefault: false,
        }),
        expect.objectContaining({ flowId: 'Flow_Baixo', isDefault: true }),
      ]),
    );
    // O passo 3 reescreveu `valor`; o traço do passo 2 não pode ter mudado junto.
    expect(third?.snapshot.variables).toMatchObject({ valor: 999 });
    expect(second?.flows).toContain('Flow_Alto');
    expect(second?.entered.map((entry) => entry.nodeId)).toContain('Diretoria');
    store.close();
  });

  it('reinjeta o at de cada comando no relógio do motor', async () => {
    const { store, runtime } = await fixture();
    const id = await scenario('timer com relógio andando')(runtime);
    const { steps } = await replayJournal(TIMER, await store.journal(id));
    const [, second, third] = steps;

    expect(second?.snapshot.status).toBe('waiting');
    expect(second?.entered).toEqual([]);
    const conferir = third?.entered.find(
      (entry) => entry.nodeId === 'Conferir' && entry.event === 'enter',
    );
    expect(conferir?.at).toBe(AT + HOUR);
    store.close();
  });

  it('para no passo pedido', async () => {
    const { store, runtime } = await fixture();
    const id = await scenario('gateway exclusivo')(runtime);
    const { steps, engine } = await replayJournal(GATEWAY, await store.journal(id), { upTo: 2 });

    expect(steps).toHaveLength(2);
    expect(engine.tasks().map((task) => task.nodeId)).toEqual(['Diretoria']);
    store.close();
  });

  it.each([0, 4, 1.5, -1])('recusa upTo fora do journal (%s)', async (upTo) => {
    const { store, runtime } = await fixture();
    const id = await scenario('gateway exclusivo')(runtime);
    const journal = await store.journal(id);

    await expect(replayJournal(GATEWAY, journal, { upTo })).rejects.toThrow(ReplayRangeError);
    await expect(replayJournal(GATEWAY, journal, { upTo })).rejects.toThrow(/\[1, 3\]/);
    store.close();
  });

  it('recusa journal vazio', async () => {
    await expect(replayJournal(GATEWAY, [])).rejects.toThrow(ReplayRangeError);
  });

  // O journal que começa por outra coisa que `start` é corrupção, não journal.
  it('recusa journal que não começa por start', async () => {
    const journal: JournalEntry[] = [
      { seq: 1, type: 'tick', payload: {}, at: AT, recordedAt: '2026-01-01T00:00:00.000Z' },
    ];
    await expect(replayJournal(PEDIDO, journal)).rejects.toThrow(/Entrada 1.*start/);
  });
});

describe('commandFromEntry', () => {
  const entry = (type: string, payload: Record<string, unknown>, seq = 2) => ({
    seq,
    type,
    payload,
  });
  const ENGINE = {
    mode: 'automation',
    maxSteps: 10_000,
    expressions: 'safe',
    onHandlerError: 'incident',
    retry: { attempts: 0 },
  };

  it('reconstrói cada tipo de comando', () => {
    expect(commandFromEntry(entry('start', { engine: ENGINE, variables: { a: 1 } }, 1))).toEqual({
      type: 'start',
      engine: ENGINE,
      variables: { a: 1 },
    });
    expect(commandFromEntry(entry('completeTask', { tokenId: 't1', output: { x: 1 } }))).toEqual({
      type: 'completeTask',
      tokenId: 't1',
      output: { x: 1 },
    });
    expect(commandFromEntry(entry('signal', { name: 'Pago' }))).toEqual({
      type: 'signal',
      name: 'Pago',
    });
    expect(commandFromEntry(entry('tick', {}))).toEqual({ type: 'tick' });
    expect(commandFromEntry(entry('completeJob', { tokenId: 't1' }))).toEqual({
      type: 'completeJob',
      tokenId: 't1',
    });
    expect(
      commandFromEntry(entry('failJob', { tokenId: 't1', error: { message: 'x', code: 'C' } })),
    ).toEqual({ type: 'failJob', tokenId: 't1', error: { message: 'x', code: 'C' } });
    expect(commandFromEntry(entry('retryTask', { tokenId: 't1' }))).toEqual({
      type: 'retryTask',
      tokenId: 't1',
    });
    expect(commandFromEntry(entry('resolveIncident', { tokenId: 't1' }))).toEqual({
      type: 'resolveIncident',
      tokenId: 't1',
    });
  });

  it.each([
    [entry('completeTask', {}), /Entrada 2.*tokenId/],
    [entry('failJob', { tokenId: 't1', error: {} }), /Entrada 2.*error\.message/],
    [entry('failJob', { tokenId: 't1', error: { message: 'x', code: 7 } }), /error\.code/],
    [entry('signal', { name: 'x', output: 'nope' }), /Entrada 2.*output/],
    [entry('start', { variables: {} }, 1), /Entrada 1.*engine/],
    [entry('teleport', {}), /Entrada 2.*type/],
  ])('falha dizendo seq e campo (%#)', (bad, message) => {
    expect(() => commandFromEntry(bad)).toThrow(JournalShapeError);
    expect(() => commandFromEntry(bad)).toThrow(message);
  });
});
