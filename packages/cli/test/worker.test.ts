import { checksumOf, SqliteStore } from '@ebb/store';
import { EbbRuntime } from '@ebb/runtime';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWorker } from '../src/worker.js';

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

const OK = '#!/bin/sh\nread input\necho \'{"authorized":true}\'\n';
const BOOM = '#!/bin/sh\necho "gateway timeout" >&2\nexit 1\n';

let dir: string;

/** Grava um script executável num diretório temporário e devolve o caminho absoluto. */
async function writeScript(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function deployed(): Promise<{ store: SqliteStore; runtime: EbbRuntime }> {
  const store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'P', xml: EXTERNAL_JOB, checksum: checksumOf(EXTERNAL_JOB) });
  const runtime = new EbbRuntime({ store });
  return { store, runtime };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-worker-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runWorker', () => {
  it('completa o job rodando o comando', async () => {
    const { runtime, store } = await deployed();
    await runtime.start('P');
    const script = await writeScript('ok.sh', OK);

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.exitCode).toBe(0);
    expect(await store.listJobs()).toHaveLength(0);
    const [instance] = await store.listInstances();
    expect(instance!.status).toBe('completed');
  });

  it('recebe as variáveis no stdin', async () => {
    const { runtime } = await deployed();
    await runtime.start('P', { variables: { pedido: 42 } });
    const out = join(dir, 'out.json');
    const script = await writeScript('echo.sh', `#!/bin/sh\ncat > "${out}"\necho "{}"\n`);

    await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(JSON.parse(await readFile(out, 'utf8'))).toMatchObject({
      type: 'charge',
      variables: { pedido: 42 },
    });
  });

  it('stdout vazio (ou "{}") completa sem gravar output no journal', async () => {
    const { runtime, store } = await deployed();
    const started = await runtime.start('P');
    const script = await writeScript('echo.sh', '#!/bin/sh\nread input\necho "{}"\n');

    await runWorker(runtime, { type: 'charge', command: [script], once: true });

    const journal = await store.journal(started.instance.id);
    const completion = journal.find((entry) => entry.type === 'completeJob');
    expect(completion?.payload).not.toHaveProperty('output');
  });

  it('saída diferente de zero vira incidente', async () => {
    const { runtime, store } = await deployed();
    await runtime.start('P');
    const script = await writeScript('boom.sh', BOOM);

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.exitCode).toBe(0); // o worker fez o trabalho dele
    expect(await store.listJobs()).toHaveLength(0);
    const [instance] = await store.listInstances();
    const view = await runtime.inspect(instance!.id);
    expect(view.tasks).toMatchObject([{ reason: 'incident' }]);
  });

  it('saída diferente de zero com stdout ilegível ainda assim usa o stderr como mensagem', async () => {
    // O stdout de um processo que falha pode ter qualquer coisa (banner,
    // log de progresso) — não é o canal de diagnóstico dele. Erro de
    // contrato ("respondeu algo que não é JSON") é coisa de saída ZERO.
    const { runtime, store } = await deployed();
    await runtime.start('P');
    const script = await writeScript(
      'noisy.sh',
      '#!/bin/sh\nread input\necho "iniciando cobrança..."\necho "cartão recusado pelo emissor" >&2\nexit 1\n',
    );

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.output).toContain('cartão recusado pelo emissor');
    expect(result.output).not.toContain('não é JSON');
    expect(await store.listJobs()).toHaveLength(0);
    const [instance] = await store.listInstances();
    const view = await runtime.inspect(instance!.id);
    expect(view.incidents).toMatchObject([{ message: 'cartão recusado pelo emissor' }]);
  });

  it('não trava quando o payload no stdin excede o buffer do pipe e o filho não lê nada', async () => {
    // BOOM sai sem consumir o stdin: um payload de alguns bytes passa batido,
    // mas um de alguns megabytes enche o buffer do pipe e o `write` final
    // estoura EPIPE — sem o listener de erro no stdin isso derrubava o
    // processo inteiro com uma exceção não tratada.
    const { runtime, store } = await deployed();
    await runtime.start('P', { variables: { blob: 'x'.repeat(5_000_000) } });
    const script = await writeScript('boom.sh', BOOM);

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.exitCode).toBe(0);
    expect(await store.listJobs()).toHaveLength(0);
  });

  it('uma rodada sem job não faz nada e sai', async () => {
    const { runtime } = await deployed();
    const script = await writeScript('ok.sh', OK);

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.output).toContain('Nenhum job');
  });

  it('stdout que não parseia como JSON com saída 0 é erro de contrato', async () => {
    const { runtime, store } = await deployed();
    await runtime.start('P');
    const script = await writeScript('trash.sh', '#!/bin/sh\nread input\necho "não é json"\n');

    await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(await store.listJobs()).toHaveLength(0);
    const [instance] = await store.listInstances();
    const view = await runtime.inspect(instance!.id);
    expect(view.tasks).toMatchObject([{ reason: 'incident' }]);
  });

  it('stdout com JSON que não é objeto com saída 0 é erro de contrato', async () => {
    const { runtime, store } = await deployed();
    await runtime.start('P');
    const script = await writeScript('array.sh', '#!/bin/sh\nread input\necho "[1,2,3]"\n');

    await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(await store.listJobs()).toHaveLength(0);
    const [instance] = await store.listInstances();
    const view = await runtime.inspect(instance!.id);
    expect(view.tasks).toMatchObject([{ reason: 'incident' }]);
  });

  it('saída diferente de zero com erro de negócio no stdout usa código e mensagem dele', async () => {
    // Sem boundary de erro no diagrama, um erro com código não vira
    // incidente: vira falha da instância — é o "boundary de erro" do
    // contrato do worker, não o caminho de retry/incidente comum.
    const { runtime, store } = await deployed();
    await runtime.start('P');
    const script = await writeScript(
      'business.sh',
      '#!/bin/sh\nread input\necho \'{"error":{"code":"insufficient_funds","message":"saldo insuficiente"}}\'\nexit 1\n',
    );

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.output).toContain('saldo insuficiente');
    expect(await store.listJobs()).toHaveLength(0);
    const [instance] = await store.listInstances();
    expect(instance!.status).toBe('failed');
  });

  it('sem --once, faz laço até um SIGINT parar', async () => {
    const { runtime } = await deployed();
    // Sem instância nenhuma, nunca há job — o comando não roda, então não
    // precisa existir de verdade.
    const before = process.listenerCount('SIGINT');

    const pending = runWorker(runtime, {
      type: 'charge',
      command: ['/não/existe'],
      interval: 5,
    });
    setTimeout(() => process.emit('SIGINT'), 20);
    const result = await pending;

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Nenhum job');
    // O handler de SIGINT não pode sobreviver à chamada: cada run some com o
    // próprio, senão a suíte inteira acumula um por teste e o Ctrl-C do
    // terminal real para de funcionar depois do primeiro `ebb worker`.
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('activateJobs falhando não escapa: vira uma linha de erro na rodada', async () => {
    const { runtime } = await deployed();
    vi.spyOn(runtime, 'activateJobs').mockRejectedValueOnce(new Error('SQLITE_BUSY'));
    const script = await writeScript('ok.sh', OK);

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('SQLITE_BUSY');
  });

  it('completeJob falhando não escapa: a rodada segue e reporta o erro', async () => {
    const { runtime } = await deployed();
    await runtime.start('P');
    vi.spyOn(runtime, 'completeJob').mockRejectedValueOnce(new Error('banco fechado'));
    const script = await writeScript('ok.sh', OK);

    const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('banco fechado');
  });

  it('remove o listener de SIGINT mesmo sem laço (--once)', async () => {
    const { runtime } = await deployed();
    const before = process.listenerCount('SIGINT');
    const script = await writeScript('ok.sh', OK);

    await runWorker(runtime, { type: 'charge', command: [script], once: true });

    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
