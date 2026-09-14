import { checksumOf, SqliteStore } from '@ebb/store';
import { EbbRuntime } from '@ebb/runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  completeTask,
  listInstances,
  showInstance,
  showJournal,
  signalInstance,
  startInstance,
  tickInstance,
} from '../src/instances.js';

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

// Só para o teste de sinal com sucesso: PEDIDO não tem nenhum evento
// capturável, então um `signal` nele só pode falhar.
const APROVACAO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs2">
  <bpmn:signal id="Sig" name="Aprovado" />
  <bpmn:process id="Aprovacao" name="Processo de Aprovação" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Espera" name="Aguardando aprovação">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Espera" />
    <bpmn:sequenceFlow id="f1" sourceRef="Espera" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

let store: SqliteStore;
let runtime: EbbRuntime;

beforeEach(async () => {
  store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'Pedido', xml: PEDIDO, checksum: checksumOf(PEDIDO) });
  await store.deploy({ processKey: 'Aprovacao', xml: APROVACAO, checksum: checksumOf(APROVACAO) });
  let ids = 0;
  runtime = new EbbRuntime({ store, newId: () => `abc${++ids}def` });
});

describe('startInstance', () => {
  it('cria e mostra o id e o que ficou pendente', async () => {
    const result = await startInstance(runtime, 'Pedido', { variables: { total: 42 } });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('abc1def');
    expect(result.output).toContain('Separar itens');
  });

  it('sai com 1 quando a chave não existe', async () => {
    const result = await startInstance(runtime, 'Inexistente', {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Inexistente');
  });
});

describe('listInstances', () => {
  it('diz como começar quando não há nenhuma', async () => {
    const result = await listInstances(store);
    expect(result.output).toContain('ebb start');
  });

  it('lista uma linha por instância', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await listInstances(store);
    expect(result.output).toContain('abc1def');
    expect(result.output).toContain('waiting');
  });
});

describe('resolução por prefixo', () => {
  it('aceita um prefixo curto', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await showInstance(store, runtime, 'abc1');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Separar itens');
  });

  it('sai com 1 e lista as candidatas quando o prefixo é ambíguo', async () => {
    await startInstance(runtime, 'Pedido', {});
    await startInstance(runtime, 'Pedido', {});
    const result = await showInstance(store, runtime, 'abc');

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('2 instâncias');
    expect(result.output).toContain('abc1def');
    expect(result.output).toContain('abc2def');
  });

  it('sai com 1 quando nada casa', async () => {
    const result = await showInstance(store, runtime, 'zzz');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('zzz');
  });

  it('mostra as variáveis quando a instância tem alguma', async () => {
    await startInstance(runtime, 'Pedido', { variables: { total: 42 } });
    const result = await showInstance(store, runtime, 'abc1');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('total');
    expect(result.output).toContain('42');
  });

  it('não mostra a tabela de pendentes quando não há tarefa parada', async () => {
    await startInstance(runtime, 'Pedido', {});
    const view = await runtime.inspect('abc1def');
    const [task] = view.tasks;
    if (!task) throw new Error('nenhuma tarefa pendente');
    await completeTask(store, runtime, 'abc1', task.tokenId, {});

    const result = await showInstance(store, runtime, 'abc1');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('completed');
    expect(result.output).not.toContain('TOKEN');
  });
});

describe('completeTask', () => {
  it('conclui a tarefa pendente e leva a instância ao fim', async () => {
    await startInstance(runtime, 'Pedido', {});
    const view = await runtime.inspect('abc1def');
    const [task] = view.tasks;
    if (!task) throw new Error('nenhuma tarefa pendente');

    const result = await completeTask(store, runtime, 'abc1', task.tokenId, {
      separadoPor: 'ana',
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('completed');
  });
});

describe('showJournal', () => {
  it('mostra um comando por linha, em ordem', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await showJournal(store, 'abc1');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('start');
    expect(result.output).toContain('1');
  });
});

// Além do que o brief cobre: tickInstance e signalInstance ficavam sem
// nenhum teste. Cobrem comportamento real — não só "compila" — e o segundo
// também é o único teste que passa pelo catch do withInstance.
describe('tickInstance', () => {
  it('sem timer vencido é um no-op que ainda devolve 0 e o estado atual', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await tickInstance(store, runtime, 'abc1');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('waiting');
  });
});

describe('signalInstance', () => {
  it('sai com 1 quando o diagrama não tem esse evento', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await signalInstance(store, runtime, 'abc1', 'NãoExiste', {});

    expect(result.exitCode).toBe(1);
  });

  it('entrega o evento e avança a instância', async () => {
    await startInstance(runtime, 'Aprovacao', {});
    const result = await signalInstance(store, runtime, 'abc1', 'Aprovado', {});

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('completed');
  });
});
