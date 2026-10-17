import type { CommandResult, InstanceView } from '@ebb/runtime';
import type { InstanceRecord } from '@ebb/store';

type Task = InstanceView['tasks'][number];
type Incident = InstanceView['incidents'][number];

/** Tarefa humana pronta para uma inbox, sem exigir outra consulta à instância. */
export interface HumanTaskRecord {
  instanceId: string;
  processKey: string;
  version: number;
  instanceUpdatedAt: string;
  tokenId: string;
  nodeId: string;
  name?: string;
  lane?: string;
  candidates: string[];
  variables: Record<string, unknown>;
}

/** Incidente operacional com o contexto necessário para retry ou resolução. */
export interface IncidentRecord {
  instanceId: string;
  processKey: string;
  version: number;
  instanceUpdatedAt: string;
  tokenId: string;
  nodeId: string;
  message: string;
  attempts: number;
  retryAt?: number;
  variables: Record<string, unknown>;
}

export type InstanceDetail = InstanceView;
export type MutationResponse = CommandResult;

export function humanTask(instance: InstanceRecord, task: Task): HumanTaskRecord {
  return {
    instanceId: instance.id,
    processKey: instance.processKey,
    version: instance.version,
    instanceUpdatedAt: instance.updatedAt,
    tokenId: task.tokenId,
    nodeId: task.nodeId,
    candidates: task.candidates,
    variables: task.variables,
    ...(task.name ? { name: task.name } : {}),
    ...(task.lane ? { lane: task.lane } : {}),
  };
}

export function incidentRecord(
  instance: InstanceRecord,
  incident: Incident,
  variables: Record<string, unknown>,
): IncidentRecord {
  return {
    instanceId: instance.id,
    processKey: instance.processKey,
    version: instance.version,
    instanceUpdatedAt: instance.updatedAt,
    tokenId: incident.tokenId,
    nodeId: incident.nodeId,
    message: incident.message,
    attempts: incident.attempts,
    variables,
    ...(incident.retryAt === undefined ? {} : { retryAt: incident.retryAt }),
  };
}
