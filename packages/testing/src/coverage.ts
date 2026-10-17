import type { BpmnModel, ProcessModel } from '@bpmn-flow/core';

export interface FlowCoverageEntry {
  id: string;
  sourceRef: string;
  targetRef: string;
  /** Processo ou subprocesso que declara o fluxo. */
  scopeId: string;
  covered: boolean;
}

export interface ProcessCoverage {
  total: number;
  covered: number;
  percentage: number;
  flows: FlowCoverageEntry[];
  missing: FlowCoverageEntry[];
}

type FlowDefinition = Omit<FlowCoverageEntry, 'covered'>;

/**
 * Fluxos alcançáveis pelo processo principal, incluindo subprocessos e
 * processos chamados. Processos globais sem referência não entram na conta.
 */
export function flowDefinitions(model: BpmnModel, root: ProcessModel): FlowDefinition[] {
  const processes = new Map(model.processes.map((process) => [process.id, process]));
  const visitedScopes = new Set<string>();
  const flows = new Map<string, FlowDefinition>();

  const visit = (process: ProcessModel): void => {
    if (visitedScopes.has(process.id)) return;
    visitedScopes.add(process.id);
    for (const flow of process.sequenceFlows) {
      flows.set(flow.id, {
        id: flow.id,
        sourceRef: flow.sourceRef,
        targetRef: flow.targetRef,
        scopeId: process.id,
      });
    }
    for (const node of process.flowNodes) {
      if (node.process) visit(node.process);
      if (node.calledElement) {
        const called = processes.get(node.calledElement);
        if (called) visit(called);
      }
    }
  };

  visit(root);
  return [...flows.values()];
}

export function processCoverage(
  definitions: readonly FlowDefinition[],
  observed: ReadonlySet<string>,
): ProcessCoverage {
  const flows = definitions.map((flow) => ({ ...flow, covered: observed.has(flow.id) }));
  const covered = flows.filter((flow) => flow.covered).length;
  const total = flows.length;
  return {
    total,
    covered,
    percentage: total === 0 ? 100 : (covered / total) * 100,
    flows,
    missing: flows.filter((flow) => !flow.covered),
  };
}

export function formatCoverage(coverage: ProcessCoverage): string {
  const percentage = Number.isInteger(coverage.percentage)
    ? String(coverage.percentage)
    : coverage.percentage.toFixed(1);
  const headline = `${coverage.covered}/${coverage.total} fluxos (${percentage}%)`;
  if (coverage.missing.length === 0) return headline;
  return [
    headline,
    'Não exercitados:',
    ...coverage.missing.map(
      (flow) => `  ${flow.id}: ${flow.sourceRef} → ${flow.targetRef} (${flow.scopeId})`,
    ),
  ].join('\n');
}
