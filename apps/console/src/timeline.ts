import type { ExecutionSnapshot } from '@bpmn-flow/core';
import type { ReplayView } from '@ebb/runtime';
import type { InstanceRecord } from '@ebb/store';

/** Quanto de um id aparece na lista — o mesmo corte do CLI. */
const SHORT = 8;

export type Route = { view: 'list' } | { view: 'instance'; id: string; step?: number };

/** A rota que o hash descreve. Qualquer coisa que não seja `#/i/<id>` é a lista. */
export function parseRoute(hash: string): Route {
  const match = /^#\/i\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (!match?.[1]) return { view: 'list' };
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    // Escape malformado colado na barra: melhor a lista que uma exceção.
    return { view: 'list' };
  }
  const raw = new URLSearchParams(match[2] ?? '').get('step');
  const step = raw === null ? Number.NaN : Number(raw);
  return Number.isNaN(step) ? { view: 'instance', id } : { view: 'instance', id, step };
}

export function routeTo(route: Route): string {
  if (route.view === 'list') return '#/';
  const step = route.step === undefined ? '' : `?step=${route.step}`;
  return `#/i/${encodeURIComponent(route.id)}${step}`;
}

/**
 * O passo a mostrar. Qualquer coisa fora de `[1, total]` vira o último: a URL
 * é do próprio console, e cair num estado válido serve mais que uma tela de erro.
 */
export function clampStep(step: number | undefined, total: number): number {
  return step !== undefined && Number.isInteger(step) && step >= 1 && step <= total ? step : total;
}

export interface ListRow {
  id: string;
  short: string;
  process: string;
  version: string;
  status: string;
  commands: string;
  origin: string;
}

export function listRows(instances: InstanceRecord[]): ListRow[] {
  return instances.map((instance) => ({
    id: instance.id,
    short: instance.id.slice(0, SHORT),
    process: instance.processKey,
    version: `v${instance.version}`,
    status: instance.status,
    commands: `${instance.seq}`,
    origin:
      instance.forkedFrom === undefined
        ? ''
        : `${instance.forkedFrom.slice(0, SHORT)}@${instance.forkedAt ?? '?'}`,
  }));
}

export interface GatewayView {
  nodeId: string;
  name: string;
  options: { flowId: string; targetId: string; label: string; taken: boolean }[];
  variables: [string, string][];
}

export interface TaskView {
  tokenId: string;
  nodeId: string;
  name: string;
  reason: string;
}

export interface Frame {
  step: number;
  total: number;
  title: string;
  /** O payload do comando, sem o tipo, indentado. */
  payload: string;
  status: string;
  snapshot: ExecutionSnapshot;
  /** Fluxos tomados do passo 1 até este, sem repetição, na ordem em que aconteceram. */
  flows: string[];
  variables: [string, string][];
  entered: string[];
  gateways: GatewayView[];
  tasks: TaskView[];
}

function rows(variables: Record<string, unknown>): [string, string][] {
  return Object.entries(variables).map(([key, value]) => [
    key,
    JSON.stringify(value) ?? 'undefined',
  ]);
}

/**
 * Tudo que a tela precisa para o passo `step`. Os fluxos são recalculados de
 * 1 até `step` a cada chamada, porque a pintura é sempre do zero — é o que
 * faz voltar um passo desfazer o que ele pintou.
 */
export function frameAt(view: ReplayView, step: number): Frame {
  const current = view.steps[step - 1];
  if (!current) throw new RangeError(`Passo ${step} fora do replay [1, ${view.steps.length}].`);
  const { type, ...payload } = current.command;
  return {
    step,
    total: view.steps.length,
    title: `passo ${step} de ${view.steps.length} — ${type} em ${new Date(current.at).toISOString()}`,
    payload: JSON.stringify(payload, null, 2),
    status: current.snapshot.status,
    snapshot: current.snapshot,
    flows: [...new Set(view.steps.slice(0, step).flatMap((each) => each.flows))],
    variables: rows(current.snapshot.variables),
    entered: current.entered
      .filter((entry) => entry.event === 'enter')
      .map((entry) => entry.nodeId),
    gateways: current.decisions.map((decision) => ({
      nodeId: decision.nodeId,
      name: decision.name ?? decision.nodeId,
      options: decision.options.map((option) => ({
        flowId: option.flowId,
        targetId: option.targetId,
        label: option.condition ?? (option.isDefault ? 'default' : '—'),
        taken: decision.taken.includes(option.flowId),
      })),
      variables: rows(decision.variables),
    })),
    tasks: current.tasks.map((task) => ({
      tokenId: task.tokenId,
      nodeId: task.nodeId,
      name: task.name ?? '',
      reason: task.reason,
    })),
  };
}
