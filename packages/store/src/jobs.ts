import { integer, jsonObject, optionalInteger, optionalText, text, type Row } from './rows.js';
import type { JobRecord } from './types.js';

/** Linha da tabela `jobs` como objeto, sem `as` em cima do SQLite. */
export function toJob(row: Row): JobRecord {
  const state = text(row, 'state');
  if (state !== 'pending' && state !== 'locked') {
    throw new TypeError(`Coluna "state" deveria ser pending ou locked e veio "${state}".`);
  }
  const worker = optionalText(row, 'worker');
  const lockedUntil = optionalInteger(row, 'locked_until');
  return {
    instanceId: text(row, 'instance_id'),
    tokenId: text(row, 'token_id'),
    nodeId: text(row, 'node_id'),
    type: text(row, 'type'),
    variables: jsonObject(row, 'variables'),
    attempts: integer(row, 'attempts'),
    state,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    ...(worker === undefined ? {} : { worker }),
    ...(lockedUntil === undefined ? {} : { lockedUntil }),
  };
}
