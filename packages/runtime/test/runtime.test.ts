import { ENGINE_STATE_VERSION } from '@bpmn-flow/core';
import { checksumOf, SqliteStore } from '@ebb/store';
import { describe, expect, it } from 'vitest';
import { EngineStateMismatchError, InstanceNotFoundError } from '../src/errors.js';
import { EbbRuntime } from '../src/runtime.js';
import { PEDIDO } from './fixtures.js';

const AT = 1_700_000_000_000;

/** Uma loja com o `Pedido` publicado e um runtime de relógio e id fixos. */
async function fixture(): Promise<{ store: SqliteStore; runtime: EbbRuntime }> {
  const store = new SqliteStore({ path: ':memory:', now: () => new Date(AT) });
  await store.deploy({ processKey: 'Pedido', xml: PEDIDO, checksum: checksumOf(PEDIDO) });
  let ids = 0;
  const runtime = new EbbRuntime({
    store,
    now: () => new Date(AT),
    newId: () => `inst-${++ids}`,
  });
  return { store, runtime };
}

describe('EbbRuntime.start', () => {
  it('cria a instância parada na tarefa, com as variáveis iniciais', async () => {
    const { store, runtime } = await fixture();
    const result = await runtime.start('Pedido', { variables: { total: 42 } });

    expect(result.instance).toMatchObject({
      id: 'inst-1',
      processKey: 'Pedido',
      version: 1,
      seq: 1,
    });
    expect(result.snapshot.status).toBe('waiting');
    expect(result.tasks.map((task) => task.nodeId)).toEqual(['Separar']);
    expect(result.snapshot.variables).toMatchObject({ total: 42 });
    store.close();
  });

  it('grava o comando start com as variáveis, para o replay reconstruir o motor', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido', { variables: { total: 42 } });

    const [first] = await store.journal('inst-1');
    expect(first).toMatchObject({ seq: 1, type: 'start', at: AT });
    expect(first?.payload).toEqual({
      variables: { total: 42 },
      engine: { mode: 'automation', maxSteps: 100_000, expressions: 'safe' },
    });
    store.close();
  });

  it('grava mode, maxSteps e expressions com que o motor nasceu, não só as variáveis', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido');

    const [first] = await store.journal('inst-1');
    const payload = first?.payload as {
      engine?: { mode: string; maxSteps: number; expressions: string };
    };
    expect(payload.engine).toEqual({ mode: 'automation', maxSteps: 100_000, expressions: 'safe' });
    store.close();
  });

  it('recusa uma chave que não está publicada', async () => {
    const { store, runtime } = await fixture();
    await expect(runtime.start('Inexistente')).rejects.toThrow('Inexistente');
    store.close();
  });

  it('nomeia a versão pedida quando ela não está publicada', async () => {
    const { store, runtime } = await fixture();
    await expect(runtime.start('Pedido', { version: 7 })).rejects.toThrow('Pedido v7');
    store.close();
  });
});

describe('EbbRuntime.apply', () => {
  it('continua de onde o comando anterior parou, sem motor em memória', async () => {
    const { store, runtime } = await fixture();
    const started = await runtime.start('Pedido');
    const [task] = started.tasks;
    if (!task) throw new Error('nenhuma tarefa pendente');

    const done = await runtime.apply('inst-1', {
      type: 'completeTask',
      tokenId: task.tokenId,
      output: { separadoPor: 'ana' },
    });

    expect(done.snapshot.status).toBe('completed');
    expect(done.instance).toMatchObject({ seq: 2, status: 'completed' });
    expect(done.snapshot.variables).toMatchObject({ separadoPor: 'ana' });
    store.close();
  });

  it('reclama de uma instância que não existe', async () => {
    const { store, runtime } = await fixture();
    await expect(runtime.apply('sumiu', { type: 'tick' })).rejects.toThrow(InstanceNotFoundError);
    store.close();
  });
});

describe('o relógio congelado', () => {
  it('carimba todo o histórico de um comando com o instante que o journal gravou', async () => {
    const { store, runtime } = await fixture();
    const started = await runtime.start('Pedido');

    const [entry] = await store.journal('inst-1');
    // O motor lê o relógio uma vez por entrada de histórico; com um relógio de
    // parede cada entrada teria um instante próprio e o replay divergiria.
    expect(started.snapshot.history.length).toBeGreaterThan(1);
    for (const record of started.snapshot.history) expect(record.at).toBe(entry?.at);
    store.close();
  });

  it('usa o instante explícito quando o chamador dá um', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido');
    await runtime.apply('inst-1', { type: 'tick' }, AT + 60_000);

    const entries = await store.journal('inst-1');
    expect(entries[1]).toMatchObject({ type: 'tick', at: AT + 60_000 });
    // O relógio de parede é outro campo e continua sendo o de verdade.
    expect(entries[1]?.recordedAt).toBe(new Date(AT).toISOString());
    store.close();
  });

  it('carimba as entradas de histórico novas de um apply com o instante explícito', async () => {
    const { store, runtime } = await fixture();
    const started = await runtime.start('Pedido');
    const [task] = started.tasks;
    if (!task) throw new Error('nenhuma tarefa pendente');
    const before = started.snapshot.history.length;

    const at = AT + 60_000;
    const done = await runtime.apply('inst-1', { type: 'completeTask', tokenId: task.tokenId }, at);

    // Isola só o que o completeTask acrescentou, para não reconferir o que o
    // start já tinha carimbado com AT.
    const added = done.snapshot.history.slice(before);
    expect(added.length).toBeGreaterThan(0);
    for (const record of added) expect(record.at).toBe(at);
    store.close();
  });
});

describe('EbbRuntime.inspect', () => {
  it('devolve estado, tarefas e journal sem aplicar nada', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido', { variables: { total: 42 } });

    const view = await runtime.inspect('inst-1');
    expect(view.instance.seq).toBe(1);
    expect(view.snapshot.variables).toMatchObject({ total: 42 });
    expect(view.tasks.map((task) => task.nodeId)).toEqual(['Separar']);
    expect(view.journal).toHaveLength(1);
    store.close();
  });

  it('falha com a própria mensagem quando o esquema do motor mudou', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido');
    // Simula um ebb atualizado lendo o que a versão anterior gravou.
    await store.append({
      instanceId: 'inst-1',
      status: 'waiting',
      command: { type: 'tick', payload: {}, at: AT },
      state: { engineVersion: ENGINE_STATE_VERSION - 1, json: '{}' },
      jobs: [],
    });

    await expect(runtime.inspect('inst-1')).rejects.toThrow(EngineStateMismatchError);
    await expect(runtime.inspect('inst-1')).rejects.toThrow(/journal está intacto/);
    store.close();
  });
});

describe('a versão congelada', () => {
  it('continua na versão com que começou, mesmo depois de um redeploy', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido');

    const v2 = PEDIDO.replace('Separar itens', 'Separar e conferir');
    await store.deploy({ processKey: 'Pedido', xml: v2, checksum: checksumOf(v2) });

    // A instância viva continua com o modelo v1: publicar não pode trocar o
    // desenho debaixo de quem já está rodando.
    const view = await runtime.inspect('inst-1');
    expect(view.instance.version).toBe(1);
    expect(view.tasks[0]?.name).toBe('Separar itens');
    store.close();
  });
});
