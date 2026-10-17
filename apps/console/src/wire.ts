import type { HumanTaskRecord, IncidentRecord, MutationResponse } from '@ebb/api';
import type { ReplayView } from '@ebb/runtime';
import type { InstanceRecord, ProcessSummary } from '@ebb/store';

/*
 * Guardas estruturais das respostas da api. Mínimas de propósito — conferem o
 * que o console lê para decidir o que desenhar —, mas é por elas, e não por
 * `as`, que o JSON do `fetch` vira tipo.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstance(value: unknown): value is InstanceRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.processKey === 'string' &&
    typeof value.version === 'number' &&
    typeof value.status === 'string' &&
    typeof value.seq === 'number'
  );
}

export function isInstanceList(value: unknown): value is InstanceRecord[] {
  return Array.isArray(value) && value.every(isInstance);
}

export function isProcessList(value: unknown): value is ProcessSummary[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.processKey === 'string' &&
        typeof entry.latestVersion === 'number' &&
        typeof entry.versions === 'number',
    )
  );
}

function isVariables(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function isHumanTaskList(value: unknown): value is HumanTaskRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (task: unknown) =>
        isRecord(task) &&
        typeof task.instanceId === 'string' &&
        typeof task.processKey === 'string' &&
        typeof task.tokenId === 'string' &&
        typeof task.nodeId === 'string' &&
        Array.isArray(task.candidates) &&
        isVariables(task.variables),
    )
  );
}

export function isIncidentList(value: unknown): value is IncidentRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (incident: unknown) =>
        isRecord(incident) &&
        typeof incident.instanceId === 'string' &&
        typeof incident.processKey === 'string' &&
        typeof incident.tokenId === 'string' &&
        typeof incident.nodeId === 'string' &&
        typeof incident.message === 'string' &&
        typeof incident.attempts === 'number' &&
        isVariables(incident.variables),
    )
  );
}

export function isMutationResponse(value: unknown): value is MutationResponse {
  return (
    isRecord(value) &&
    isInstance(value.instance) &&
    isRecord(value.snapshot) &&
    Array.isArray(value.tasks) &&
    Array.isArray(value.incidents)
  );
}

function isStep(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.seq === 'number' &&
    typeof value.at === 'number' &&
    isRecord(value.command) &&
    typeof value.command.type === 'string' &&
    isRecord(value.snapshot) &&
    Array.isArray(value.flows) &&
    Array.isArray(value.decisions) &&
    Array.isArray(value.entered) &&
    Array.isArray(value.tasks)
  );
}

export function isReplayView(value: unknown): value is ReplayView {
  return (
    isRecord(value) &&
    isInstance(value.instance) &&
    typeof value.xml === 'string' &&
    Array.isArray(value.steps) &&
    value.steps.every(isStep)
  );
}

export function isForkResponse(value: unknown): value is { instance: InstanceRecord } {
  return isRecord(value) && isInstance(value.instance);
}

/** O `{ error }` que a api devolve em toda falha. */
export function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === 'string' ? value.error : undefined;
}
