import type { ExecutionSnapshot } from '@bpmn-flow/core';
import { formatCoverage, type ProcessCoverage } from './coverage.js';
import type { ProcessRun } from './process.js';

interface MatcherResult {
  pass: boolean;
  message: () => string;
}

type VisitTarget = ProcessRun | ExecutionSnapshot;

function snapshotOf(received: VisitTarget): ExecutionSnapshot {
  return 'snapshot' in received ? received.snapshot : received;
}

export const ebbMatchers = {
  toHaveVisited(received: VisitTarget, nodeId: string): MatcherResult {
    const visited = new Set(
      snapshotOf(received)
        .history.filter((entry) => entry.event === 'enter')
        .map((entry) => entry.nodeId),
    );
    const pass = visited.has(nodeId);
    return {
      pass,
      message: () =>
        pass
          ? `Esperava que a execução não tivesse visitado "${nodeId}".`
          : `Esperava que a execução tivesse visitado "${nodeId}". Visitados: ${[...visited].join(', ') || '(nenhum)'}.`,
    };
  },

  toHaveTaken(received: ProcessRun, flowId: string): MatcherResult {
    const taken = received.takenFlows;
    const pass = taken.has(flowId);
    return {
      pass,
      message: () =>
        pass
          ? `Esperava que a execução não tivesse tomado o fluxo "${flowId}".`
          : `Esperava que a execução tivesse tomado o fluxo "${flowId}". Tomados: ${[...taken].join(', ') || '(nenhum)'}.`,
    };
  },

  toHaveFullFlowCoverage(received: ProcessCoverage): MatcherResult {
    const pass = received.missing.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? 'Esperava que a cobertura de fluxos não estivesse completa.'
          : `Esperava cobertura completa de fluxos.\n${formatCoverage(received)}`,
    };
  },
};

export interface ExpectWithExtend {
  extend(matchers: typeof ebbMatchers): void;
}

/** Instala os matchers sem fazer import global ou efeito colateral escondido. */
export function installEbbMatchers(expect: ExpectWithExtend): void {
  expect.extend(ebbMatchers);
}
