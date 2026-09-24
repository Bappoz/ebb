import { EbbRuntime } from '@ebb/runtime';
import { checksumOf, SqliteStore } from '@ebb/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

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
  runtime = new EbbRuntime({ store, newId: () => `inst-${++ids}` });
});

afterEach(() => store.close());

/** O `{ error }` do corpo — e só ele, como a spec pede —, sem `any`. */
async function errorOf(res: Response): Promise<string> {
  const body: unknown = await res.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    Object.keys(body).join() !== 'error' ||
    !('error' in body) ||
    typeof body.error !== 'string'
  ) {
    throw new Error(`corpo sem { error: string }: ${JSON.stringify(body)}`);
  }
  return body.error;
}

/** inst-1 passou pelo gateway: dois comandos. */
async function throughGateway(): Promise<void> {
  const started = await runtime.start('Aprovacao');
  await runtime.apply('inst-1', {
    type: 'completeTask',
    tokenId: started.tasks[0]?.tokenId ?? '',
    output: { valor: 150 },
  });
}

describe('leitura', () => {
  it('lista as instâncias', async () => {
    await throughGateway();
    const res = await createApp({ store, runtime }).request('/api/instances');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ id: 'inst-1', processKey: 'Aprovacao', seq: 2 }]);
  });

  it('devolve o replay inteiro: instância, xml e passos com o porquê do gateway', async () => {
    await throughGateway();
    const res = await createApp({ store, runtime }).request('/api/instances/inst-1/replay');

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      instance: { id: 'inst-1' },
      xml: GATEWAY,
      steps: [
        { seq: 1, command: { type: 'start' } },
        { seq: 2, decisions: [{ nodeId: 'Gateway_Valor', taken: ['Flow_Alto'] }] },
      ],
    });
  });

  it('404 com { error } para instância que não existe', async () => {
    const res = await createApp({ store, runtime }).request('/api/instances/nada/replay');

    expect(res.status).toBe(404);
    expect(await errorOf(res)).toContain('nada');
  });

  it('500 com a mensagem quando o journal não replaya', async () => {
    await store.createInstance({
      id: 'quebrada',
      processKey: 'Aprovacao',
      version: 1,
      status: 'waiting',
      command: { type: 'start', payload: {}, at: 1 },
      state: { engineVersion: 0, json: '{}' },
      jobs: [],
    });
    const res = await createApp({ store, runtime }).request('/api/instances/quebrada/replay');

    expect(res.status).toBe(500);
    expect(await errorOf(res)).toContain('engine');
  });

  it('404 com { error } para rota de api desconhecida', async () => {
    const res = await createApp({ store, runtime }).request('/api/nada');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).not.toBe('');
  });
});

describe('Host', () => {
  it.each([
    'http://localhost/api/instances',
    'http://127.0.0.1:4321/api/instances',
    'http://[::1]:4321/api/instances',
  ])('aceita loopback (%s)', async (url) => {
    expect((await createApp({ store, runtime }).request(url)).status).toBe(200);
  });

  it.each(['http://evil.example/api/instances', 'http://127.0.0.1.evil.example/api/instances'])(
    'recusa com 403 o que não é loopback (%s)',
    async (url) => {
      const res = await createApp({ store, runtime }).request(url);
      expect(res.status).toBe(403);
      expect(await errorOf(res)).not.toBe('');
    },
  );
});
