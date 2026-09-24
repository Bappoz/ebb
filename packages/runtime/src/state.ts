import type { EngineState } from '@bpmn-flow/core';

/**
 * A guarda é estrutural e mínima de propósito — `restore()` confere o resto.
 * O que ela evita é o `as EngineState` cego em cima de `JSON.parse`.
 */
function isEngineState(value: unknown): value is EngineState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return (
    'version' in value &&
    typeof value.version === 'number' &&
    'tokens' in value &&
    Array.isArray(value.tokens) &&
    'history' in value &&
    Array.isArray(value.history)
  );
}

/**
 * O snapshot gravado, se tiver cara de estado do motor. `undefined` quando não
 * tem, e quem chamou reconstrói pelo journal: snapshot é cache, e cache ruim
 * se descarta.
 */
export function parseEngineState(json: string): EngineState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  return isEngineState(parsed) ? parsed : undefined;
}
