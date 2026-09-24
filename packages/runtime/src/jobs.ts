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
 *
 * As duas fontes existem por motivos diferentes, não por acaso:
 * `incidentList()` é a API de *relato* ("o que está parado agora, para eu
 * mostrar num `ebb incidents`"), enquanto `getState().incidents` é a
 * contabilidade completa, serializada de propósito para o orçamento de
 * retry sobreviver a um rehydrate. Um job retentado em linha é exatamente o
 * caso em que os dois conjuntos divergem — não "simplificar" de volta para
 * `incidentList()`.
 */
export function projectJobs(engine: WorkflowEngine): JobProjection[] {
  const attempts = new Map(
    engine.getState().incidents.map((incident) => [incident.tokenId, incident.attempts]),
  );
  return engine.tasks({ reason: 'job' }).map((task) => {
    // task.job é opcional no tipo do core, mas um token parado por 'job'
    // sempre o tem. Um `?? ''` aqui gravaria `type: ''` — trabalho que
    // nenhum `lockJobs({ type })` jamais casa, perdido em silêncio. Se isto
    // disparar, é bug de projeção do core ou daqui, e deve estourar, não
    // virar uma linha invisível.
    if (!task.job) {
      throw new Error(
        `Token ${task.tokenId} no nó ${task.nodeId} espera como 'job' mas não tem job.type.`,
      );
    }
    return {
      tokenId: task.tokenId,
      nodeId: task.nodeId,
      type: task.job.type,
      variables: task.variables,
      attempts: attempts.get(task.tokenId) ?? 0,
    };
  });
}
