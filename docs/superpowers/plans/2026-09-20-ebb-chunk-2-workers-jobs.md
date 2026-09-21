# Chunk 2 — workers e jobs: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um worker rodando em outro processo executa a service task de uma
instância do ebb, com retry automático e incidente quando os retries acabam.

**Architecture:** O `@bpmn-flow/core` ganha uma razão de espera nova (`'job'`):
atividade marcada como job no diagrama e sem handler local parqueia em vez de
passar direto. O ebb projeta esses tokens parados numa tabela `jobs` (índice,
não verdade), entrega-os sob lease a quem pedir por tipo, e grava o desfecho —
`completeJob` ou `failJob` — como comando no journal, pela mesma porta
(`applyCommand`) que o replay do chunk 3 vai usar.

**Tech Stack:** TypeScript 5.9, Node ≥ 24 (`node:sqlite`), vitest 4, tsup
(`bundle: false`), npm workspaces. Dois repositórios: `../bpmn-flow` (PR) e
este.

**Spec:** [`docs/superpowers/specs/2026-09-20-ebb-chunk-2-workers-jobs.md`](../specs/2026-09-20-ebb-chunk-2-workers-jobs.md)

## Global Constraints

- **Node ≥ 24**, `node:sqlite`, nenhuma dependência nova sem justificar.
- Shell não-interativo: antes de qualquer `npm`/`npx`, rodar
  `unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH`.
- `npm run verify` (build → format:check → lint → typecheck → coverage) tem de
  ficar verde **em cada commit**, nos dois repositórios. Pisos de cobertura do
  ebb: 90 statements / 85 branches / 90 functions / 90 lines.
- Conventional Commits, subject imperativo em inglês, ≤ 72 caracteres. Rodapé
  `Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb`.
- Identificador, docstring e comentário em **inglês** no `bpmn-flow`; em
  **português** no ebb quando o arquivo vizinho estiver em português (é o caso
  de todo `packages/*/src` daqui), identificador sempre em inglês.
- Linha do SQLite nunca vira tipo por `as`: passa por
  `packages/store/src/rows.ts`.
- **Sem bump de `ENGINE_STATE_VERSION`.** Se algum passo parecer exigir um,
  pare e reporte: significa que o desenho saiu do trilho.
- Branch do ebb: `feat/workers-and-jobs` (já criada). Branch do bpmn-flow:
  `feat/external-jobs`. Nunca commit direto em `master` nos dois.

---

## Estrutura de arquivos

**`../bpmn-flow` (tarefas 1–4):**

| Arquivo                                    | Responsabilidade                                               |
| ------------------------------------------ | -------------------------------------------------------------- |
| `packages/core/src/parser/moddle-types.ts` | tipar `$attrs` e o `zeebe:taskDefinition` que o moddle devolve |
| `packages/core/src/parser/parse.ts`        | ler as duas convenções e produzir `FlowNode.job`               |
| `packages/core/src/model/types.ts`         | o campo `job` no modelo                                        |
| `packages/core/src/engine/types.ts`        | `WaitReason: 'job'`, `PendingTask.job`                         |
| `packages/core/src/engine/engine.ts`       | parar no job, `failJob`                                        |
| `packages/core/test/fixtures.ts`           | fixture `EXTERNAL_JOB`                                         |
| `packages/core/test/jobs.test.ts`          | os testes do subsistema (arquivo novo)                         |

**este repositório (tarefas 5–10):**

| Arquivo                            | Responsabilidade                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/store/src/types.ts`      | `JobRecord`, `JobProjection`, os métodos de job no `Store`                           |
| `packages/store/src/migrations.ts` | migração 3: tabela `jobs`                                                            |
| `packages/store/src/jobs.ts`       | mapeador linha→`JobRecord` (arquivo novo)                                            |
| `packages/store/src/sqlite.ts`     | reconciliação dentro da transação, `listJobs`, `lockJobs`                            |
| `packages/store/src/tx.ts`         | `BEGIN IMMEDIATE` para a transação que trava job                                     |
| `packages/runtime/src/commands.ts` | as quatro variantes novas de `InstanceCommand`                                       |
| `packages/runtime/src/jobs.ts`     | projeção `engine → JobProjection[]` (arquivo novo)                                   |
| `packages/runtime/src/errors.ts`   | `InstanceTerminatedError`                                                            |
| `packages/runtime/src/runtime.ts`  | guarda terminal, projeção nas duas gravações, `activateJobs`/`completeJob`/`failJob` |
| `packages/cli/src/jobs.ts`         | `ebb jobs`, `ebb incidents`, `ebb retry`, `ebb resolve` (arquivo novo)               |
| `packages/cli/src/worker.ts`       | `ebb worker` e o processo filho (arquivo novo)                                       |
| `packages/cli/src/bin.ts`          | despacho e `USAGE`                                                                   |

`jobs.ts` separado do `instances.ts` no CLI e do `runtime.ts` no runtime porque
são responsabilidades distintas e porque `instances.ts` já tem 228 linhas.

---

## Tarefa 1: o parser lê o tipo de job

**Files:**

- Modify: `../bpmn-flow/packages/core/src/parser/moddle-types.ts`
- Modify: `../bpmn-flow/packages/core/src/parser/parse.ts:270-300`
- Modify: `../bpmn-flow/packages/core/src/model/types.ts:156` (depois de `candidates`)
- Modify: `../bpmn-flow/packages/core/test/fixtures.ts`
- Test: `../bpmn-flow/packages/core/test/jobs.test.ts` (novo)

**Interfaces:**

- Consumes: nada.
- Produces: `FlowNode.job?: { type: string; retries?: number }`; a fixture
  exportada `EXTERNAL_JOB` (processo `P`, com `Start → Charge → End`, onde
  `Charge` é `serviceTask` marcada com `zeebe:taskDefinition type="charge"`).

As duas formas foram verificadas contra o `bpmn-moddle` 10.2 instalado:
`<zeebe:taskDefinition type="ship" retries="3"/>` sob `extensionElements` cai em
`extensionElements.values[]` com `$type: 'zeebe:taskDefinition'` e `type` /
`retries` como **propriedades diretas de string**; `camunda:type="external"
camunda:topic="charge"` cai em `el.$attrs['camunda:type']` e
`el.$attrs['camunda:topic']`.

- [ ] **Step 1: Escrever a fixture**

Em `packages/core/test/fixtures.ts`, ao lado das outras (o `wrap` já existe, mas
ele não declara o namespace `zeebe`; por isso esta fixture monta o documento
inteiro):

```ts
/** Service task marcada como job externo na convenção do Zeebe/Camunda 8. */
export const EXTERNAL_JOB = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" name="Charge card">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="charge" retries="2" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

/** A mesma coisa na convenção do Camunda 7: atributos no próprio elemento. */
export const EXTERNAL_JOB_C7 = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" camunda:type="external" camunda:topic="charge" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;
```

- [ ] **Step 2: Escrever o teste que falha**

`packages/core/test/jobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseBpmn } from '../src/index.js';
import { EXTERNAL_JOB, EXTERNAL_JOB_C7, LINEAR } from './fixtures.js';

