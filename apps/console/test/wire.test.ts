import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  isForkResponse,
  isHumanTaskList,
  isIncidentList,
  isInstanceList,
  isMutationResponse,
  isProcessList,
  isReplayView,
} from '../src/wire.js';

const INSTANCE = {
  id: 'inst-1',
  processKey: 'P',
  version: 1,
  status: 'waiting',
  seq: 2,
  createdAt: 'x',
  updatedAt: 'x',
};

const STEP = {
  seq: 1,
  at: 1,
  command: { type: 'start' },
  snapshot: {},
  flows: [],
  decisions: [],
  entered: [],
  tasks: [],
  incidents: [],
};

describe('guardas das respostas', () => {
  it('lista de instâncias', () => {
    expect(isInstanceList([INSTANCE])).toBe(true);
    expect(isInstanceList([])).toBe(true);
    expect(isInstanceList([{ ...INSTANCE, seq: '2' }])).toBe(false);
    expect(isInstanceList({ instances: [] })).toBe(false);
  });

  it('replay', () => {
    expect(isReplayView({ instance: INSTANCE, xml: '<x/>', steps: [STEP] })).toBe(true);
    expect(
      isReplayView({ instance: INSTANCE, xml: '<x/>', steps: [{ ...STEP, flows: 'f1' }] }),
    ).toBe(false);
    expect(
      isReplayView({ instance: INSTANCE, xml: '<x/>', steps: [{ ...STEP, command: {} }] }),
    ).toBe(false);
    expect(isReplayView({ instance: INSTANCE, steps: [] })).toBe(false);
    expect(isReplayView(null)).toBe(false);
  });

  it('bifurcação', () => {
    expect(isForkResponse({ instance: INSTANCE })).toBe(true);
    expect(isForkResponse(INSTANCE)).toBe(false);
  });

  it('mensagem de erro', () => {
    expect(errorMessage({ error: 'nope' })).toBe('nope');
    expect(errorMessage({ error: 1 })).toBeUndefined();
    expect(errorMessage(undefined)).toBeUndefined();
  });

  it('processos, tarefas e incidentes', () => {
    expect(isProcessList([{ processKey: 'P', latestVersion: 1, versions: 1 }])).toBe(true);
    expect(isProcessList([{ processKey: 'P', latestVersion: '1', versions: 1 }])).toBe(false);

    expect(
      isHumanTaskList([
        {
          instanceId: 'i1',
          processKey: 'P',
          tokenId: 't1',
          nodeId: 'Review',
          candidates: [],
          variables: { total: 1 },
        },
      ]),
    ).toBe(true);
    expect(isHumanTaskList([{ instanceId: 'i1' }])).toBe(false);

    expect(
      isIncidentList([
        {
          instanceId: 'i1',
          processKey: 'P',
          tokenId: 't1',
          nodeId: 'Charge',
          message: 'offline',
          attempts: 1,
          variables: {},
        },
      ]),
    ).toBe(true);
    expect(isIncidentList([{ message: 'offline' }])).toBe(false);
  });

  it('resposta de mutação', () => {
    expect(isMutationResponse({ instance: INSTANCE, snapshot: {}, tasks: [], incidents: [] })).toBe(
      true,
    );
    expect(isMutationResponse({ instance: INSTANCE, snapshot: {}, tasks: {} })).toBe(false);
  });
});
