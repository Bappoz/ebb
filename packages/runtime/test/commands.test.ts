import { parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type { ProcessModel } from '@bpmn-flow/core';
import { describe, expect, it } from 'vitest';
import { applyCommand, payloadOf, type StartEngineOptions } from '../src/commands.js';
import { EXTERNAL_JOB, JOB_WITH_BOUNDARY, PEDIDO } from './fixtures.js';

const ENGINE_OPTIONS: StartEngineOptions = {
  mode: 'automation',
  maxSteps: 100_000,
  expressions: 'safe',
  onHandlerError: 'fail',
  retry: { attempts: 0 },
};

async function pedido(): Promise<ProcessModel> {
  const [first] = (await parseBpmn(PEDIDO)).processes;
  if (!first) throw new Error('fixture sem processo');
  return first;
}

async function job(): Promise<ProcessModel> {
  const [first] = (await parseBpmn(EXTERNAL_JOB)).processes;
  if (!first) throw new Error('fixture sem processo');
  return first;
}

async function jobWithBoundary(): Promise<ProcessModel> {
  const [first] = (await parseBpmn(JOB_WITH_BOUNDARY)).processes;
  if (!first) throw new Error('fixture sem processo');
  return first;
}

/** Motor num job externo já em espera, com a política de falha pedida. */
async function startedOnJob(
  engineOptions: { onHandlerError?: 'fail' | 'incident'; retry?: { attempts: number } } = {},
): Promise<WorkflowEngine> {
  const engine = new WorkflowEngine(await job(), engineOptions);
  await applyCommand(engine, {
    type: 'start',
    engine: {
      ...ENGINE_OPTIONS,
      onHandlerError: engineOptions.onHandlerError ?? 'fail',
      retry: engineOptions.retry ?? { attempts: 0 },
    },
  });
  return engine;
}

/** O mesmo, mas no diagrama que tem boundary de erro para negar o pedido. */
async function startedOnJobWithBoundary(): Promise<WorkflowEngine> {
  const engine = new WorkflowEngine(await jobWithBoundary());
  await applyCommand(engine, { type: 'start', engine: ENGINE_OPTIONS });
  return engine;
}

describe('applyCommand', () => {
  it('start leva a execução até o primeiro ponto de espera', async () => {
    const engine = new WorkflowEngine(await pedido(), { variables: { total: 42 } });
    // Valores diferentes de propósito: as variáveis do comando existem para o
    // replay reconstruir o motor, e `applyCommand` não as lê. Se lesse, o
    // snapshot mostraria 999.
    const snapshot = await applyCommand(engine, {
      type: 'start',
      variables: { total: 999 },
      engine: ENGINE_OPTIONS,
    });

    expect(snapshot.status).toBe('waiting');
    expect(snapshot.variables).toMatchObject({ total: 42 });
  });

  it('completeTask conclui a tarefa parada e segue', async () => {
    const engine = new WorkflowEngine(await pedido());
    await applyCommand(engine, { type: 'start', engine: ENGINE_OPTIONS });
    const [task] = engine.tasks();
    if (!task) throw new Error('nenhuma tarefa pendente');

    const snapshot = await applyCommand(engine, {
      type: 'completeTask',
      tokenId: task.tokenId,
      output: { separadoPor: 'ana' },
    });

    expect(snapshot.status).toBe('completed');
    expect(snapshot.variables).toMatchObject({ separadoPor: 'ana' });
  });

  it('tick usa o relógio congelado do motor, sem argumento próprio', async () => {
    const engine = new WorkflowEngine(await pedido(), { now: () => 1_700_000_000_000 });
    await applyCommand(engine, { type: 'start', engine: ENGINE_OPTIONS });

    // Nada vencido: tick é uma não-operação, e não pode explodir por isso.
    const snapshot = await applyCommand(engine, { type: 'tick' });
    expect(snapshot.status).toBe('waiting');
  });

  it('signal recusa um evento que o diagrama não tem', async () => {
    const engine = new WorkflowEngine(await pedido());
    await applyCommand(engine, { type: 'start', engine: ENGINE_OPTIONS });

    await expect(applyCommand(engine, { type: 'signal', name: 'Inexistente' })).rejects.toThrow();
  });
});

describe('applyCommand dos comandos de job', () => {
  it('completeJob conclui a atividade parada no worker', async () => {
    const engine = await startedOnJob();
    const [task] = engine.tasks({ reason: 'job' });

    const snap = await applyCommand(engine, {
      type: 'completeJob',
      tokenId: task!.tokenId,
      output: { authorized: true },
    });

    expect(snap.status).toBe('completed');
    expect(snap.variables).toMatchObject({ authorized: true });
  });

  it('failJob sem código vira falha técnica', async () => {
    const engine = await startedOnJob({ onHandlerError: 'incident' });
    const [task] = engine.tasks({ reason: 'job' });

    await applyCommand(engine, {
      type: 'failJob',
      tokenId: task!.tokenId,
      error: { message: 'gateway timeout' },
    });

    expect(engine.incidentList()).toMatchObject([{ message: 'gateway timeout' }]);
  });

  it('failJob com código vira erro de negócio', async () => {
    const engine = await startedOnJobWithBoundary();
    const [task] = engine.tasks({ reason: 'job' });

    const snap = await applyCommand(engine, {
      type: 'failJob',
      tokenId: task!.tokenId,
      error: { message: 'recusado', code: 'DECLINED' },
    });

    expect(snap.completedNodes).toContain('Declined');
  });

  it('retryTask devolve o job em incidente para uma nova tentativa', async () => {
    const engine = await startedOnJob({ onHandlerError: 'incident' });
    const [task] = engine.tasks({ reason: 'job' });
    await applyCommand(engine, {
      type: 'failJob',
      tokenId: task!.tokenId,
      error: { message: 'gateway timeout' },
    });

    const [incident] = engine.incidentList();
    const snap = await applyCommand(engine, { type: 'retryTask', tokenId: incident!.tokenId });

    expect(snap.status).toBe('waiting');
    expect(engine.tasks({ reason: 'job' })).toHaveLength(1);
  });

  it('resolveIncident conclui a atividade sem passar pelo worker de novo', async () => {
    const engine = await startedOnJob({ onHandlerError: 'incident' });
    const [task] = engine.tasks({ reason: 'job' });
    await applyCommand(engine, {
      type: 'failJob',
      tokenId: task!.tokenId,
      error: { message: 'gateway timeout' },
    });

    const [incident] = engine.incidentList();
    const snap = await applyCommand(engine, {
      type: 'resolveIncident',
      tokenId: incident!.tokenId,
      output: { authorized: true },
    });

    expect(snap.status).toBe('completed');
    expect(snap.variables).toMatchObject({ authorized: true });
  });
});

describe('payloadOf', () => {
  it('tira o tipo, que o journal guarda na coluna própria', () => {
    expect(payloadOf({ type: 'completeTask', tokenId: 't1', output: { a: 1 } })).toEqual({
      tokenId: 't1',
      output: { a: 1 },
    });
    expect(payloadOf({ type: 'tick' })).toEqual({});
  });

  it('payloadOf não leva o tipo junto', () => {
    expect(payloadOf({ type: 'retryTask', tokenId: 't1' })).toEqual({ tokenId: 't1' });
  });
});
