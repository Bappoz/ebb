import { describe, expect, it } from 'vitest';
import { errorMessage, isForkResponse, isInstanceList, isReplayView } from '../src/wire.js';

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
});
