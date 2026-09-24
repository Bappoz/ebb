import { BpmnError } from '@bpmn-flow/core';
import type { JournalEntry } from '@ebb/store';
import type {
  EngineMode,
  ExecutionSnapshot,
  ExpressionMode,
  WorkflowEngine,
} from '@bpmn-flow/core';

/**
 * Os campos de `EngineOptions` que mudam a execução — `expressions` decide,
 * por exemplo, qual ramo um gateway toma. Vivem no comando `start` para que um
 * replay do zero saiba com que motor a instância nasceu, em vez de herdar o
 * padrão de `@bpmn-flow/core` do momento em que roda o replay.
 */
export interface StartEngineOptions {
  mode: EngineMode;
  maxSteps: number;
  expressions: ExpressionMode;
  /**
   * As duas opções que o motor não guarda no estado nem devolve em
   * `getState()`. Sem elas no journal, uma instância re-hidratada volta com o
   * padrão `'fail'` e perde o incidente — e um replay reconstruiria uma
   * execução diferente da que aconteceu.
   */
  onHandlerError: 'fail' | 'incident';
  retry: { attempts: number };
}

/**
 * Tudo que muda uma instância, como dado.
 *
 * É o que faz o time-travel possível: a execução ao vivo e o replay do journal
 * passam os dois por {@link applyCommand}, então um comando gravado significa
 * exatamente o que significou quando foi aplicado.
 */
export type InstanceCommand =
  | { type: 'start'; variables?: Record<string, unknown>; engine: StartEngineOptions }
  | { type: 'completeTask'; tokenId: string; output?: Record<string, unknown> }
  | { type: 'signal'; name: string; output?: Record<string, unknown> }
  | { type: 'tick' }
  | { type: 'completeJob'; tokenId: string; output?: Record<string, unknown> }
  | { type: 'failJob'; tokenId: string; error: { message: string; code?: string } }
  | { type: 'retryTask'; tokenId: string }
  | { type: 'resolveIncident'; tokenId: string; output?: Record<string, unknown> };

/** Aplica um comando ao motor. O único caminho — ao vivo e no replay. */
export function applyCommand(
  engine: WorkflowEngine,
  command: InstanceCommand,
): Promise<ExecutionSnapshot> {
  switch (command.type) {
    case 'start':
      // As variáveis iniciais entram na construção do motor, não aqui. Elas
      // ficam no payload porque o replay precisa construir o mesmo motor.
      return engine.start();
    case 'completeTask':
      return engine.completeTask(command.tokenId, command.output);
    case 'signal':
      return engine.signal(command.name, command.output);
    case 'tick':
      // Sem argumento de propósito: o relógio do motor já está congelado no
      // instante que o journal gravou.
      return engine.tick();
    case 'completeJob':
      return engine.completeTask(command.tokenId, command.output);
    case 'failJob':
      // O erro é gravado como dado porque um Error não sobrevive a
      // JSON.stringify, e o replay tem de reproduzir a mesma falha: com código
      // é erro de negócio (boundary de erro), sem código é falha técnica
      // (retry e incidente).
      return engine.failJob(
        command.tokenId,
        command.error.code
          ? new BpmnError(command.error.code, command.error.message)
          : new Error(command.error.message),
      );
    case 'retryTask':
      return engine.retryTask(command.tokenId);
    case 'resolveIncident':
      return engine.resolveIncident(command.tokenId, command.output);
  }
}

/** O comando sem o tipo, que o journal guarda numa coluna própria. */
export function payloadOf(command: InstanceCommand): Record<string, unknown> {
  const { type: _type, ...payload } = command;
  return payload;
}

/** Uma entrada do journal que não tem a forma de nenhum comando conhecido. */
export class JournalShapeError extends Error {
  constructor(
    readonly seq: number,
    readonly field: string,
    detail: string,
  ) {
    super(`Entrada ${seq} do journal: "${field}" ${detail}.`);
    this.name = 'JournalShapeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * As políticas de falha do payload do `start`, lidas de volta via
 * `JSON.parse`. `undefined` quando não casam, para o chamador decidir se isso
 * é padrão (retomada pelo snapshot) ou erro (replay).
 */
export function parseStartEngineOptions(
  value: unknown,
): Pick<StartEngineOptions, 'onHandlerError' | 'retry'> | undefined {
  if (!isRecord(value)) return undefined;
  const { onHandlerError, retry } = value;
  if (onHandlerError !== 'fail' && onHandlerError !== 'incident') return undefined;
  if (!isRecord(retry) || typeof retry.attempts !== 'number') return undefined;
  return { onHandlerError, retry: { attempts: retry.attempts } };
}

function parseEngine(value: unknown): StartEngineOptions | undefined {
  const policies = parseStartEngineOptions(value);
  if (!policies || !isRecord(value)) return undefined;
  const { mode, maxSteps, expressions } = value;
  if (mode !== 'automation' && mode !== 'auto') return undefined;
  if (typeof maxSteps !== 'number') return undefined;
  if (expressions !== 'safe' && expressions !== 'javascript') return undefined;
  return { mode, maxSteps, expressions, ...policies };
}

/**
 * A entrada gravada de volta como comando, sem `as`: o payload veio de
 * `JSON.parse` e o replay não pode reexecutar um comando com forma errada
 * como se fosse o que aconteceu.
 */
export function commandFromEntry(
  entry: Pick<JournalEntry, 'seq' | 'type' | 'payload'>,
): InstanceCommand {
  const { seq, type, payload } = entry;
  const text = (field: string): string => {
    const value = payload[field];
    if (typeof value !== 'string') throw new JournalShapeError(seq, field, 'deveria ser texto');
    return value;
  };
  const object = (field: string): Record<string, unknown> | undefined => {
    const value = payload[field];
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new JournalShapeError(seq, field, 'deveria ser um objeto');
    return value;
  };
  const withOutput = () => {
    const output = object('output');
    return output ? { output } : {};
  };

  switch (type) {
    case 'start': {
      const engine = parseEngine(payload.engine);
      // Sem as opções completas, o replay não sabe com que motor a instância
      // nasceu — adivinhar o padrão de hoje reconstruiria outra execução.
      if (!engine) {
        throw new JournalShapeError(
          seq,
          'engine',
          'deveria trazer as opções com que o motor nasceu',
        );
      }
      const variables = object('variables');
      return { type, engine, ...(variables ? { variables } : {}) };
    }
    case 'completeTask':
      return { type, tokenId: text('tokenId'), ...withOutput() };
    case 'completeJob':
      return { type, tokenId: text('tokenId'), ...withOutput() };
    case 'resolveIncident':
      return { type, tokenId: text('tokenId'), ...withOutput() };
    case 'signal':
      return { type, name: text('name'), ...withOutput() };
    case 'tick':
      return { type };
    case 'retryTask':
      return { type, tokenId: text('tokenId') };
    case 'failJob': {
      const error = object('error');
      if (!error || typeof error.message !== 'string') {
        throw new JournalShapeError(seq, 'error.message', 'deveria ser texto');
      }
      const { code } = error;
      if (code !== undefined && typeof code !== 'string') {
        throw new JournalShapeError(seq, 'error.code', 'deveria ser texto');
      }
      return {
        type,
        tokenId: text('tokenId'),
        error: { message: error.message, ...(code ? { code } : {}) },
      };
    }
    default:
      throw new JournalShapeError(seq, 'type', `desconhecido: "${type}"`);
  }
}