describe('job declarado no diagrama', () => {
  it('lê a convenção zeebe:taskDefinition', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toEqual({ type: 'charge', retries: 2 });
  });

  it('lê a convenção camunda:type="external"', async () => {
    const model = await parseBpmn(EXTERNAL_JOB_C7);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toEqual({ type: 'charge' });
  });

  it('não inventa job para uma service task sem marcação', async () => {
    const model = await parseBpmn(LINEAR);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toBeUndefined();
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

```bash
unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH
cd ../bpmn-flow && npx vitest run packages/core/test/jobs.test.ts
```

Esperado: FAIL — `job` é `undefined` nos dois primeiros (`Property 'job' does
not exist` no typecheck também).

- [ ] **Step 4: O campo no modelo**

Em `packages/core/src/model/types.ts`, logo depois de `candidates?: string[];`:

```ts
  /**
   * Work handed to something outside the engine: the activity parks until a
   * worker completes it. Read from `zeebe:taskDefinition` or from Camunda 7's
   * `camunda:type="external"`, so a diagram authored in either tool runs here.
   */
  job?: { type: string; retries?: number };
```

- [ ] **Step 5: Os tipos do moddle**

Em `packages/core/src/parser/moddle-types.ts`, estender o valor de extensão e o
elemento:

```ts
/** Anything a tool put under `bpmn:extensionElements`, attributes included. */
export interface MdExtensionElements {
  values?: (MdRef & {
    correlationKey?: string;
    /** `zeebe:taskDefinition`: the worker queue and the retry count. */
    type?: string;
    retries?: string;
  })[];
}
```

E em `MdElement`, junto dos outros campos opcionais:

```ts
  /** Attributes from namespaces the moddle does not know, prefix included. */
  $attrs?: Record<string, string>;
```

- [ ] **Step 6: A leitura no parser**

Em `packages/core/src/parser/parse.ts`, junto das outras funções de leitura
(perto de `readCorrelationKey`, linha ~85):

```ts
/**
 * The job a worker outside the engine performs, in the two conventions real
 * tools emit: `<zeebe:taskDefinition type="charge" retries="2"/>` under
 * `extensionElements`, and Camunda 7's `camunda:type="external"` with
 * `camunda:topic`. Anything else is not a job, and the activity keeps the
 * behaviour it has today.
 */
function readJob(el: MdElement): FlowNode['job'] {
  for (const value of el.extensionElements?.values ?? []) {
    if (!value.$type?.endsWith(':taskDefinition')) continue;
    const type = value.type?.trim();
    if (!type) continue;
    const retries = Number(value.retries);
    return Number.isInteger(retries) && retries >= 0 ? { type, retries } : { type };
  }
  const attrs = el.$attrs ?? {};
  if (attrs['camunda:type'] !== 'external') return undefined;
  const topic = attrs['camunda:topic']?.trim();
  return topic ? { type: topic } : undefined;
}
```

E, na construção do nó (linha ~288, depois de `node.candidates`):

```ts
const job = readJob(el);
if (job) node.job = job;
```

- [ ] **Step 7: Rodar e ver passar**

```bash
cd ../bpmn-flow && npx vitest run packages/core/test/jobs.test.ts
```

Esperado: PASS, três testes.

- [ ] **Step 8: Verify e commit**

```bash
cd ../bpmn-flow && npm run verify
git checkout -b feat/external-jobs
git add packages/core/src packages/core/test
git commit -m "feat(core): read the external job type from the diagram

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

(Se a branch já existir, só `git checkout feat/external-jobs`.)

---

## Tarefa 2: a atividade para no job

**Files:**

- Modify: `../bpmn-flow/packages/core/src/engine/types.ts:9-16` e `:29-43`
- Modify: `../bpmn-flow/packages/core/src/engine/engine.ts:839-853` e `:265-285`
- Test: `../bpmn-flow/packages/core/test/jobs.test.ts`

**Interfaces:**

- Consumes: `FlowNode.job` da tarefa 1.
- Produces: `WaitReason` passa a incluir `'job'`; `PendingTask.job?: { type:
string }`; um token parado num job aparece em `engine.tasks({ reason: 'job'
})` e é retomável por `engine.completeTask(tokenId, output)`.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar a `packages/core/test/jobs.test.ts`:

```ts
import { WorkflowEngine } from '../src/index.js';
import type { ProcessModel } from '../src/index.js';

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

describe('espera por worker externo', () => {
  it('para na atividade em vez de passar direto', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    const snap = await eng.start();

    expect(snap.status).toBe('waiting');
    const [task] = eng.tasks({ reason: 'job' });
    expect(task).toMatchObject({ nodeId: 'Charge', reason: 'job', job: { type: 'charge' } });
  });

  it('segue o fluxo quando o worker conclui', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    await eng.start();
    const [task] = eng.tasks({ reason: 'job' });

    const snap = await eng.completeTask(task!.tokenId, { authorized: true });

    expect(snap.status).toBe('completed');
    expect(snap.variables).toMatchObject({ authorized: true });
  });

  it('deixa o handler local ganhar, quando há um', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    eng.registerHandler('Charge', () => ({ authorized: true }));

    const snap = await eng.start();

    expect(snap.status).toBe('completed');
    expect(eng.tasks({ reason: 'job' })).toHaveLength(0);
  });

  it('sobrevive a um restore com o token parado no job', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const eng = new WorkflowEngine(model.processes[0]!);
    await eng.start();
    const state = eng.getState();

    const revived = WorkflowEngine.restore(model.processes[0]!, state);
    const [task] = revived.tasks({ reason: 'job' });
    expect(task).toMatchObject({ nodeId: 'Charge', reason: 'job' });
    expect(state.version).toBe(ENGINE_STATE_VERSION);
  });
});
```

Acrescentar `ENGINE_STATE_VERSION` ao import de `../src/index.js`.

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd ../bpmn-flow && npx vitest run packages/core/test/jobs.test.ts
```

Esperado: FAIL — a instância completa sem parar (`status` é `'completed'` no
primeiro teste).

- [ ] **Step 3: A razão de espera e o campo da tarefa**

Em `packages/core/src/engine/types.ts`, na união `WaitReason`, depois de
`'boundary'`:

```ts
  /** Work an outside worker performs: the activity holds until it reports back. */
  | 'job'
```

E em `PendingTask`, depois de `candidates`:

```ts
  /** Present when the activity is an external job: the worker queue it belongs to. */
  job?: { type: string };
```

- [ ] **Step 4: O ramo em `handleActivity`**

Em `packages/core/src/engine/engine.ts`, dentro de `if (!handler) { ... }`,
**antes** do comentário `// Unhandled automatic task: pass straight through.`:

```ts
// Declared as an external job: hold until a worker reports back. A local
// handler still wins, which is what lets a test double one out.
if (node.job) {
  this.park(token, 'job');
  return;
}
```

- [ ] **Step 5: O tipo do job na tarefa pendente**

Em `tasks()` (linha ~272), junto dos outros campos condicionais do objeto
`task`:

```ts
        ...(node.job ? { job: { type: node.job.type } } : {}),
```

- [ ] **Step 6: Rodar e ver passar**

```bash
cd ../bpmn-flow && npx vitest run packages/core/test/jobs.test.ts
```

Esperado: PASS, sete testes. O quarto prova que `ENGINE_STATE_VERSION` não
mudou.

- [ ] **Step 7: Verify e commit**

```bash
cd ../bpmn-flow && npm run verify
git add packages/core/src packages/core/test
git commit -m "feat(core): hold an activity declared as an external job

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

---

## Tarefa 3: `failJob` — retry e incidente

**Files:**

- Modify: `../bpmn-flow/packages/core/src/engine/engine.ts` (perto de
  `retryTask`, linha ~350)
- Test: `../bpmn-flow/packages/core/test/jobs.test.ts`

**Interfaces:**

- Consumes: a espera `'job'` da tarefa 2; `handleFailure`
  (`engine.ts:886`), que já implementa `retry.attempts` / `retry.delay` e
  `onHandlerError`.
- Produces: `engine.failJob(tokenId: string, error: Error):
Promise<ExecutionSnapshot>`. Com `BpmnError`, aciona o boundary de erro; com
  `Error` comum, entra no mesmo caminho de retry/incidente de um handler que
  lança.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar a `packages/core/test/jobs.test.ts`:

```ts
import { BpmnError } from '../src/index.js';

