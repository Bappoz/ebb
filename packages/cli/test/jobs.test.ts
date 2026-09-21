import { checksumOf, SqliteStore } from '@ebb/store';
import { EbbRuntime } from '@ebb/runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { startInstance } from '../src/instances.js';
import { listIncidents, listJobs, resolveIncident, retryTask } from '../src/jobs.js';

/** Service task marcada como job externo, na convenção do Zeebe/Camunda 8. */
const EXTERNAL_JOB = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" name="Charge card">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="charge" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

// Id fixo: com `newId` travado, a instância nasce sempre com este id — é
// entrada nossa, controlada por injeção, não um detalhe interno de outro
// pacote. PREFIX é um prefixo verdadeiro dele, para exercitar a resolução de
// prefixo de `withInstance` em vez do id inteiro.
const INSTANCE_ID = 'abc12345';
const PREFIX = 'abc123';

async function deployed(): Promise<{ store: SqliteStore; runtime: EbbRuntime }> {
  const store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'P', xml: EXTERNAL_JOB, checksum: checksumOf(EXTERNAL_JOB) });
  const runtime = new EbbRuntime({ store, newId: () => INSTANCE_ID });
  return { store, runtime };
}

/** Uma instância já com incidente aberto no job `charge`, sem retry. */
async function incidented(): Promise<{ store: SqliteStore; runtime: EbbRuntime; token: string }> {
  const { store, runtime } = await deployed();
  await runtime.start('P');
  const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w' });
  await runtime.failJob(job!.instanceId, job!.tokenId, { message: 'gateway timeout' });
  return { store, runtime, token: job!.tokenId };
}

/** Extrai o id de instância do texto que `startInstance` devolve. */
function idFrom(output: string): string {
  const match = /instância (\S+)/.exec(output);
  if (!match) throw new Error(`sem instância em: ${output}`);
  return match[1]!;
}

describe('listJobs', () => {
  it('lista o trabalho pendente com estado e tipo', async () => {
    const { store, runtime } = await deployed();
    await runtime.start('P');

    const result = await listJobs(store, {});

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('charge');
    expect(result.output).toContain('pending');
  });

  it('diz o que fazer quando não há job', async () => {
    const { store } = await deployed();
    const result = await listJobs(store, {});
    expect(result.output).toContain('Nenhum job');
  });
});

describe('listIncidents', () => {
  it('lista incidente com tentativas e mensagem', async () => {
    const { store, runtime } = await deployed();
    const started = await runtime.start('P');
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w' });
    await runtime.failJob(job!.instanceId, job!.tokenId, { message: 'gateway timeout' });

    const result = await listIncidents(store, runtime);

    expect(result.output).toContain('gateway timeout');
    expect(result.output).toContain(started.instance.id.slice(0, 8));
  });

  it('diz que não há incidente quando não há nenhum', async () => {
    const { store, runtime } = await deployed();
    await runtime.start('P');
    const result = await listIncidents(store, runtime);
    expect(result.output).toContain('Nenhum incidente');
  });
});

describe('retryTask', () => {
  it('retry devolve a atividade ao worker', async () => {
    const { store, runtime, token } = await incidented();
    const result = await retryTask(store, runtime, PREFIX, token);

    expect(result.exitCode).toBe(0);
    expect(await store.listJobs()).toHaveLength(1);
  });

  it('explica quando o token não tem incidente', async () => {
    const { store, runtime } = await incidented();
    const result = await retryTask(store, runtime, PREFIX, 'nope');

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('nope');
  });
});

describe('resolveIncident', () => {
  it('resolve encerra a atividade com a variável dada', async () => {
    const { store, runtime, token } = await incidented();
    const result = await resolveIncident(store, runtime, PREFIX, token, { authorized: true });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('completed');
  });
});

describe('start --retries', () => {
  let store: SqliteStore;
  let runtime: EbbRuntime;

  beforeEach(async () => {
    store = new SqliteStore({ path: ':memory:' });
    await store.deploy({ processKey: 'P', xml: EXTERNAL_JOB, checksum: checksumOf(EXTERNAL_JOB) });
    runtime = new EbbRuntime({ store });
  });

  it('journala a política pedida', async () => {
    const started = await startInstance(runtime, 'P', { engine: { retry: { attempts: 2 } } });

    const [birth] = await store.journal(idFrom(started.output));
    expect(birth!.payload.engine).toMatchObject({
      retry: { attempts: 2 },
      onHandlerError: 'incident',
    });
  });
});
