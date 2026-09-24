import { EbbRuntime } from '@ebb/runtime';
import type { ReplayView } from '@ebb/runtime';
import { checksumOf, SqliteStore } from '@ebb/store';
import type { InstanceRecord } from '@ebb/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { clampStep, frameAt, listRows, parseRoute, routeTo, type Route } from '../src/timeline.js';

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

let view: ReplayView;
let single: ReplayView;

beforeAll(async () => {
  const store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'Aprovacao', xml: GATEWAY, checksum: checksumOf(GATEWAY) });
  let ids = 0;
  const runtime = new EbbRuntime({
    store,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    newId: () => `inst-${++ids}`,
  });
  const started = await runtime.start('Aprovacao', { variables: { nota: '<b>x</b>' } });
  const high = await runtime.apply('inst-1', {
    type: 'completeTask',
    tokenId: started.tasks[0]?.tokenId ?? '',
    output: { valor: 150 },
  });
  await runtime.apply('inst-1', { type: 'completeTask', tokenId: high.tasks[0]?.tokenId ?? '' });
  view = await runtime.replay('inst-1');
  await runtime.start('Aprovacao');
  single = await runtime.replay('inst-2');
  store.close();
});

describe('rotas', () => {
  it.each<[string, Route]>([
    ['', { view: 'list' }],
    ['#/', { view: 'list' }],
    ['#/qualquer', { view: 'list' }],
    ['#/i/inst-1', { view: 'instance', id: 'inst-1' }],
    ['#/i/inst-1?step=2', { view: 'instance', id: 'inst-1', step: 2 }],
    ['#/i/inst-1?step=abc', { view: 'instance', id: 'inst-1' }],
    ['#/i/a%20b', { view: 'instance', id: 'a b' }],
    ['#/i/%E0%A4%A', { view: 'list' }],
  ])('%s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it('ida e volta', () => {
    expect(routeTo({ view: 'list' })).toBe('#/');
    expect(routeTo({ view: 'instance', id: 'a b', step: 3 })).toBe('#/i/a%20b?step=3');
    expect(parseRoute(routeTo({ view: 'instance', id: 'x/y', step: 1 }))).toEqual({
      view: 'instance',
      id: 'x/y',
      step: 1,
    });
  });
});

describe('passo válido', () => {
  it.each<[number | undefined, number, number]>([
    [undefined, 3, 3],
    [2, 3, 2],
    [0, 3, 3],
    [4, 3, 3],
    [1.5, 3, 3],
    [-1, 3, 3],
    [1, 1, 1],
  ])('clampStep(%s, %s) = %s', (step, total, expected) => {
    expect(clampStep(step, total)).toBe(expected);
  });
});

describe('frameAt', () => {
  it('passo do gateway: título, opções com a tomada marcada e as variáveis do instante', () => {
    const frame = frameAt(view, 2);

    expect(frame.title).toBe('passo 2 de 3 — completeTask em 2026-09-24T12:00:00.000Z');
    expect(frame.total).toBe(3);
    expect(frame.entered).toContain('Diretoria');
    expect(frame.gateways).toHaveLength(1);
    const [gateway] = frame.gateways;
    expect(gateway?.nodeId).toBe('Gateway_Valor');
    expect(gateway?.name).toBe('Valor alto?');
    expect(gateway?.options).toContainEqual({
      flowId: 'Flow_Alto',
      targetId: 'Diretoria',
      label: 'valor > 100',
      taken: true,
    });
    expect(gateway?.options).toContainEqual({
      flowId: 'Flow_Baixo',
      targetId: 'EndBaixo',
      label: 'default',
      taken: false,
    });
    expect(gateway?.variables).toContainEqual(['valor', '150']);
    expect(frame.tasks.map((task) => task.nodeId)).toEqual(['Diretoria']);
  });

  it('acumula os fluxos até o passo, e voltar tira os do passo desfeito', () => {
    const at2 = frameAt(view, 2).flows;
    const at1 = frameAt(view, 1).flows;
    const at3 = frameAt(view, 3).flows;

    expect(at2).toContain('Flow_Alto');
    expect(at1).not.toContain('Flow_Alto');
    for (const flow of at1) expect(at2).toContain(flow);
    expect(new Set(at3).size).toBe(at3.length);
  });

  it('variável com HTML chega como texto, sem ser tocada', () => {
    expect(frameAt(view, 1).variables).toContainEqual(['nota', '"<b>x</b>"']);
  });

  it('instância de um passo só', () => {
    const frame = frameAt(single, 1);
    expect(frame.total).toBe(1);
    expect(frame.gateways).toEqual([]);
  });

  it('recusa passo fora do replay', () => {
    expect(() => frameAt(view, 4)).toThrow(RangeError);
  });
});

describe('listRows', () => {
  it('id curto e origem da bifurcação', () => {
    const base: InstanceRecord = {
      id: '64135c65-5b53-4531-9e8c-e97ce0600c3e',
      processKey: 'Aprovacao',
      version: 1,
      status: 'completed',
      seq: 2,
      createdAt: 'x',
      updatedAt: 'x',
    };
    const row = {
      id: base.id,
      short: '64135c65',
      process: 'Aprovacao',
      version: 'v1',
      status: 'completed',
      commands: '2',
    };
    expect(
      listRows([
        { ...base, forkedFrom: '10dbdecb-430a-4fcb-a0a4-e5a63cf81e0a', forkedAt: 1 },
        base,
      ]),
    ).toEqual([
      { ...row, origin: '10dbdecb@1' },
      { ...row, origin: '' },
    ]);
  });
});