describe('worker que falha', () => {
  it('vira incidente quando os retries acabam', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB), {
      onHandlerError: 'incident',
    });
    await eng.start();
    const [task] = eng.tasks({ reason: 'job' });

    const snap = await eng.failJob(task!.tokenId, new Error('gateway timeout'));

    expect(snap.status).toBe('waiting');
    expect(eng.incidentList()).toMatchObject([
      { nodeId: 'Charge', message: 'gateway timeout', attempts: 1 },
    ]);
    expect(eng.tasks({ reason: 'job' })).toHaveLength(0);
  });

  it('devolve o job ao worker enquanto houver tentativa', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB), {
      onHandlerError: 'incident',
      retry: { attempts: 1 },
    });
    await eng.start();
    const [first] = eng.tasks({ reason: 'job' });

    await eng.failJob(first!.tokenId, new Error('gateway timeout'));

    // Ainda há tentativa: a atividade volta a esperar worker, não vira incidente.
    expect(eng.tasks({ reason: 'job' })).toHaveLength(1);
    expect(eng.incidentList()).toHaveLength(0);
  });

  it('recusa um token que não está esperando worker', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    await eng.start();

    await expect(eng.failJob('nope', new Error('x'))).rejects.toThrow(/No job for token/);
  });

  it('dispara o boundary de erro quando o worker manda um BpmnError', async () => {
    const eng = new WorkflowEngine(await process(JOB_WITH_BOUNDARY));
    await eng.start();
    const [task] = eng.tasks({ reason: 'job' });

    const snap = await eng.failJob(task!.tokenId, new BpmnError('DECLINED'));

    expect(snap.completedNodes).toContain('Declined');
  });
});
```

E a fixture correspondente em `packages/core/test/fixtures.ts`:

```ts
/** Um job com boundary de erro, para o worker poder devolver erro de negócio. */
export const JOB_WITH_BOUNDARY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" name="Charge card">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="charge" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:boundaryEvent id="OnDeclined" attachedToRef="Charge">
      <bpmn:errorEventDefinition errorRef="Declined" />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End" />
    <bpmn:endEvent id="Declined" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="End" />
    <bpmn:sequenceFlow id="f3" sourceRef="OnDeclined" targetRef="Declined" />
  </bpmn:process>
  <bpmn:error id="Declined" name="Declined" errorCode="DECLINED" />
</bpmn:definitions>`;
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
cd ../bpmn-flow && npx vitest run packages/core/test/jobs.test.ts
```

Esperado: FAIL — `eng.failJob is not a function`.

- [ ] **Step 3: Implementar `failJob`**

Em `packages/core/src/engine/engine.ts`, logo depois de `retryTask`:

```ts
  /**
   * A worker reports the job it took could not be done. Routed through the same
   * path a throwing handler takes, so retries, incidents and error boundary
   * events mean exactly what they mean in-process.
   */
  async failJob(tokenId: string, error: Error): Promise<ExecutionSnapshot> {
    const token = this.waiting.get(tokenId);
    if (!token || token.waiting !== 'job') {
      throw new BpmnExecutionError(`No job for token: ${tokenId}`);
    }
    const node = token.scope.graph.node(token.nodeId);
    if (!node) throw new BpmnExecutionError(`No job for token: ${tokenId}`);

    this.waiting.delete(tokenId);
    token.waiting = undefined;
    if (error instanceof BpmnError) {
      this.emitter.emit('activity.end', { nodeId: node.id, tokenId: token.id });
      this.discard(token);
      if (!this.raiseErrorOnActivity(token.scope, node.id, error.code)) {
        if (!this.raiseErrorOnEventSubProcess(error.code)) this.fail(error);
      }
    } else {
      this.handleFailure(token, node, error);
    }
    await this.drain();
    return this.snapshot();
  }
```

Atenção ao caminho de retry: `handleFailure` põe o token em `this.ready` quando
ainda há tentativa e não há `delay`, e o `drain()` seguinte o leva de volta a
`handleActivity` — que, sem handler local e com `node.job`, o parqueia como job
de novo. É esse laço que faz o segundo teste passar sem nenhum código a mais.

- [ ] **Step 3b: `restore` tem de aceitar `onHandlerError` e `retry`**

Achado do scan pré-voo, e sem ele o chunk 2 não fecha: `WorkflowEngine.restore`
aceita só `mode | maxSteps | processes | now | expressions`
(`packages/core/src/engine/engine.ts:508`), e nenhuma das duas está em
`EngineState`. Logo **toda instância re-hidratada volta com `onHandlerError:
'fail'` e zero retries** — um `failJob` mataria a execução em vez de abrir
incidente, que é exatamente o critério de pronto do chunk.

A correção é aditiva e **não toca `EngineState`**: quem lembra as opções é o
journal do ebb, como o chunk 1 já faz com `mode`/`maxSteps`/`expressions`.

Primeiro o teste, em `packages/core/test/jobs.test.ts`:

```ts
it('restaura mantendo a política de falha que o host passar', async () => {
  const model = await parseBpmn(EXTERNAL_JOB);
  const eng = new WorkflowEngine(model.processes[0]!, { onHandlerError: 'incident' });
  await eng.start();

  const revived = WorkflowEngine.restore(model.processes[0]!, eng.getState(), {
    onHandlerError: 'incident',
  });
  const [task] = revived.tasks({ reason: 'job' });
  await revived.failJob(task!.tokenId, new Error('gateway timeout'));

  // Sem o alargamento, o motor restaurado cairia em 'fail' e mataria a instância.
  expect(revived.incidentList()).toMatchObject([{ message: 'gateway timeout' }]);
});
```

Depois, a assinatura:

```ts
    options: Pick<
      EngineOptions,
      'mode' | 'maxSteps' | 'processes' | 'now' | 'expressions' | 'onHandlerError' | 'retry'
    > = {},
```

e, no `new WorkflowEngine(...)` de dentro do `restore`, junto dos outros campos
condicionais:

```ts
      ...(options.onHandlerError ? { onHandlerError: options.onHandlerError } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
```

Atualizar a docstring do `restore`: hoje ela diz "Re-register handlers and
listeners before resuming"; acrescentar que as políticas de falha também são do
host, porque não fazem parte do estado serializado.

- [ ] **Step 4: Rodar e ver passar**

```bash
cd ../bpmn-flow && npx vitest run packages/core/test/jobs.test.ts
```

Esperado: PASS, doze testes.

- [ ] **Step 5: Rodar a suíte inteira**

```bash
cd ../bpmn-flow && npx vitest run
```

Esperado: PASS. Atenção especial a `tasks.test.ts` e `api-contract.test.ts`, que
enumeram razões de espera e superfície pública — se algum deles falhar, é
asserção a atualizar, não regressão.

- [ ] **Step 6: Verify e commit**

```bash
cd ../bpmn-flow && npm run verify
git add packages/core/src packages/core/test
git commit -m "feat(core): let a worker report a failed job

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

---

## Tarefa 4: documentar e abrir o PR do `bpmn-flow`

**Files:**

- Modify: `../bpmn-flow/CHANGELOG.md`
- Modify: `../bpmn-flow/packages/core/README.md` (se existir a seção de
  handlers; caso não exista, pular o arquivo e dizer isso no relatório)

**Interfaces:**

- Consumes: tudo das tarefas 1–3.
- Produces: PR aberto em `Bappoz/bpmn-flow`. **O restante do plano depende dele
  estar mergeado**, porque o ebb consome o core por dependência de caminho.

- [ ] **Step 1: Entrada no CHANGELOG**

Seguir o formato das entradas já existentes no topo do arquivo, descrevendo:
`WaitReason: 'job'`, `FlowNode.job` lido das duas convenções,
`PendingTask.job`, `engine.failJob(tokenId, error)`, e a frase que importa para
quem atualiza: **`ENGINE_STATE_VERSION` não mudou; estado gravado por versões
anteriores continua sendo restaurável.**

- [ ] **Step 2: Verify**

```bash
cd ../bpmn-flow && npm run verify
```

- [ ] **Step 3: Commit e PR**

```bash
cd ../bpmn-flow
git add CHANGELOG.md packages/core/README.md
git commit -m "docs(core): document the external job wait state

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
git push -u origin feat/external-jobs
gh pr create --fill
```

O corpo do PR explica **por que não é opção de motor**: a razão de espera é
string no token serializado, então `'job'` não muda a forma de `EngineState`,
enquanto uma `EngineOption` nova teria de entrar no estado e invalidaria todo
snapshot gravado. Terminar com
`https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb`.

- [ ] **Step 4: Parar e reportar**

`git push` e `gh pr create` são ações externas: **confirmar com o usuário antes
de rodar**. Depois de aberto, o plano fica bloqueado até o merge; reportar e
esperar.

---

## Tarefa 5: a tabela `jobs` e a reconciliação no store

**Files:**

- Modify: `packages/store/src/types.ts`
- Modify: `packages/store/src/migrations.ts`
- Create: `packages/store/src/jobs.ts`
- Modify: `packages/store/src/sqlite.ts`
- Modify: `packages/store/src/tx.ts`
- Modify: `packages/store/src/index.ts`
- Test: `packages/store/test/jobs.test.ts` (novo)

**Interfaces:**

- Consumes: `transaction(db, fn)`, `rows.ts`, `SCHEMA_VERSION`.
- Produces:

```ts
export interface JobProjection {
  tokenId: string;
  nodeId: string;
  type: string;
  variables: Record<string, unknown>;
  attempts: number;
}

