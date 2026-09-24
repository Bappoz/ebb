import { checksumOf, SqliteStore } from '@ebb/store';
import { EbbRuntime } from '@ebb/runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { completeTask, listInstances, showInstance } from '../src/instances.js';
import { forkAt, gatewayLine, showStep } from '../src/timeline.js';

const GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Aprovacao" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Avaliar" name="Avaliar pedido" />
    <bpmn:exclusiveGateway id="Gateway_Valor" name="Valor alto?" default="Flow_Baixo" />
    <bpmn:userTask id="Diretoria" name="Aprovar na diretoria" />
    <bpmn:endEvent id="EndAlto" />
    <bpmn:endEvent id="EndBaixo" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Avaliar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Avaliar" targetRef="Gateway_Valor" />
    <bpmn:sequenceFlow id="Flow_Alto" sourceRef="Gateway_Valor" targetRef="Diretoria">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">valor &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Baixo" sourceRef="Gateway_Valor" targetRef="EndBaixo" />
    <bpmn:sequenceFlow id="f4" sourceRef="Diretoria" targetRef="EndAlto" />
  </bpmn:process>
</bpmn:definitions>`;

let store: SqliteStore;
let runtime: EbbRuntime;

beforeEach(async () => {
  store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'Aprovacao', xml: GATEWAY, checksum: checksumOf(GATEWAY) });
  let ids = 0;
  runtime = new EbbRuntime({ store, newId: () => `abc${++ids}def` });
});

async function highApproval(): Promise<void> {
  const started = await runtime.start('Aprovacao', { variables: { cliente: 'ACME' } });
  await runtime.apply('abc1def', {
    type: 'completeTask',
    tokenId: started.tasks[0]?.tokenId ?? '',
    output: { valor: 150 },
  });
}

describe('showStep', () => {
  it('mostra o comando, as variáveis, os nós entrados e o porquê do gateway', async () => {
    await highApproval();

    const result = await showStep(store, runtime, 'abc1', 2);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('passo 2 de 2');
    expect(result.output).toContain('completeTask');
    expect(result.output).toContain('"valor":150');
    expect(result.output).toContain('Gateway_Valor: "valor > 100" → Flow_Alto (valor=150)');
    expect(result.output).toContain('Diretoria');
  });

  it('no passo 1 não há gateway e a tarefa pendente é a primeira', async () => {
    await highApproval();

    const result = await showStep(store, runtime, 'abc1', 1);

    expect(result.output).toContain('passo 1 de 2');
    expect(result.output).not.toContain('Gateway_Valor:');
    expect(result.output).toContain('Avaliar pedido');
  });

  it('sai com 1 e diz o intervalo quando o passo não existe', async () => {
    await highApproval();

    const result = await showStep(store, runtime, 'abc1', 3);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('[1, 2]');
  });
});

describe('gatewayLine', () => {
  const base = { nodeId: 'G', variables: { valor: 50, cliente: 'ACME' } };

  it('mostra só as variáveis que as condições citam', () => {
    expect(
      gatewayLine({
        ...base,
        options: [
          { flowId: 'A', targetId: 'x', condition: 'valor > 100', isDefault: false },
          { flowId: 'B', targetId: 'y', isDefault: true },
        ],
        taken: ['B'],
      }),
    ).toBe('G: default → B (valor=50)');
  });

  it('mostra todas quando a condição não cita nenhuma variável conhecida', () => {
    expect(
      gatewayLine({
        ...base,
        options: [{ flowId: 'A', targetId: 'x', condition: 'true', isDefault: false }],
        taken: ['A'],
      }),
    ).toBe('G: "true" → A (valor=50, cliente="ACME")');
  });

  it('lista todos os fluxos tomados num gateway inclusivo', () => {
    expect(
      gatewayLine({
        ...base,
        options: [
          { flowId: 'A', targetId: 'x', condition: 'valor > 10', isDefault: false },
          { flowId: 'B', targetId: 'y', condition: 'valor < 100', isDefault: false },
        ],
        taken: ['A', 'B'],
      }),
    ).toBe('G: "valor > 10" → A, "valor < 100" → B (valor=50)');
  });
});

describe('forkAt', () => {
  it('bifurca, imprime o id novo e o que ficou pendente, e o valor novo leva a outro ramo', async () => {
    await highApproval();

    const result = await forkAt(store, runtime, 'abc1', 1);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('abc2def');
    expect(result.output).toContain('abc1def@1');
    expect(result.output).toContain('Avaliar pedido');

    const [task] = (await runtime.inspect('abc2def')).tasks;
    const low = await completeTask(store, runtime, 'abc2', task?.tokenId ?? '', { valor: 50 });
    expect(low.output).toContain('completed');
  });

  it('sai com 1 e diz o intervalo quando o passo não existe', async () => {
    await highApproval();
    const result = await forkAt(store, runtime, 'abc1', 7);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('[1, 2]');
  });
});

describe('proveniência', () => {
  it('ps e show dizem de onde a bifurcação saiu', async () => {
    await highApproval();
    await forkAt(store, runtime, 'abc1', 1);

    expect((await listInstances(store)).output).toContain('abc1def@1');
    expect((await showInstance(store, runtime, 'abc2')).output).toContain('bifurcada de abc1def@1');
    expect((await showInstance(store, runtime, 'abc1')).output).not.toContain('bifurcada');
  });
});
