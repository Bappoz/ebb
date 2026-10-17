import type { HumanTaskRecord, IncidentRecord, MutationResponse } from '@ebb/api';
import type { ReplayView } from '@ebb/runtime';
import type { InstanceRecord, ProcessSummary } from '@ebb/store';
import {
  errorMessage,
  isForkResponse,
  isHumanTaskList,
  isIncidentList,
  isInstanceList,
  isMutationResponse,
  isProcessList,
  isReplayView,
} from './wire.js';

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

export async function fetchProcesses(): Promise<ProcessSummary[]> {
  const path = '/api/processes';
  const body = await request(path);
  if (!isProcessList(body)) throw unexpected(path);
  return body;
}

export async function fetchTasks(): Promise<HumanTaskRecord[]> {
  const path = '/api/tasks';
  const body = await request(path);
  if (!isHumanTaskList(body)) throw unexpected(path);
  return body;
}

export async function fetchIncidents(): Promise<IncidentRecord[]> {
  const path = '/api/incidents';
  const body = await request(path);
  if (!isIncidentList(body)) throw unexpected(path);
  return body;
}

async function postMutation(path: string, body: unknown): Promise<MutationResponse> {
  const response = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!isMutationResponse(response)) throw unexpected(path);
  return response;
}

export function startInstance(
  processKey: string,
  variables: Record<string, unknown>,
  retries = 0,
): Promise<MutationResponse> {
  return postMutation('/api/instances', { processKey, variables, retries });
}

export function completeHumanTask(
  instanceId: string,
  tokenId: string,
  output: Record<string, unknown>,
): Promise<MutationResponse> {
  return postMutation(
    `/api/tasks/${encodeURIComponent(instanceId)}/${encodeURIComponent(tokenId)}/complete`,
    { output },
  );
}

export function retryIncident(instanceId: string, tokenId: string): Promise<MutationResponse> {
  return postMutation(
    `/api/incidents/${encodeURIComponent(instanceId)}/${encodeURIComponent(tokenId)}/retry`,
    {},
  );
}

export function resolveIncident(
  instanceId: string,
  tokenId: string,
  output: Record<string, unknown>,
): Promise<MutationResponse> {
  return postMutation(
    `/api/incidents/${encodeURIComponent(instanceId)}/${encodeURIComponent(tokenId)}/resolve`,
    { output },
  );
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