export interface JobRecord extends JobProjection {
  instanceId: string;
  state: 'pending' | 'locked';
  worker?: string;
  lockedUntil?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LockJobsInput {
  type: string;
  worker: string;
  count: number;
  /** Epoch ms em que a trava vence. */
  until: number;
  /** Epoch ms de agora, para reconhecer trava vencida. */
  now: number;
}

// no Store:
listJobs(filter?: { type?: string; instanceId?: string }): Promise<JobRecord[]>;
lockJobs(input: LockJobsInput): Promise<JobRecord[]>;
```

E `CreateInstanceInput` e `AppendInput` ganham `jobs: JobProjection[]`
(**obrigatório**: `undefined` seria ambíguo entre "sem job" e "não mexa", e o
`tsc` apontando cada chamador é o ponto).

- [ ] **Step 1: Escrever o teste que falha**

`packages/store/test/jobs.test.ts` — seguir o padrão de
`packages/store/test/instances.test.ts` para abrir store em arquivo temporário e
publicar um deployment antes de criar instância.

```ts
import { describe, expect, it } from 'vitest';
// ...o mesmo helper de setup de instances.test.ts: store temporário + deploy + createInstance

const VARS = { pedido: 42 };

function projection(tokenId: string, attempts = 0): JobProjection {
  return { tokenId, nodeId: 'Charge', type: 'charge', variables: VARS, attempts };
}

describe('jobs', () => {
  it('nasce da criação da instância', async () => {
    const { store, instance } = await seeded({ jobs: [projection('t1')] });
    expect(await store.listJobs()).toMatchObject([
      { instanceId: instance.id, tokenId: 't1', type: 'charge', state: 'pending' },
    ]);
  });

  it('a reconciliação apaga o que saiu e insere o que entrou', async () => {
    const { store, instance } = await seeded({ jobs: [projection('t1')] });
    await store.append({
      instanceId: instance.id,
      status: 'waiting',
      command: CMD,
      state: STATE,
      jobs: [projection('t2')],
    });

    expect(await store.listJobs()).toMatchObject([{ tokenId: 't2' }]);
  });

  it('a reconciliação preserva a trava de um job que continua parado', async () => {
    const { store, instance } = await seeded({ jobs: [projection('t1')] });
    const [locked] = await store.lockJobs({
      type: 'charge',
      worker: 'w1',
      count: 1,
      until: 5_000,
      now: 1_000,
    });
    await store.append({
      instanceId: instance.id,
      status: 'waiting',
      command: CMD,
      state: STATE,
      jobs: [projection('t1')],
    });

    expect(locked).toMatchObject({ state: 'locked', worker: 'w1', lockedUntil: 5_000 });
    expect(await store.listJobs()).toMatchObject([{ state: 'locked', worker: 'w1' }]);
  });

  it('não entrega duas vezes o mesmo job', async () => {
    const { store } = await seeded({ jobs: [projection('t1')] });
    const first = await store.lockJobs({
      type: 'charge',
      worker: 'w1',
      count: 5,
      until: 5_000,
      now: 1_000,
    });
    const second = await store.lockJobs({
      type: 'charge',
      worker: 'w2',
      count: 5,
      until: 5_000,
      now: 1_000,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('devolve o job cuja trava venceu', async () => {
    const { store } = await seeded({ jobs: [projection('t1')] });
    await store.lockJobs({ type: 'charge', worker: 'w1', count: 1, until: 5_000, now: 1_000 });

    const retaken = await store.lockJobs({
      type: 'charge',
      worker: 'w2',
      count: 1,
      until: 12_000,
      now: 6_000,
    });

    expect(retaken).toMatchObject([{ worker: 'w2', lockedUntil: 12_000 }]);
  });

  it('filtra por tipo e por instância', async () => {
    const { store, instance } = await seeded({
      jobs: [projection('t1'), { ...projection('t2'), type: 'ship' }],
    });
    expect(await store.listJobs({ type: 'ship' })).toHaveLength(1);
    expect(await store.listJobs({ instanceId: instance.id })).toHaveLength(2);
    expect(await store.listJobs({ instanceId: 'outra' })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH
npx vitest run packages/store/test/jobs.test.ts
```

Esperado: FAIL — `store.listJobs is not a function`.

- [ ] **Step 3: A migração 3**

Em `packages/store/src/migrations.ts`, acrescentar ao array `MIGRATIONS` (o
`SCHEMA_VERSION` se atualiza sozinho, é derivado do último elemento):

```ts
  // `jobs` é índice, não verdade: a linha é derivada dos tokens parados no
  // motor e reconstruível a partir do journal. Existe para um worker varrer
  // trabalho pendente de todas as instâncias sem re-hidratar motor nenhum.
  // `locked_until` é lease e não heartbeat: um `ebb worker` morto não avisa
  // ninguém, e o vencimento é o que devolve o job.
  {
    version: 3,
    name: 'jobs',
    up: `
      CREATE TABLE jobs (
        instance_id   TEXT    NOT NULL,
        token_id      TEXT    NOT NULL,
        node_id       TEXT    NOT NULL,
        type          TEXT    NOT NULL,
        variables     TEXT    NOT NULL,
        state         TEXT    NOT NULL,
        worker        TEXT,
        locked_until  INTEGER,
        attempts      INTEGER NOT NULL,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL,
        PRIMARY KEY (instance_id, token_id),
        FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
      );
      CREATE INDEX jobs_pending ON jobs (type, state, locked_until);
    `,
  },
```

- [ ] **Step 4: O mapeador de linha**

`packages/store/src/jobs.ts`:

```ts
import { integer, jsonObject, optionalText, text, type Row } from './rows.js';
import type { JobRecord } from './types.js';

function optionalInteger(row: Row, column: string): number | undefined {
  return row[column] === null || row[column] === undefined ? undefined : integer(row, column);
}

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
```

- [ ] **Step 5: `BEGIN IMMEDIATE` no `tx.ts`**

```ts
/**
 * Roda `fn` numa transação, desfazendo o que ela escreveu quando ela lança.
 *
 * `immediate` pega a trava de escrita já no `BEGIN`, em vez de na primeira
 * escrita. É o que impede dois processos de lerem o mesmo job pendente e
 * travarem os dois — o segundo espera, em vez de ganhar uma corrida.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T, immediate = false): T {
  db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
  // ...o resto como está
}
```

- [ ] **Step 6: A reconciliação e as consultas no `sqlite.ts`**

`createInstance` e `append` passam a chamar `this.reconcileJobs(id, input.jobs)`
dentro da transação que já existe, logo depois de `writeEngineState`. E:

```ts
  /**
   * Alinha a tabela com os jobs que o motor ainda tem parados: o que sumiu sai,
   * o que entrou entra, o que continua fica como está — trava inclusive, para
   * um comando concorrente não roubar o job de quem já o pegou.
   */
  private reconcileJobs(instanceId: string, jobs: JobProjection[]): void {
    const at = this.now().toISOString();
    const keep = jobs.map((job) => job.tokenId);
    const placeholders = keep.map(() => '?').join(', ');
    this.db
      .prepare(
        `DELETE FROM jobs WHERE instance_id = ?${
          keep.length > 0 ? ` AND token_id NOT IN (${placeholders})` : ''
        }`,
      )
      .run(instanceId, ...keep);
    const upsert = this.db.prepare(
      `INSERT INTO jobs (instance_id, token_id, node_id, type, variables, state,
                         attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT (instance_id, token_id) DO UPDATE SET
         variables = excluded.variables, attempts = excluded.attempts, updated_at = excluded.updated_at`,
    );
    for (const job of jobs) {
      upsert.run(
        instanceId, job.tokenId, job.nodeId, job.type,
        JSON.stringify(job.variables), job.attempts, at, at,
      );
    }
  }

  listJobs(filter: { type?: string; instanceId?: string } = {}): Promise<JobRecord[]> {
    return promised(() => {
      const where: string[] = [];
      const args: string[] = [];
      if (filter.type !== undefined) {
        where.push('type = ?');
        args.push(filter.type);
      }
      if (filter.instanceId !== undefined) {
        where.push('instance_id = ?');
        args.push(filter.instanceId);
      }
      const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
      return this.db
        .prepare(`SELECT * FROM jobs${clause} ORDER BY created_at, token_id`)
        .all(...args)
        .map(toJob);
    });
  }

  lockJobs(input: LockJobsInput): Promise<JobRecord[]> {
    return promised(() =>
      transaction(
        this.db,
        () => {
          const candidates = this.db
            .prepare(
              `SELECT instance_id, token_id FROM jobs
               WHERE type = ? AND (state = 'pending' OR locked_until <= ?)
               ORDER BY created_at, token_id LIMIT ?`,
            )
            .all(input.type, input.now, input.count)
            .map((row) => [text(row, 'instance_id'), text(row, 'token_id')] as const);
          const lock = this.db.prepare(
            `UPDATE jobs SET state = 'locked', worker = ?, locked_until = ?, updated_at = ?
             WHERE instance_id = ? AND token_id = ?`,
          );
          const read = this.db.prepare('SELECT * FROM jobs WHERE instance_id = ? AND token_id = ?');
          const at = this.now().toISOString();
          return candidates.map(([instanceId, tokenId]) => {
            lock.run(input.worker, input.until, at, instanceId, tokenId);
            return toJob(read.get(instanceId, tokenId) as Row);
          });
        },
        true,
      ),
    );
  }
```

O `as Row` acima é a única exceção da regra de `as`: `read.get` acabou de ser
escrito pelo `UPDATE` da linha anterior, dentro da mesma transação. Se a revisão
preferir, trocar por `const row = read.get(...); if (!row) throw new Error(...)`
— **prefira isto**, é mais barato do que abrir exceção a uma regra.

- [ ] **Step 7: Exportar do `index.ts`**

`JobProjection`, `JobRecord`, `LockJobsInput` em `packages/store/src/index.ts`,
na mesma forma dos tipos já exportados.

- [ ] **Step 8: Ajustar os chamadores existentes**

`jobs: []` em todo `createInstance`/`append` dos testes do chunk 1
(`packages/store/test/instances.test.ts`, `packages/store/test/tx.test.ts`) e em
`packages/runtime/src/runtime.ts` — provisoriamente, até a tarefa 7. O `tsc`
lista todos.

- [ ] **Step 9: Rodar e ver passar**

```bash
npx vitest run packages/store
```

Esperado: PASS, incluindo os seis testes novos.

- [ ] **Step 10: Verify e commit**

```bash
npm run verify
git add packages/store packages/runtime
git commit -m "feat(store): project pending jobs beside the journal

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

---

## Tarefa 6: os comandos novos e a guarda de status terminal

**Files:**

- Modify: `packages/runtime/src/commands.ts`
- Modify: `packages/runtime/src/errors.ts`
- Modify: `packages/runtime/src/runtime.ts` (`apply`)
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/commands.test.ts`, `packages/runtime/test/runtime.test.ts`

**Interfaces:**

- Consumes: `engine.completeTask`, `engine.failJob`, `engine.retryTask`,
  `engine.resolveIncident` do core.
- Produces: `InstanceCommand` com quatro variantes novas;
  `InstanceTerminatedError`.

- [ ] **Step 1: Escrever os testes que falham**

Em `packages/runtime/test/commands.test.ts`, no estilo dos que já existem (cada
um monta um motor de verdade sobre a fixture e verifica o efeito):

```ts
it('completeJob conclui a atividade parada no worker', async () => {
  const engine = await startedOnJob();
  const [task] = engine.tasks({ reason: 'job' });

  const snap = await applyCommand(engine, {
    type: 'completeJob',
    tokenId: task!.tokenId,
    output: { authorized: true },
  });

  expect(snap.status).toBe('completed');
  expect(snap.variables).toMatchObject({ authorized: true });
});

it('failJob sem código vira falha técnica', async () => {
  const engine = await startedOnJob({ onHandlerError: 'incident' });
  const [task] = engine.tasks({ reason: 'job' });

  await applyCommand(engine, {
    type: 'failJob',
    tokenId: task!.tokenId,
    error: { message: 'gateway timeout' },
  });

  expect(engine.incidentList()).toMatchObject([{ message: 'gateway timeout' }]);
});

it('failJob com código vira erro de negócio', async () => {
  const engine = await startedOnJobWithBoundary();
  const [task] = engine.tasks({ reason: 'job' });

  const snap = await applyCommand(engine, {
    type: 'failJob',
    tokenId: task!.tokenId,
    error: { message: 'recusado', code: 'DECLINED' },
  });

  expect(snap.completedNodes).toContain('Declined');
});

it('payloadOf não leva o tipo junto', () => {
  expect(payloadOf({ type: 'retryTask', tokenId: 't1' })).toEqual({ tokenId: 't1' });
});
```

E em `packages/runtime/test/runtime.test.ts`:

```ts
it('recusa comando em instância terminada', async () => {
  const { runtime, instance } = await completedInstance();

  await expect(runtime.apply(instance.id, { type: 'tick' })).rejects.toThrow(
    InstanceTerminatedError,
  );
  // O journal não cresceu.
  expect((await runtime.inspect(instance.id)).journal).toHaveLength(instance.seq);
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run packages/runtime
```

Esperado: FAIL — o `tsc` do vitest recusa os tipos novos de comando.

- [ ] **Step 3: As variantes e o despacho**

Em `packages/runtime/src/commands.ts`, na união:

```ts
  | { type: 'completeJob'; tokenId: string; output?: Record<string, unknown> }
  | { type: 'failJob'; tokenId: string; error: { message: string; code?: string } }
  | { type: 'retryTask'; tokenId: string }
  | { type: 'resolveIncident'; tokenId: string; output?: Record<string, unknown> }
```

E em `applyCommand` (a união é exaustiva sem `default`, então o `tsc` cobra os
quatro):

```ts
    case 'completeJob':
      return engine.completeTask(command.tokenId, command.output);
    case 'failJob':
      // O erro é gravado como dado porque um Error não sobrevive a
      // JSON.stringify, e o replay tem de reproduzir a mesma falha: com código
      // é erro de negócio (boundary de erro), sem código é falha técnica
      // (retry e incidente).
      return engine.failJob(
        command.tokenId,
        command.error.code
          ? new BpmnError(command.error.code, command.error.message)
          : new Error(command.error.message),
      );
    case 'retryTask':
      return engine.retryTask(command.tokenId);
    case 'resolveIncident':
      return engine.resolveIncident(command.tokenId, command.output);
```

Importar `BpmnError` de `@bpmn-flow/core` (valor, não tipo).

- [ ] **Step 3b: as políticas de falha entram em `StartEngineOptions`**

Pela ruling do scan pré-voo: `onHandlerError` e `retry` mudam a execução, não
estão em `EngineState` e o motor não as devolve em `getState()`. Quem as lembra
é o journal — mesmo papel que `mode`/`maxSteps`/`expressions` têm desde o chunk
1, só que resolvidas pelo ebb em vez de lidas de volta do motor.

Em `packages/runtime/src/commands.ts`:

```ts
export interface StartEngineOptions {
  mode: EngineMode;
  maxSteps: number;
  expressions: ExpressionMode;
  /**
   * As duas opções que o motor não guarda no estado nem devolve em
   * `getState()`. Sem elas no journal, uma instância re-hidratada volta com o
   * padrão `'fail'` e perde o incidente — e um replay reconstruiria uma
   * execução diferente da que aconteceu.
   */
  onHandlerError: 'fail' | 'incident';
  retry: { attempts: number };
}
```

Os valores resolvidos são os da ruling: `onHandlerError: 'incident'` e
`retry: { attempts: 0 }`, salvo o que o chamador pedir.

- [ ] **Step 4: `InstanceTerminatedError`**

Em `packages/runtime/src/errors.ts`:

```ts
/**
 * A instância já acabou.
 *
 * Existe para fechar o buraco que o chunk 1 deixou: sem isto, um `tick` numa
 * instância concluída acrescentava entrada no-op ao journal para sempre.
 * Determinístico, mas o journal passa a descrever coisa que não aconteceu.
 */
export class InstanceTerminatedError extends Error {
  constructor(
    readonly instanceId: string,
    readonly status: string,
  ) {
    super(`A instância ${instanceId} está ${status} e não aceita mais comandos.`);
    this.name = 'InstanceTerminatedError';
  }
}
```

- [ ] **Step 5: A guarda em `apply`**

Em `packages/runtime/src/runtime.ts`, dentro de `apply`, logo depois do
`hydrate`:

```ts
if (TERMINAL.has(instance.status)) {
  throw new InstanceTerminatedError(instance.id, instance.status);
}
```

E no topo do módulo:

```ts
/** Estados de onde não se sai: comando aqui só sujaria o journal. */
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'terminated', 'failed']);
```

`inspect` continua livre — ler instância terminada é o caso normal.

- [ ] **Step 6: Exportar**

`InstanceTerminatedError` em `packages/runtime/src/index.ts`.

- [ ] **Step 7: Rodar e ver passar**

```bash
npx vitest run packages/runtime
```

Esperado: PASS.

- [ ] **Step 8: Verify e commit**

```bash
npm run verify
git add packages/runtime
git commit -m "feat(runtime): add the job commands and refuse a finished instance

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

---

## Tarefa 7: o runtime projeta, ativa e conclui job

**Files:**

- Create: `packages/runtime/src/jobs.ts`
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/jobs.test.ts` (novo)

**Interfaces:**

- Consumes: `store.listJobs`, `store.lockJobs`, `CreateInstanceInput.jobs`,
  `AppendInput.jobs` (tarefa 5); `engine.tasks`, `engine.incidentList` do core.
- Produces:

```ts
export function projectJobs(engine: WorkflowEngine): JobProjection[];

// em EbbRuntime:
activateJobs(options: {
  type: string;
  worker: string;
  count?: number;   // padrão 1
  lease?: number;   // ms; padrão 60_000
}): Promise<JobRecord[]>;
completeJob(instanceId: string, tokenId: string, output?: Record<string, unknown>): Promise<CommandResult>;
failJob(instanceId: string, tokenId: string, error: { message: string; code?: string }): Promise<CommandResult>;
```

E `CommandResult` (logo, também `InstanceView`, que o estende) ganha um campo:

```ts
  /** Atividades paradas por falha, com tentativas e mensagem. */
  incidents: IncidentState[];
```

Isto é necessário, não enfeite: `ExecutionSnapshot` **não** carrega incidente —
os campos dele são `status`, `variables`, `tokens`, `completedNodes` e
`history`. A única fonte é `engine.incidentList()`, e o motor é descartado ao
fim de cada comando. Sem este campo, `ebb incidents` não teria de onde ler a
mensagem. Preencher com `engine.incidentList()` nos três lugares que hoje
montam o retorno: `start`, `apply` e `inspect`. `IncidentState` é exportado por
`@bpmn-flow/core` (`packages/core/src/index.ts:36`).

- [ ] **Step 1: Escrever os testes que falham**

`packages/runtime/test/jobs.test.ts`:

```ts
describe('jobs no runtime', () => {
  it('a instância que para num job já nasce com a linha de job', async () => {
    const { store, started } = await startOnJob();
    expect(await store.listJobs()).toMatchObject([
      { instanceId: started.instance.id, type: 'charge', state: 'pending', attempts: 0 },
    ]);
  });

  it('ativar trava sem journalar', async () => {
    const { runtime, store, started } = await startOnJob();

    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    expect(job).toMatchObject({ state: 'locked', worker: 'w1', variables: { pedido: 42 } });
    // Travar não é evento de negócio: para a instância, nada aconteceu.
    expect((await store.journal(started.instance.id)).length).toBe(1);
  });

  it('concluir journala e apaga a linha', async () => {
    const { runtime, store, started } = await startOnJob();
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    const result = await runtime.completeJob(job!.instanceId, job!.tokenId, { ok: true });

    expect(result.snapshot.status).toBe('completed');
    expect(await store.listJobs()).toHaveLength(0);
    expect((await store.journal(started.instance.id)).at(-1)).toMatchObject({
      type: 'completeJob',
      payload: { tokenId: job!.tokenId, output: { ok: true } },
    });
  });

  it('falhar com retry devolve o job com attempts maior', async () => {
    const { runtime, store } = await startOnJob({ retry: { attempts: 1 } });
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    await runtime.failJob(job!.instanceId, job!.tokenId, { message: 'gateway timeout' });

    expect(await store.listJobs()).toMatchObject([{ state: 'pending', attempts: 1 }]);
  });

  it('falhar sem retry deixa incidente e nenhum job', async () => {
    const { runtime, store } = await startOnJob();
    const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    await runtime.failJob(job!.instanceId, job!.tokenId, { message: 'gateway timeout' });

    expect(await store.listJobs()).toHaveLength(0);
    const view = await runtime.inspect(job!.instanceId);
    expect(view.tasks).toMatchObject([{ reason: 'incident' }]);
  });

  it('job abandonado não deixa rastro no journal', async () => {
    const { runtime, store, started } = await startOnJob();
    await runtime.activateJobs({ type: 'charge', worker: 'w1', lease: 1 });

    expect((await store.journal(started.instance.id)).length).toBe(1);
  });
});
```

O helper `startOnJob` publica a fixture de job (copiar `EXTERNAL_JOB` para
`packages/runtime/test/fixtures.ts`, que já existe com 12 linhas), abre store
temporário e dá `runtime.start('P', { variables: { pedido: 42 } })`.

`retry: { attempts: 1 }` chega por `StartOptions`, que ganha um campo (a ruling
do scan pré-voo e o passo 3b da tarefa 6 já fixaram o formato):

```ts
export interface StartOptions {
  version?: number;
  variables?: Record<string, unknown>;
  /** Políticas de falha do motor. O padrão é `incident` sem retry automático. */
  engine?: { onHandlerError?: 'fail' | 'incident'; retry?: { attempts: number } };
}
```

`start` resolve os padrões (`'incident'`, `{ attempts: 0 }`), constrói o motor
com eles, **e os grava no payload do `start`**. E `hydrate` os lê de volta do
journal e os re-passa ao `restore` — sem isso a instância volta com `'fail'` e
o incidente some. Em `hydrate`, antes do `restore`:

```ts
// As políticas de falha não estão no EngineState (o motor não as
// serializa), então quem as lembra é a primeira entrada do journal.
const [birth] = await this.store.journal(instanceId);
const engineOptions = birth?.payload.engine as StartEngineOptions | undefined;
```

e no `restore`:

```ts
      onHandlerError: engineOptions?.onHandlerError ?? 'incident',
      retry: engineOptions?.retry ?? { attempts: 0 },
```

`birth.payload.engine` vem de `JSON.parse`, então não pode virar tipo por `as`
sem validação: escrever um guard pequeno no mesmo arquivo (`isRecord` +
checagem dos dois campos) e cair no padrão quando não casar, em vez do `as`.

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run packages/runtime/test/jobs.test.ts
```

Esperado: FAIL — `runtime.activateJobs is not a function`.

- [ ] **Step 3: A projeção**

`packages/runtime/src/jobs.ts`:

```ts
import type { WorkflowEngine } from '@bpmn-flow/core';
import type { JobProjection } from '@ebb/store';

/**
 * Os jobs que o motor tem parados, como linhas.
 *
 * `attempts` vem de `incidentList()` porque a contagem autoritativa é a do
 * motor — é ela que o `retry.attempts` compara. Duplicá-la no store como
 * contador próprio criaria duas verdades que divergem no primeiro retry.
 */
export function projectJobs(engine: WorkflowEngine): JobProjection[] {
  const attempts = new Map(engine.incidentList().map((i) => [i.tokenId, i.attempts]));
  return engine.tasks({ reason: 'job' }).map((task) => ({
    tokenId: task.tokenId,
    nodeId: task.nodeId,
    type: task.job?.type ?? '',
    variables: task.variables,
    attempts: attempts.get(task.tokenId) ?? 0,
  }));
}
```

`task.job` é opcional no tipo do core, mas um token parado por `'job'` sempre o
tem. O `?? ''` existe só para o `tsc`; se aparecer linha com tipo vazio em
teste, é bug de projeção, não dado válido.

- [ ] **Step 4: Ligar a projeção às duas gravações**

Em `runtime.ts`, `createInstance` e `append` passam a receber
`jobs: projectJobs(engine)` — dentro da mesma transação, porque é campo da
entrada, não chamada separada.

- [ ] **Step 5: Os três métodos**

```ts
  /**
   * Trava trabalho pendente para um worker e o devolve com as variáveis.
   *
   * Não aplica comando nenhum: travar não é evento de negócio. O que entra no
   * journal é o desfecho — `completeJob` ou `failJob`. Um job travado e nunca
   * concluído não deixa rastro na instância, que é o certo: para ela, nada
   * aconteceu, e o lease devolve o job quando vencer.
   */
  activateJobs(options: {
    type: string;
    worker: string;
    count?: number;
    lease?: number;
  }): Promise<JobRecord[]> {
    const now = this.now().getTime();
    return this.store.lockJobs({
      type: options.type,
      worker: options.worker,
      count: options.count ?? 1,
      until: now + (options.lease ?? 60_000),
      now,
    });
  }

  /** O worker terminou: conclui a atividade e segue o fluxo. */
  completeJob(
    instanceId: string,
    tokenId: string,
    output?: Record<string, unknown>,
  ): Promise<CommandResult> {
    return this.apply(instanceId, { type: 'completeJob', tokenId, ...(output ? { output } : {}) });
  }

  /** O worker não conseguiu: retry, incidente ou boundary de erro, conforme o motor. */
  failJob(
    instanceId: string,
    tokenId: string,
    error: { message: string; code?: string },
  ): Promise<CommandResult> {
    return this.apply(instanceId, { type: 'failJob', tokenId, error });
  }
```

- [ ] **Step 6: Exportar**

`projectJobs` e os tipos novos em `packages/runtime/src/index.ts`.

- [ ] **Step 7: Rodar e ver passar**

```bash
npx vitest run packages/runtime
```

Esperado: PASS.

- [ ] **Step 8: Verify e commit**

```bash
npm run verify
git add packages/runtime
git commit -m "feat(runtime): hand jobs to workers under a lease

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

---

## Tarefa 8: `ebb jobs`, `ebb incidents`, `ebb retry`, `ebb resolve`

**Files:**

- Create: `packages/cli/src/jobs.ts`
- Modify: `packages/cli/src/bin.ts` (`USAGE` e o `switch`)
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/jobs.test.ts` (novo)

**Interfaces:**

- Consumes: `store.listJobs`, `runtime.inspect`, `runtime.apply`, o helper
  `withInstance` de `instances.ts` (exportá-lo de lá; hoje é privado) e
  `CHECK`/`CROSS`/`table` de `output.ts`.
- Produces: `listJobs`, `listIncidents`, `retryTask`, `resolveIncident`, todos
  devolvendo `CommandResult { output: string; exitCode: number }`, como o resto
  do CLI.

`withInstance` deixa de ser privado e vira `export async function
withInstance(...)` em `instances.ts` — é a dívida de "resolução de prefixo no
CLI" do handoff do chunk 1 ganhando o **segundo consumidor**. Mover para o
`EbbRuntime` continua sendo trabalho do chunk 4, quando o HTTP for o terceiro;
por ora, exportar e reusar, sem duplicar a regra de ambiguidade.

- [ ] **Step 1: Escrever os testes que falham**

`packages/cli/test/jobs.test.ts`, no padrão de
`packages/cli/test/instances.test.ts` (store temporário, deploy da fixture de
job, asserção sobre `output` e `exitCode`):

```ts
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

it('lista incidente com tentativas e mensagem', async () => {
  const { store, runtime } = await deployed();
  const started = await runtime.start('P');
  const [job] = await runtime.activateJobs({ type: 'charge', worker: 'w' });
  await runtime.failJob(job!.instanceId, job!.tokenId, { message: 'gateway timeout' });

  const result = await listIncidents(store, runtime);

  expect(result.output).toContain('gateway timeout');
  expect(result.output).toContain(started.instance.id.slice(0, 8));
});

it('retry devolve a atividade ao worker', async () => {
  const { store, runtime } = await incidented();
  const result = await retryTask(store, runtime, PREFIX, TOKEN);

  expect(result.exitCode).toBe(0);
  expect(await store.listJobs()).toHaveLength(1);
});

it('resolve encerra a atividade com a variável dada', async () => {
  const { store, runtime } = await incidented();
  const result = await resolveIncident(store, runtime, PREFIX, TOKEN, { authorized: true });

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('completed');
});

it('explica quando o token não tem incidente', async () => {
  const { store, runtime } = await incidented();
  const result = await retryTask(store, runtime, PREFIX, 'nope');

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('nope');
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run packages/cli/test/jobs.test.ts
```

Esperado: FAIL — módulo `../src/jobs.js` não existe.

- [ ] **Step 3: Implementar `packages/cli/src/jobs.ts`**

```ts
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
```

`withInstance` já embrulha o `catch`: o erro do motor para um token sem
incidente (`No incident for token: nope`) vira `✗ ...` com `exitCode` 1, que é
o que o sexto teste espera.

- [ ] **Step 4: Ligar no `bin.ts`**

Quatro `case` no `switch`, no formato dos que já existem (validar argumento
faltando com `usageError`), e as quatro linhas correspondentes em `USAGE`, na
seção nova "Trabalho:".

Mais o flag que a ruling do scan pré-voo criou, no `case 'start'` que já existe:
`--retries N` (inteiro ≥ 0, validado como `--version` já é) vira
`{ engine: { retry: { attempts: N } } }` em `StartCliOptions` e segue para
`runtime.start`. Sem o flag, o padrão é zero — nenhum número inventado. Uma
linha em `USAGE`:

```
  --retries N         tentativas automáticas antes de virar incidente (padrão: 0)
```

E um teste em `packages/cli/test/jobs.test.ts`:

```ts
it('start --retries journala a política pedida', async () => {
  const { store, runtime } = await deployed();
  const started = await startInstance(runtime, 'P', { engine: { retry: { attempts: 2 } } });

  const [birth] = await store.journal(idFrom(started.output));
  expect(birth!.payload.engine).toMatchObject({
    retry: { attempts: 2 },
    onHandlerError: 'incident',
  });
});
```

- [ ] **Step 5: Rodar e ver passar**

```bash
npx vitest run packages/cli
```

Esperado: PASS.

- [ ] **Step 6: Verify e commit**

```bash
npm run verify
git add packages/cli
git commit -m "feat(cli): show and operate pending work from the terminal

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

---

## Tarefa 9: `ebb worker` — o processo de fora

**Files:**

- Create: `packages/cli/src/worker.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: `packages/cli/test/worker.test.ts` (novo)

**Interfaces:**

- Consumes: `runtime.activateJobs`, `runtime.completeJob`, `runtime.failJob`.
- Produces:

```ts
export interface WorkerOptions {
  type: string;
  command: string[]; // o que roda, já separado pelo `--`
  once?: boolean; // uma rodada e sai; o padrão é laço
  lease?: number; // ms, padrão 60_000
  interval?: number; // ms entre sondagens, padrão 1_000
  count?: number; // jobs por rodada, padrão 1
}
export async function runWorker(
  runtime: EbbRuntime,
  options: WorkerOptions,
): Promise<CommandResult>;
```

**O contrato com o processo filho**, que é o que o README vai documentar:

- stdin recebe `{"instanceId","tokenId","nodeId","type","variables"}` em JSON.
- Saída 0: o stdout, se for um objeto JSON, vira o output do job; stdout vazio
  conclui sem variável nova; stdout que não parseia é erro de contrato e vira
  `failJob` com essa mensagem.
- Saída ≠ 0: `failJob`. Se o stdout parsear como `{"error":{"code","message"}}`,
  é erro de **negócio** e vai com código (boundary de erro); senão é falha
  técnica, com o stderr como mensagem (ou `"o worker saiu com código N"` quando
  o stderr vier vazio).

- [ ] **Step 1: Escrever o teste que falha**

`packages/cli/test/worker.test.ts` — os scripts filhos são arquivos escritos num
diretório temporário, com `chmod 0o755`, para o teste provar processo de
verdade:

```ts
const OK = '#!/bin/sh\nread input\necho \'{"authorized":true}\'\n';
const BOOM = '#!/bin/sh\necho "gateway timeout" >&2\nexit 1\n';

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
  const script = await writeScript('echo.sh', '#!/bin/sh\ncat > "$OUT"\necho "{}"\n');

  await runWorker(runtime, { type: 'charge', command: [script], once: true });

  expect(JSON.parse(await readFile(process.env.OUT!, 'utf8'))).toMatchObject({
    type: 'charge',
    variables: { pedido: 42 },
  });
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

it('uma rodada sem job não faz nada e sai', async () => {
  const { runtime } = await deployed();
  const script = await writeScript('ok.sh', OK);

  const result = await runWorker(runtime, { type: 'charge', command: [script], once: true });

  expect(result.output).toContain('Nenhum job');
});
```

`writeScript` grava em `mkdtemp` e devolve o caminho absoluto; `process.env.OUT`
aponta para um arquivo do mesmo diretório.

- [ ] **Step 2: Rodar e ver falhar**

```bash
npx vitest run packages/cli/test/worker.test.ts
```

Esperado: FAIL — módulo `../src/worker.js` não existe.

- [ ] **Step 3: Implementar `worker.ts`**

```ts
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EbbRuntime } from '@ebb/runtime';
import type { JobRecord } from '@ebb/store';
import type { CommandResult } from './commands.js';
import { CHECK, CROSS } from './output.js';

export interface WorkerOptions {
  type: string;
  command: string[];
  once?: boolean;
  lease?: number;
  interval?: number;
  count?: number;
}

interface Outcome {
  output?: Record<string, unknown>;
  error?: { message: string; code?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * O que o processo filho disse, traduzido para desfecho de job.
 *
 * Saída zero com stdout ilegível é falha, não sucesso silencioso: um worker
 * que imprime lixo não sabe o que fez, e concluir a atividade aí é perder o
 * único momento em que dá para perceber.
 */
function readOutcome(code: number, stdout: string, stderr: string): Outcome {
  const text = stdout.trim();
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    return {
      error: {
        message: `o worker respondeu algo que não é JSON: ${text.slice(0, 200)}`,
      },
    };
  }
  if (code === 0) {
    if (!isRecord(parsed))
      return { error: { message: 'o worker respondeu um JSON que não é objeto.' } };
    return { output: parsed };
  }
  const business = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  const businessCode = typeof business?.code === 'string' ? business.code : undefined;
  const message =
    (typeof business?.message === 'string' ? business.message : undefined) ??
    (stderr.trim() || `o worker saiu com código ${code}`);
  return { error: { message, ...(businessCode ? { code: businessCode } : {}) } };
}

/** Roda o comando para um job, com o job no stdin. */
function runOnce(command: string[], job: JobRecord): Promise<Outcome> {
  const [bin, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(bin!, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ error: { message: error.message } }));
    child.on('close', (code) => resolve(readOutcome(code ?? 0, stdout, stderr)));
    child.stdin.end(
      JSON.stringify({
        instanceId: job.instanceId,
        tokenId: job.tokenId,
        nodeId: job.nodeId,
        type: job.type,
        variables: job.variables,
      }),
    );
  });
}

/**
 * `ebb worker <tipo> -- <comando>`.
 *
 * Um job por vez, em série: paralelismo é decisão de operação, e não há número
 * medido para justificar um padrão. Sem timeout de processo filho de propósito
 * — o lease já devolve o job de um worker travado, e um segundo mecanismo
 * precisaria de um número que ninguém mediu.
 */
export async function runWorker(
  runtime: EbbRuntime,
  options: WorkerOptions,
): Promise<CommandResult> {
  const worker = `${options.type}-${randomUUID().slice(0, 8)}`;
  const lines: string[] = [];
  let stop = false;
  process.once('SIGINT', () => (stop = true));

  do {
    const jobs = await runtime.activateJobs({
      type: options.type,
      worker,
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.lease === undefined ? {} : { lease: options.lease }),
    });
    for (const job of jobs) {
      const outcome = await runOnce(options.command, job);
      if (outcome.error) {
        await runtime.failJob(job.instanceId, job.tokenId, outcome.error);
        lines.push(`${CROSS} ${job.tokenId} — ${outcome.error.message}`);
      } else {
        await runtime.completeJob(job.instanceId, job.tokenId, outcome.output);
        lines.push(`${CHECK} ${job.tokenId} — ${job.nodeId}`);
      }
    }
    if (options.once) break;
    if (jobs.length === 0) await sleep(options.interval ?? 1_000);
  } while (!stop);

  return {
    output: lines.length > 0 ? lines.join('\n') : 'Nenhum job pendente.',
    exitCode: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Não** inventar timeout de processo filho neste chunk: o lease já cobre o
worker que trava, e o segundo mecanismo precisaria de número que ninguém mediu.

- [ ] **Step 4: Ligar no `bin.ts`**

```
  ebb worker <tipo> -- <comando>       executa os jobs de um tipo
```

O `--` separa; tudo depois dele é o comando. `--once`, `--lease <ms>`,
`--interval <ms>` e `--count <n>` como opções, validadas como `--version` já é.

- [ ] **Step 5: Rodar e ver passar**

```bash
npx vitest run packages/cli
```

Esperado: PASS.

- [ ] **Step 6: Verify e commit**

```bash
npm run verify
git add packages/cli
git commit -m "feat(cli): run jobs from a separate process

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
```

---

## Tarefa 10: fechar o chunk — prova ponta a ponta, README e handoff

**Files:**

- Modify: `README.md`
- Modify: `handoff.md` (reescrito para o chunk 3)
- Modify: `docs/superpowers/specs/2026-09-20-ebb-chunk-2-workers-jobs.md` (só se
  o código tiver divergido dele)

**Interfaces:**

- Consumes: tudo.
- Produces: o critério de pronto do chunk, verificado à mão e relatado com a
  saída real dos comandos.

- [ ] **Step 1: A prova, em dois terminais**

Com um `.bpmn` de verdade em `bpmn-files/` (ou um escrito para isto), rodar e
**colar a saída no relatório** — nunca descrever sem rodar:

```bash
node packages/cli/dist/bin.js deploy pedido.bpmn
node packages/cli/dist/bin.js start pedido --var pedido=42
node packages/cli/dist/bin.js jobs
# noutro terminal:
node packages/cli/dist/bin.js worker charge -- ./charge.sh
node packages/cli/dist/bin.js show <id>
```

E o caminho do erro: um `charge.sh` que sai com 1, `ebb incidents`, `ebb retry`,
`ebb resolve`.

- [ ] **Step 2: README**

Atualizar a tabela de pacotes e a lista de comandos com `jobs`, `worker`,
`incidents`, `retry`, `resolve`, e documentar o contrato do processo filho
(stdin, stdout, código de saída, erro de negócio com código). README é a
vitrine: mudou funcionalidade, muda o README.

- [ ] **Step 3: Handoff do chunk 3**

Reescrever `handoff.md` inteiro, no formato do atual: o que o ebb é, o que
existe, as regras que o chunk 2 fixou, o que o chunk 3 (time-travel) pede, a
dívida conhecida com endereço, e como trabalhar no repo. Registrar
explicitamente:

- `effects` continua não existindo, e por quê (nenhum handler local até aqui).
- A dívida do `withInstance` agora tem dois consumidores; o terceiro (HTTP, do
  chunk 4) é o gatilho para mover a regra para o `EbbRuntime`.
- Se a tarefa 7 topou com `retry`/`onHandlerError` fora do `EngineState`:
  registrar como o **primeiro item** do chunk 3, porque é replay quebrado.

- [ ] **Step 4: Verify, commit e PR**

```bash
npm run verify
git add README.md handoff.md docs
git commit -m "docs: hand off to chunk 3 (time-travel)

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb"
git push -u origin feat/workers-and-jobs
gh pr create --fill
```

`push` e `gh pr create` são ações externas: **confirmar com o usuário antes**.
