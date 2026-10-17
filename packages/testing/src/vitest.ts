import type { ExecutionSnapshot } from '@bpmn-flow/core';
import type {} from 'vitest';
import type { ProcessCoverage } from './coverage.js';
import { ebbMatchers, installEbbMatchers } from './matchers.js';
import type { ProcessRun } from './process.js';

export { ebbMatchers, installEbbMatchers };

interface EbbMatchers<R = unknown> {
  toHaveVisited(nodeId: string): R;
  toHaveTaken(flowId: string): R;
  toHaveFullFlowCoverage(): R;
}

declare module 'vitest' {
  // O parâmetro precisa repetir exatamente a declaração pública do Vitest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type
  interface Matchers<T = any> extends EbbMatchers<T> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends EbbMatchers {}
}

/** Compile-time checks documenting the supported matcher receivers. */
export type Visitable = ProcessRun | ExecutionSnapshot;
export type FlowCoverageTarget = ProcessCoverage;
