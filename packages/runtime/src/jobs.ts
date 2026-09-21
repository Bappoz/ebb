import type { WorkflowEngine } from '@bpmn-flow/core';
import type { JobProjection } from '@ebb/store';

/**
 * Os jobs que o motor tem parados, como linhas.
 *
 * `attempts` vem de `getState().incidents`, não de `incidentList()`: a lista
 * pública só devolve o token cujo motivo de espera é `'incident'`, e um job
 * que ainda tem orçamento de retry volta a esperar como `'job'` — mesmo
 * assim carrega a contagem de tentativas na contabilidade interna do motor.
 * Sem isto, um job retentado em linha (sem esperar tick nenhum) apareceria
 * sempre com `attempts: 0`, escondendo do worker que já houve uma falha.
 */
export function projectJobs(engine: WorkflowEngine): JobProjection[] {
  const attempts = new Map(
    engine.getState().incidents.map((incident) => [incident.tokenId, incident.attempts]),
  );
  return engine.tasks({ reason: 'job' }).map((task) => ({
    tokenId: task.tokenId,
    nodeId: task.nodeId,
    // task.job é opcional no tipo do core, mas um token parado por 'job'
    // sempre o tem. O `?? ''` existe só para o tsc; linha com tipo vazio em
    // teste é bug de projeção, não dado válido.
    type: task.job?.type ?? '',
    variables: task.variables,
    attempts: attempts.get(task.tokenId) ?? 0,
  }));
}
