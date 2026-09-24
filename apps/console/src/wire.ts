import type { ReplayView } from '@ebb/runtime';
import type { InstanceRecord } from '@ebb/store';

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
