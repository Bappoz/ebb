import type { ReplayView } from '@ebb/runtime';
import type { InstanceRecord } from '@ebb/store';
import { errorMessage, isForkResponse, isInstanceList, isReplayView } from './wire.js';

/** Corpo JSON da resposta, ou erro com a mensagem que a api mandou. */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(errorMessage(body) ?? `HTTP ${response.status}`);
  return body;
}

function unexpected(path: string): Error {
  return new Error(`Resposta inesperada de ${path}.`);
}

export async function fetchInstances(): Promise<InstanceRecord[]> {
  const path = '/api/instances';
  const body = await request(path);
  if (!isInstanceList(body)) throw unexpected(path);
  return body;
}

export async function fetchReplay(id: string): Promise<ReplayView> {
  const path = `/api/instances/${encodeURIComponent(id)}/replay`;
  const body = await request(path);
  if (!isReplayView(body)) throw unexpected(path);
  return body;
}

export async function forkAt(id: string, seq: number): Promise<InstanceRecord> {
  const path = `/api/instances/${encodeURIComponent(id)}/fork`;
  const body = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq }),
  });
  if (!isForkResponse(body)) throw unexpected(path);
  return body.instance;
}
