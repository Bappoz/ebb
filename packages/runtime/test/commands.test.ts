import { parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type { ProcessModel } from '@bpmn-flow/core';
import { describe, expect, it } from 'vitest';
import { applyCommand, payloadOf } from '../src/commands.js';

const PEDIDO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" name="Processo de Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

async function pedido(): Promise<ProcessModel> {
  const [first] = (await parseBpmn(PEDIDO)).processes;
  if (!first) throw new Error('fixture sem processo');
  return first;
}

describe('applyCommand', () => {
  it('start leva a execução até o primeiro ponto de espera', async () => {
    const engine = new WorkflowEngine(await pedido(), { variables: { total: 42 } });
    const snapshot = await applyCommand(engine, { type: 'start', variables: { total: 42 } });

    expect(snapshot.status).toBe('waiting');
    expect(snapshot.variables).toMatchObject({ total: 42 });
  });

  it('completeTask conclui a tarefa parada e segue', async () => {
    const engine = new WorkflowEngine(await pedido());
    await applyCommand(engine, { type: 'start' });
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
    await applyCommand(engine, { type: 'start' });

    // Nada vencido: tick é uma não-operação, e não pode explodir por isso.
    const snapshot = await applyCommand(engine, { type: 'tick' });
    expect(snapshot.status).toBe('waiting');
  });

  it('signal recusa um evento que o diagrama não tem', async () => {
    const engine = new WorkflowEngine(await pedido());
    await applyCommand(engine, { type: 'start' });

    await expect(applyCommand(engine, { type: 'signal', name: 'Inexistente' })).rejects.toThrow();
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
});
