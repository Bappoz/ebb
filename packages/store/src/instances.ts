import { integer, jsonObject, text, type Row } from './rows.js';
import type { InstanceRecord, InstanceStatus, JournalEntry, StoredEngineState } from './types.js';

const STATUSES: readonly InstanceStatus[] = [
  'idle',
  'running',
  'waiting',
  'completed',
  'terminated',
  'failed',
];

/** Estado vindo do banco, conferido contra o conjunto que este código conhece. */
function status(row: Row): InstanceStatus {
  const value = text(row, 'status');
  const known = STATUSES.find((candidate) => candidate === value);
  if (!known) throw new TypeError(`Coluna "status" trouxe um estado desconhecido: "${value}".`);
  return known;
}

export function toInstance(row: Row): InstanceRecord {
  return {
    id: text(row, 'id'),
    processKey: text(row, 'process_key'),
    version: integer(row, 'version'),
    status: status(row),
    seq: integer(row, 'seq'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function toJournalEntry(row: Row): JournalEntry {
  return {
    seq: integer(row, 'seq'),
    type: text(row, 'type'),
    payload: jsonObject(row, 'payload'),
    at: integer(row, 'at'),
    recordedAt: text(row, 'recorded_at'),
  };
}

export function toStoredState(row: Row): StoredEngineState {
  return {
    seq: integer(row, 'seq'),
    engineVersion: integer(row, 'engine_version'),
    json: text(row, 'state'),
  };
}
