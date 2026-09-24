import type { EbbRuntime } from '@ebb/runtime';
import type { Store } from '@ebb/store';
import type { CommandResult } from './commands.js';
import { SHORT, withInstance } from './instances.js';
import { CHECK, table } from './output.js';

/** `ebb jobs` — o trabalho esperando worker. */
export async function listJobs(
  store: Store,
  filter: { type?: string; instanceId?: string },
): Promise<CommandResult> {
  const jobs = await store.listJobs(filter);
  if (jobs.length === 0) {
    return { output: 'Nenhum job pendente.', exitCode: 0 };
  }
  const rows = jobs.map((job) => [
    job.instanceId.slice(0, SHORT),
    job.tokenId,
    job.nodeId,
    job.type,
    job.state,
    `${job.attempts}`,
    job.worker ?? '',
  ]);
  return {
    output: table(
      ['INSTÂNCIA', 'TOKEN', 'ATIVIDADE', 'TIPO', 'ESTADO', 'TENTATIVAS', 'WORKER'],
      rows,
    ),
    exitCode: 0,
  };
}

/**
 * `ebb incidents` — o que parou por falha.
 *
 * Varre instância por instância porque o incidente vive no motor, não no
 * store: ele é reconstruído ao re-hidratar. Quando isso doer (é O(n) em
 * instâncias), a resposta é projetar incidente como se projeta job — não
 * cachear aqui.
 */
export async function listIncidents(store: Store, runtime: EbbRuntime): Promise<CommandResult> {
  const rows: string[][] = [];
  for (const instance of await store.listInstances()) {
    const view = await runtime.inspect(instance.id);
    for (const incident of view.incidents) {
      rows.push([
        instance.id.slice(0, SHORT),
        incident.tokenId,
        incident.nodeId,
        `${incident.attempts}`,
        incident.message,
      ]);
    }
  }
  if (rows.length === 0) return { output: 'Nenhum incidente.', exitCode: 0 };
  return {
    output: table(['INSTÂNCIA', 'TOKEN', 'ATIVIDADE', 'TENTATIVAS', 'MENSAGEM'], rows),
    exitCode: 0,
  };
}

/** `ebb retry <id> <token>` — roda a atividade de novo a partir do incidente. */
export async function retryTask(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  tokenId: string,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, { type: 'retryTask', tokenId });
    return { output: `${CHECK} ${instance.id} — ${result.snapshot.status}`, exitCode: 0 };
  });
}

/** `ebb resolve <id> <token> [--var k=v]` — desiste e segue como se tivesse dado certo. */
export async function resolveIncident(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  tokenId: string,
  output: Record<string, unknown>,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, {
      type: 'resolveIncident',
      tokenId,
      ...(Object.keys(output).length > 0 ? { output } : {}),
    });
    return { output: `${CHECK} ${instance.id} — ${result.snapshot.status}`, exitCode: 0 };
  });
}
