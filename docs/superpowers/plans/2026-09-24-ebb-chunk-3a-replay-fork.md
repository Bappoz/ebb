# ebb chunk 3a — replay e bifurcação: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebobinar e bifurcar uma instância pelo terminal, com o porquê de cada gateway, reconstruindo o estado só a partir do journal.

**Architecture:** Uma função pura `replayJournal(xml, journal, { upTo })` em `@ebb/runtime` reconstrói um motor aplicando os comandos do journal em sequência, com relógio mutável e um `decide` que só registra a razão do gateway. `EbbRuntime.replay`/`fork` e o fallback do `hydrate` usam essa função. O store ganha a migração 4 (proveniência) e `forkInstance`. O CLI ganha `show --at` e `fork --at`.

**Tech Stack:** TypeScript 5.9, Node >= 24 (`node:sqlite`), Vitest 4, `@bpmn-flow/core` por dependência de caminho (`../bpmn-flow`).

**Spec:** `docs/superpowers/specs/2026-09-24-ebb-chunk-3a-replay-fork.md`

## Global Constraints

- Node >= 24; nenhuma dependência nova em nenhum pacote.
- Linha do SQLite não vira tipo por `as`: passa por `packages/store/src/rows.ts`. JSON vindo do banco também não (`as EngineState` proibido).
- Sem `any` novo; `!` só com invariante comentada.
- Docstring e identificador em inglês **no bpmn-flow**; no ebb, docstring e comentário em PT-BR (padrão do código vizinho), identificador em inglês.
- Comentário explica o **porquê**.
- Conventional Commits em inglês; um commit por tarefa (ou por unidade lógica dentro dela); todo commit termina com a linha `Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb`.
- `npm run verify` verde em cada commit (build → format:check → lint → typecheck → coverage; limiares 90/85/90/90).
- Defeito em `@bpmn-flow/core` se corrige lá, com teste lá, por PR.
- Journal é imutável: nada neste plano escreve em `instance_journal` de uma instância existente, exceto `append`.
- Antes de `npm`/`npx` no Bash: `unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH`.

## Review Focus

1. **`--at` num journal de 1 entrada, `--at 0`, `--at 1.5`, `--at -1`**: o esperado é erro de uso ou `ReplayRangeError` com o intervalo válido, nunca um snapshot vazio ou o último passo em silêncio. Testado na Tarefa 6 (`ReplayRangeError`), na Tarefa 9 (`show --at 3`) e na Tarefa 10 (`bin.test.ts`, erro de uso).
2. **Fork de fork**: a bifurcação de uma bifurcação copia o journal da intermediária, que já é completo, e aponta `forkedFrom` para a intermediária, não para a raiz. Testado na Tarefa 8.
3. **Variáveis do gateway mutadas depois**: o `GatewayTrace.variables` do passo 2 não pode mudar quando o passo 3 reescreve a variável. Isso exige `structuredClone`. Testado na Tarefa 6.
4. **Snapshot corrompido (JSON válido, formato errado)**: `inspect` reconstrói pelo journal em vez de estourar dentro do `restore`. Testado na Tarefa 7.
5. **Fork com job pendente no corte**: o job aparece em `jobs` da instância nova com `state: 'pending'`, mesmo que na original ele esteja `locked` por um worker. Testado na Tarefa 8.

---

## Mapa de arquivos

| Arquivo                                           | Responsabilidade                                                                   |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/*/package.json`                         | `typecheck` passa a incluir os testes (`tsconfig.lint.json`)                       |
| `packages/store/src/sqlite.ts`                    | `db` privado + `busyTimeoutMs()`; `reconcileJobs` sem toque inútil; `forkInstance` |
| `packages/store/src/rows.ts`                      | ganha `optionalInteger` (hoje privado em `jobs.ts`)                                |
| `packages/store/src/migrations.ts`                | migração 4                                                                         |
| `packages/store/src/types.ts`                     | `InstanceRecord.forkedFrom/forkedAt`, `ForkInstanceInput`, `Store.forkInstance`    |
| `packages/store/src/instances.ts`                 | `toInstance` lê a proveniência                                                     |
| `packages/store/test/contention.test.ts` (novo)   | dois processos disputando `lockJobs` com barreira                                  |
| `../bpmn-flow/packages/core/src/engine/engine.ts` | `failJob` com `BpmnError` sem `activity.end` órfão                                 |
| `packages/runtime/src/commands.ts`                | `commandFromEntry`, `JournalShapeError`, `parseStartEngineOptions` (movido)        |
| `packages/runtime/src/state.ts` (novo)            | `parseEngineState`: guarda do snapshot gravado                                     |
| `packages/runtime/src/replay.ts` (novo)           | `replayJournal`, `ReplayStep`, `GatewayTrace`, `ReplayRangeError`                  |
| `packages/runtime/src/runtime.ts`                 | `replay`, `fork`, `hydrate` com fallback                                           |
| `packages/runtime/src/errors.ts`                  | sai `EngineStateMismatchError`                                                     |
| `packages/runtime/test/fixtures.ts`               | `GATEWAY`, `TIMER`                                                                 |
| `packages/runtime/test/replay.test.ts` (novo)     | replay puro + equivalência                                                         |
| `packages/runtime/test/fork.test.ts` (novo)       | `replay`, `fork`, fallback                                                         |
| `packages/cli/src/worker.ts`                      | `decodeUtf8` exportada                                                             |
| `packages/cli/src/timeline.ts` (novo)             | `showStep`, `forkAt` e a formatação do gateway                                     |
| `packages/cli/src/instances.ts`                   | proveniência em `ps`/`show`                                                        |
| `packages/cli/src/bin.ts`                         | `show --at`, `fork --at`, USAGE                                                    |
| `README.md`, `handoff.md`                         | vitrine e roteiro atualizados                                                      |

---

### Task 1: Typecheck dos testes

**Files:**

- Modify: `packages/store/package.json`, `packages/runtime/package.json`, `packages/cli/package.json` (script `typecheck`)

**Interfaces:**

- Consumes: `packages/*/tsconfig.lint.json` (já existe; inclui `src`, `test`, `*.ts`, `noEmit`)
- Produces: `npm run typecheck` falha quando um teste não compila

- [ ] **Step 1: Provar que hoje um erro de tipo em teste passa despercebido**

Acrescente temporariamente ao fim de `packages/runtime/test/fixtures.ts`:

```ts
export const PROBE: number = 'not a number';
```

Run: `npm run typecheck`
Expected: PASS (é o buraco).

- [ ] **Step 2: Incluir os testes no typecheck**

Nos três `package.json`, troque o script:

```json
"typecheck": "tsc --noEmit && tsc -p tsconfig.lint.json"
```

- [ ] **Step 3: Confirmar que o buraco fechou**

Run: `npm run typecheck`
Expected: FAIL com `TS2322` em `packages/runtime/test/fixtures.ts`.

- [ ] **Step 4: Remover a sonda e rodar o gate**

Apague a linha `PROBE`. Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/*/package.json
git commit -m "build: typecheck test files alongside sources"
```

---

### Task 2: Store sem seam de teste e sem escrita inútil

**Files:**

- Modify: `packages/store/src/sqlite.ts:100-106` (campo `db`), `packages/store/src/sqlite.ts:388-419` (`reconcileJobs`)
- Modify: `packages/store/test/jobs.test.ts:11-17` (remove `InspectableStore`), `:230-245` (usa o método público)
- Test: `packages/store/test/jobs.test.ts`

**Interfaces:**

- Produces: `SqliteStore.busyTimeoutMs(): number` (método público da classe, **fora** da interface `Store`)

- [ ] **Step 1: Teste que falha — `updated_at` só muda quando o job muda**

Em `packages/store/test/jobs.test.ts`, dentro do `describe` que já contém `'a reconciliação atualiza node_id e type de um job que sobrevive'`, acrescente:

```ts
it('a reconciliação não toca updated_at de um job que não mudou', async () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const timed = new SqliteStore({ path: join(dir, 'timed.db'), now: () => new Date(clock) });
  await timed.deploy({ processKey: 'Pedido', xml: XML, checksum: checksumOf(XML) });
  await timed.createInstance({
    id: 'i1',
    processKey: 'Pedido',
    version: 1,
    status: 'waiting',
    command: CMD,
    state: STATE,
    jobs: [projection('t1')],
  });
  const [before] = await timed.listJobs();

  clock += 60_000;
  await timed.append({
    instanceId: 'i1',
    status: 'waiting',
    command: CMD,
    state: STATE,
    jobs: [projection('t1')],
  });
  const [unchanged] = await timed.listJobs();

  clock += 60_000;
  await timed.append({
    instanceId: 'i1',
    status: 'waiting',
    command: CMD,
    state: STATE,
    jobs: [{ ...projection('t1'), attempts: 1 }],
  });
  const [changed] = await timed.listJobs();
  timed.close();

  expect(unchanged?.updatedAt).toBe(before?.updatedAt);
  expect(changed?.updatedAt).toBe('2026-01-01T00:02:00.000Z');
});
```

Confira o nome e a forma do helper `projection` e das constantes `CMD`/`STATE`/`XML` no topo do arquivo (linhas 19-40) e ajuste se divergirem. Importe `checksumOf` de `'../src/checksum.js'` se ainda não estiver importado.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run packages/store/test/jobs.test.ts -t "não toca updated_at"`
Expected: FAIL: `unchanged.updatedAt` é `…00:01:00.000Z`.

- [ ] **Step 3: Implementar — upsert condicional**

Em `reconcileJobs` (`sqlite.ts`), troque o `ON CONFLICT … DO UPDATE SET …` por:

```ts
// O WHERE do upsert faz um job que sobreviveu intacto não ser reescrito:
// sem ele, todo comando de qualquer instância tocava `updated_at` de todos
// os seus jobs, e a coluna deixava de dizer quando o job mudou.
const upsert = this.db.prepare(
  `INSERT INTO jobs (instance_id, token_id, node_id, type, variables, state,
                         attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
       ON CONFLICT (instance_id, token_id) DO UPDATE SET
         node_id = excluded.node_id, type = excluded.type,
         variables = excluded.variables, attempts = excluded.attempts, updated_at = excluded.updated_at
       WHERE jobs.node_id IS NOT excluded.node_id OR jobs.type IS NOT excluded.type
          OR jobs.variables IS NOT excluded.variables OR jobs.attempts IS NOT excluded.attempts`,
);
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run packages/store/test/jobs.test.ts`
Expected: PASS (inclusive `'a reconciliação atualiza node_id e type…'`).

- [ ] **Step 5: `db` privado com acessor dedicado**

Em `sqlite.ts`, troque o bloco do campo:

```ts
  private readonly db: DatabaseSync;
```

E acrescente, depois de `close()`:

```ts
  /**
   * O `busy_timeout` efetivo da conexão, em ms. Público para o teste conferir
   * que a opção chegou ao SQLite, sem abrir a conexão inteira a subclasses.
   */
  busyTimeoutMs(): number {
    const row = this.db.prepare('PRAGMA busy_timeout').get();
    if (!row) throw new Error('PRAGMA busy_timeout não devolveu linha.');
    return integer(row, 'timeout');
  }
```

Em `jobs.test.ts`, apague a classe `InspectableStore` (linhas 11-17) e troque os dois `new InspectableStore(` do `describe('busy timeout')` por `new SqliteStore(`. Remova o import de `integer` se ficar sem uso.

`packages/store/test/instances.test.ts:80` estende `SqliteStore` sobrescrevendo `writeEngineState` (protegido), não `db`. Confirme com `rg -n "this\.db" packages/store/test` que nenhum teste lê `db` diretamente. Deve devolver vazio.

- [ ] **Step 6: Gate e commit**

Run: `npm run verify` → PASS.

```bash
git add packages/store
git commit -m "fix(store): leave unchanged jobs untouched and close the db seam"
```

---

### Task 3: Contenção real do lease entre processos

**Files:**

- Create: `packages/store/test/contention.test.ts`

**Interfaces:**

- Consumes: `packages/store/dist/index.js` (o `npm test` builda antes; o filho importa o build)

- [ ] **Step 1: Escrever o teste**

```ts
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checksumOf } from '../src/checksum.js';
import { SqliteStore } from '../src/sqlite.js';

const XML = '<definitions><process id="Pedido" /></definitions>';
const JOBS = 40;
const STORE_URL = new URL('../dist/index.js', import.meta.url).href;

// O filho abre o próprio SqliteStore, avisa que está pronto e só disputa
// depois que a barreira existe: sem isso, um processo terminaria antes de o
// outro abrir o banco, e o teste passaria sem contenção nenhuma.
const CHILD = `
const [storeUrl, path, barrier, worker] = process.argv.slice(1);
const { SqliteStore } = await import(storeUrl);
const { existsSync } = await import('node:fs');
const store = new SqliteStore({ path });
process.stdout.write('ready\\n');
while (!existsSync(barrier)) await new Promise((r) => setTimeout(r, 2));
const got = [];
for (;;) {
  const jobs = await store.lockJobs({ type: 'charge', worker, count: 1, until: 9e12, now: 1000 });
  if (jobs.length === 0) break;
  got.push(jobs[0].tokenId);
}
store.close();
process.stdout.write(JSON.stringify(got) + '\\n');
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-contention-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Child {
  ready: Promise<void>;
  done: Promise<string[]>;
}

function contender(path: string, barrier: string, worker: string): Child {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', CHILD, STORE_URL, path, barrier, worker],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (signalReady = resolve));
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    if (out.startsWith('ready\n')) signalReady();
  });
  const done = new Promise<string[]>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${worker} saiu com ${code}`));
      const last = out.trim().split('\n').at(-1) ?? '[]';
      const parsed: unknown = JSON.parse(last);
      if (!Array.isArray(parsed)) return reject(new Error(`${worker} não devolveu lista`));
      resolve(parsed.map(String));
    });
  });
  return { ready, done };
}

it('dois processos nunca recebem o mesmo job', async () => {
  const path = join(dir, 'ebb.db');
  const barrier = join(dir, 'go');
  const seed = new SqliteStore({ path });
  await seed.deploy({ processKey: 'Pedido', xml: XML, checksum: checksumOf(XML) });
  const tokens = Array.from({ length: JOBS }, (_, i) => `t${String(i).padStart(2, '0')}`);
  await seed.createInstance({
    id: 'i1',
    processKey: 'Pedido',
    version: 1,
    status: 'waiting',
    command: { type: 'start', payload: {}, at: 1 },
    state: { engineVersion: 10, json: '{}' },
    jobs: tokens.map((tokenId) => ({
      tokenId,
      nodeId: 'Charge',
      type: 'charge',
      variables: {},
      attempts: 0,
    })),
  });
  seed.close();

  const a = contender(path, barrier, 'w1');
  const b = contender(path, barrier, 'w2');
  await Promise.all([a.ready, b.ready]);
  await writeFile(barrier, '');
  const [gotA, gotB] = await Promise.all([a.done, b.done]);

  expect(gotA.filter((token) => gotB.includes(token))).toEqual([]);
  expect([...gotA, ...gotB].sort()).toEqual(tokens);
}, 30_000);
```

- [ ] **Step 2: Rodar**

Run: `npm run build -w @ebb/store && npx vitest run packages/store/test/contention.test.ts`
Expected: PASS. O teste prova ausência de entrega dupla. Ele passar de primeira é o esperado: o código já está certo, e o que faltava era a prova.

- [ ] **Step 3: Provar que o teste pega o defeito**

Temporariamente, em `lockJobs` (`sqlite.ts`), troque o último argumento de `transaction(…, true)` para `false` (transação `DEFERRED` em vez de `IMMEDIATE`) e rode de novo. Expected: FAIL (token duplicado ou `SQLITE_BUSY`). Se passar mesmo assim, aumente `JOBS` para 200 e repita. Desfaça a mudança.

Confira em `packages/store/src/tx.ts` que o terceiro parâmetro é mesmo o `IMMEDIATE`. Se a assinatura for outra, a sabotagem é trocar `BEGIN IMMEDIATE` por `BEGIN` dentro de `tx.ts`.

- [ ] **Step 4: Gate e commit**

Run: `npm run verify` → PASS.

```bash
git add packages/store/test/contention.test.ts
git commit -m "test(store): prove lease exclusion with two real processes"
```

---

### Task 4: Decode UTF-8 do worker com teste

**Files:**

- Modify: `packages/cli/src/worker.ts:90-92`
- Test: `packages/cli/test/worker.test.ts`

**Interfaces:**

- Produces: `export function decodeUtf8(chunks: Buffer[]): string` em `worker.ts`

- [ ] **Step 1: Teste que falha**

No fim de `packages/cli/test/worker.test.ts`:

```ts
describe('decodeUtf8', () => {
  it('junta os pedaços antes de decodificar um caractere partido ao meio', () => {
    const bytes = Buffer.from('{"nome":"ação ✓"}', 'utf8');
    // O "ç" são dois bytes; cortar entre eles é o que um pipe faz quando quer.
    const cut = bytes.indexOf(0xc3) + 1;
    const chunks = [bytes.subarray(0, cut), bytes.subarray(cut)];

    expect(chunks.map((chunk) => chunk.toString('utf8')).join('')).not.toBe('{"nome":"ação ✓"}');
    expect(decodeUtf8(chunks)).toBe('{"nome":"ação ✓"}');
  });
});
```

E acrescente `decodeUtf8` ao import de `'../src/worker.js'`.

- [ ] **Step 2: Ver falhar**

Run: `npx vitest run packages/cli/test/worker.test.ts -t decodeUtf8`
Expected: FAIL: `decodeUtf8` não é exportado.

- [ ] **Step 3: Implementar**

Em `worker.ts`, acima de `runOnce`:

```ts
/**
 * Decodifica a saída de um filho. Juntar os bytes antes de decodificar é o
 * ponto: um pipe corta onde quer, inclusive no meio de um caractere
 * multibyte, e decodificar pedaço a pedaço viraria `�`.
 */
export function decodeUtf8(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}
```

E em `runOnce` troque as duas linhas por:

```ts
const stdout = decodeUtf8(stdoutChunks);
const stderr = decodeUtf8(stderrChunks);
```

- [ ] **Step 4: Ver passar, gate e commit**

Run: `npm run verify` → PASS.

```bash
git add packages/cli
git commit -m "test(cli): pin utf-8 decoding of split worker output"
```

---

### Task 5: `activity.end` órfão no `@bpmn-flow/core` (PR no bpmn-flow)

Trabalho **no repo `../bpmn-flow`**, com branch e PR próprios. O ebb não depende desta correção para nada deste plano, então ela não bloqueia as tarefas seguintes.

**Files:**

- Modify: `../bpmn-flow/packages/core/src/engine/engine.ts` (método `failJob`, ramo `BpmnError`)
- Test: `../bpmn-flow/packages/core/test/jobs.test.ts` (`describe('worker reporting a failure')`)
- Create: `../bpmn-flow/.changeset/quiet-jobs-end.md`

- [ ] **Step 1: Branch**

```bash
cd ../bpmn-flow && git checkout master && git pull --ff-only && git checkout -b fix/job-error-activity-end
```

- [ ] **Step 2: Teste que falha**

Em `packages/core/test/jobs.test.ts`, dentro de `describe('worker reporting a failure')`:

```ts
it('does not end an activity it never reported as started', async () => {
  const eng = new WorkflowEngine(await process(JOB_WITH_BOUNDARY));
  const events: string[] = [];
  eng.on('activity.start', ({ nodeId }) => events.push(`start:${nodeId}`));
  eng.on('activity.end', ({ nodeId }) => events.push(`end:${nodeId}`));
  await eng.start();
  const [task] = eng.tasks({ reason: 'job' });

  await eng.failJob(task!.tokenId, new BpmnError('DECLINED'));

  // A parked job never emits activity.start, so an activity.end here would
  // tell a viewer the task completed when it was in fact interrupted.
  expect(events.filter((event) => event.endsWith(':Charge'))).toEqual([]);
});
```

Run: `npx vitest run packages/core/test/jobs.test.ts -t "never reported"`
Expected: FAIL: `['end:Charge']`.

- [ ] **Step 3: Corrigir**

Em `failJob`, no ramo `if (error instanceof BpmnError)`, remova a linha `this.emitter.emit('activity.end', …)` e deixe no lugar:

```ts
// No activity.end: a job parks without activity.start, and the error
// interrupts the activity rather than completing it.
```

Não mexa no `activity.end` do caminho de handler em processo (`engine.ts` ~914). Ali houve `activity.start` antes, e o par está certo.

- [ ] **Step 4: Changeset**

`.changeset/quiet-jobs-end.md`:

```md
---
'@bpmn-flow/core': patch
'@bpmn-flow/viewer': patch
'@bpmn-flow/server': patch
'@bpmn-flow/cli': patch
---

`failJob` com `BpmnError` deixa de emitir `activity.end` para um job parado,
que nunca emitiu `activity.start`. O viewer marcava a atividade como concluída
quando ela tinha sido interrompida pelo erro.
```

- [ ] **Step 5: Gate, commit, push, PR**

```bash
npm run verify
git add packages/core .changeset
git commit -m "fix(core): drop the orphan activity.end when a job fails with BpmnError"
git push -u origin fix/job-error-activity-end
gh pr create --base master --title "fix(core): no orphan activity.end on a failed job" --body "<resumo acima + https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb>"
git checkout master && cd ../ebb
```

Push e PR são externos: peça confirmação ao usuário antes. Não mergeie sem ordem explícita. Volte o `bpmn-flow` para `master` ao terminar, porque o ebb builda contra o working tree dele.

---

### Task 6: Replay puro

**Files:**

- Modify: `packages/runtime/src/commands.ts` (acrescenta `commandFromEntry`, `JournalShapeError`, `parseStartEngineOptions`)
- Modify: `packages/runtime/src/runtime.ts:296-314` (remove `isRecord`/`parseStartEngineOptions` locais, passa a importar de `commands.ts`)
- Create: `packages/runtime/src/replay.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/fixtures.ts` (acrescenta `GATEWAY`, `TIMER`)
- Create: `packages/runtime/test/replay.test.ts`

**Interfaces:**

- Consumes: `applyCommand(engine, command)`, `InstanceCommand`, `StartEngineOptions` (`commands.ts`); `JournalEntry` (`@ebb/store`)
- Produces:
  - `commandFromEntry(entry: Pick<JournalEntry, 'seq' | 'type' | 'payload'>): InstanceCommand`
  - `class JournalShapeError extends Error { seq: number; field: string }`
  - `parseStartEngineOptions(value: unknown): Pick<StartEngineOptions, 'onHandlerError' | 'retry'> | undefined` (mesmo comportamento de hoje, só muda de arquivo)
  - `replayJournal(xml: string, journal: JournalEntry[], options?: { upTo?: number }): Promise<{ engine: WorkflowEngine; steps: ReplayStep[] }>`
  - `interface ReplayStep { seq; at; command; snapshot; entered: HistoryEntry[]; flows: string[]; decisions: GatewayTrace[]; tasks: PendingTask[]; incidents: IncidentState[] }`
  - `interface GatewayTrace { nodeId: string; name?: string; options: { flowId: string; targetId: string; condition?: string; isDefault: boolean }[]; taken: string[]; variables: Record<string, unknown> }`
  - `class ReplayRangeError extends Error { upTo: number; last: number }`

- [ ] **Step 1: Fixtures**

Em `packages/runtime/test/fixtures.ts`:

```ts
/** Gateway exclusivo com condição e default: o caso de "por que foi por ali". */
export const GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Aprovacao" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Avaliar" name="Avaliar pedido" />
    <bpmn:exclusiveGateway id="Gateway_Valor" name="Valor alto?" default="Flow_Baixo" />
    <bpmn:userTask id="Diretoria" name="Aprovar na diretoria" />
    <bpmn:endEvent id="EndAlto" />
    <bpmn:endEvent id="EndBaixo" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Avaliar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Avaliar" targetRef="Gateway_Valor" />
    <bpmn:sequenceFlow id="Flow_Alto" sourceRef="Gateway_Valor" targetRef="Diretoria">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">valor &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Baixo" sourceRef="Gateway_Valor" targetRef="EndBaixo" />
    <bpmn:sequenceFlow id="f4" sourceRef="Diretoria" targetRef="EndAlto" />
  </bpmn:process>
</bpmn:definitions>`;

/** Timer intermediário: exercita o relógio mutável do replay. */
export const TIMER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Espera" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Aguardar">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:userTask id="Conferir" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aguardar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aguardar" targetRef="Conferir" />
    <bpmn:sequenceFlow id="f2" sourceRef="Conferir" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;
```

- [ ] **Step 2: Testes que falham**

`packages/runtime/test/replay.test.ts`:

```ts
import { checksumOf, SqliteStore } from '@ebb/store';
import type { JournalEntry } from '@ebb/store';
import { describe, expect, it } from 'vitest';
import { commandFromEntry, JournalShapeError } from '../src/commands.js';
import { replayJournal, ReplayRangeError } from '../src/replay.js';
import { EbbRuntime } from '../src/runtime.js';
import { EXTERNAL_JOB, GATEWAY, JOB_WITH_BOUNDARY, PEDIDO, TIMER } from './fixtures.js';

const AT = 1_700_000_000_000;
const HOUR = 3_600_000;

const XML: Record<string, string> = {
  Pedido: PEDIDO,
  Aprovacao: GATEWAY,
  Espera: TIMER,
  Job: EXTERNAL_JOB,
  JobBoundary: JOB_WITH_BOUNDARY,
};

async function fixture() {
  const store = new SqliteStore({ path: ':memory:', now: () => new Date(AT) });
  for (const [processKey, xml] of Object.entries(XML)) {
    await store.deploy({ processKey, xml, checksum: checksumOf(xml) });
  }
  let ids = 0;
  const runtime = new EbbRuntime({ store, now: () => new Date(AT), newId: () => `inst-${++ids}` });
  return { store, runtime };
}

/** O primeiro token esperando, falhando alto se não houver. */
function first<T>(items: T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error('esperava ao menos um item');
  return item;
}

type Scenario = (runtime: EbbRuntime) => Promise<string>;

/**
 * Roteiros que passam por cada tipo de comando. Cada um devolve o id da
 * instância; o estado ao vivo de cada passo é o que o store gravou.
 */
const SCENARIOS: Record<string, Scenario> = {
  'tarefa simples': async (runtime) => {
    const started = await runtime.start('Pedido', { variables: { total: 42 } });
    await runtime.apply(started.instance.id, {
      type: 'completeTask',
      tokenId: first(started.tasks).tokenId,
    });
    return started.instance.id;
  },
  'gateway exclusivo': async (runtime) => {
    const started = await runtime.start('Aprovacao');
    const id = started.instance.id;
    const avaliado = await runtime.apply(id, {
      type: 'completeTask',
      tokenId: first(started.tasks).tokenId,
      output: { valor: 150 },
    });
    await runtime.apply(id, {
      type: 'completeTask',
      tokenId: first(avaliado.tasks).tokenId,
      output: { valor: 999 },
    });
    return id;
  },
  'timer com relógio andando': async (runtime) => {
    const started = await runtime.start('Espera');
    const id = started.instance.id;
    await runtime.apply(id, { type: 'tick' }, AT + HOUR / 2);
    await runtime.apply(id, { type: 'tick' }, AT + HOUR);
    return id;
  },
  'retry até incidente e resolução': async (runtime) => {
    const started = await runtime.start('Job', { engine: { retry: { attempts: 1 } } });
    const id = started.instance.id;
    const again = await runtime.failJob(id, first(started.tasks).tokenId, { message: 'timeout' });
    const stuck = await runtime.failJob(id, first(again.tasks).tokenId, { message: 'timeout' });
    await runtime.apply(id, {
      type: 'resolveIncident',
      tokenId: first(stuck.incidents).tokenId,
      output: { manual: true },
    });
    return id;
  },
  'erro de negócio no boundary': async (runtime) => {
    const started = await runtime.start('JobBoundary');
    await runtime.failJob(started.instance.id, first(started.tasks).tokenId, {
      message: 'recusado',
      code: 'DECLINED',
    });
    return started.instance.id;
  },
};

describe('replayJournal — equivalência com o caminho ao vivo', () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    it(`reconstrói cada passo de: ${name}`, async () => {
      const { store, runtime } = await fixture();
      // O store só guarda o último snapshot, então o ao vivo de cada passo é
      // capturado relendo-o depois de cada comando do roteiro.
      const live: unknown[] = [];
      const original = runtime.apply.bind(runtime);
      runtime.apply = async (...args) => {
        const result = await original(...args);
        const stored = await store.readInstanceState(result.instance.id);
        live.push(JSON.parse(stored?.json ?? 'null'));
        return result;
      };
      const originalStart = runtime.start.bind(runtime);
      runtime.start = async (...args) => {
        const result = await originalStart(...args);
        const stored = await store.readInstanceState(result.instance.id);
        live.push(JSON.parse(stored?.json ?? 'null'));
        return result;
      };

      const id = await scenario(runtime);
      const instance = await store.readInstance(id);
      const journal = await store.journal(id);
      const xml = XML[instance?.processKey ?? ''] ?? '';

      expect(journal).toHaveLength(live.length);
      for (let seq = 1; seq <= journal.length; seq++) {
        const { engine } = await replayJournal(xml, journal, { upTo: seq });
        expect(engine.getState(), `passo ${seq}`).toEqual(live[seq - 1]);
      }
      store.close();
    });
  }
});

describe('replayJournal — o que cada passo explica', () => {
  it('grava a razão do gateway com as variáveis daquele instante', async () => {
    const { store, runtime } = await fixture();
    const id = await SCENARIOS['gateway exclusivo']!(runtime);
    const { steps } = await replayJournal(GATEWAY, await store.journal(id));

    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3]);
    const [decision] = steps[1]!.decisions;
    expect(decision).toMatchObject({
      nodeId: 'Gateway_Valor',
      name: 'Valor alto?',
      taken: ['Flow_Alto'],
      variables: { valor: 150 },
    });
    expect(decision?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          flowId: 'Flow_Alto',
          condition: 'valor > 100',
          isDefault: false,
        }),
        expect.objectContaining({ flowId: 'Flow_Baixo', isDefault: true }),
      ]),
    );
    // O passo 3 reescreveu `valor`; o traço do passo 2 não pode ter mudado junto.
    expect(steps[2]!.snapshot.variables).toMatchObject({ valor: 999 });
    expect(steps[1]!.flows).toContain('Flow_Alto');
    expect(steps[1]!.entered.map((entry) => entry.nodeId)).toContain('Diretoria');
    store.close();
  });

  it('reinjeta o at de cada comando no relógio do motor', async () => {
    const { store, runtime } = await fixture();
    const id = await SCENARIOS['timer com relógio andando']!(runtime);
    const { steps } = await replayJournal(TIMER, await store.journal(id));

    expect(steps[1]!.snapshot.status).toBe('waiting');
    expect(steps[1]!.entered).toEqual([]);
    const conferir = steps[2]!.entered.find(
      (entry) => entry.nodeId === 'Conferir' && entry.event === 'enter',
    );
    expect(conferir?.at).toBe(AT + HOUR);
    store.close();
  });

  it('para no passo pedido', async () => {
    const { store, runtime } = await fixture();
    const id = await SCENARIOS['gateway exclusivo']!(runtime);
    const { steps, engine } = await replayJournal(GATEWAY, await store.journal(id), { upTo: 2 });

    expect(steps).toHaveLength(2);
    expect(engine.tasks().map((task) => task.nodeId)).toEqual(['Diretoria']);
    store.close();
  });

  it.each([0, 4, 1.5, -1])('recusa upTo fora do journal (%s)', async (upTo) => {
    const { store, runtime } = await fixture();
    const id = await SCENARIOS['gateway exclusivo']!(runtime);

    await expect(replayJournal(GATEWAY, await store.journal(id), { upTo })).rejects.toThrow(
      ReplayRangeError,
    );
    await expect(replayJournal(GATEWAY, await store.journal(id), { upTo })).rejects.toThrow(
      /\[1, 3\]/,
    );
    store.close();
  });

  it('recusa journal vazio', async () => {
    await expect(replayJournal(GATEWAY, [])).rejects.toThrow(ReplayRangeError);
  });
});

describe('commandFromEntry', () => {
  const entry = (type: string, payload: Record<string, unknown>, seq = 2) => ({
    seq,
    type,
    payload,
  });
  const ENGINE = {
    mode: 'automation',
    maxSteps: 10_000,
    expressions: 'safe',
    onHandlerError: 'incident',
    retry: { attempts: 0 },
  };

  it('reconstrói cada tipo de comando', () => {
    expect(commandFromEntry(entry('start', { engine: ENGINE, variables: { a: 1 } }, 1))).toEqual({
      type: 'start',
      engine: ENGINE,
      variables: { a: 1 },
    });
    expect(commandFromEntry(entry('completeTask', { tokenId: 't1', output: { x: 1 } }))).toEqual({
      type: 'completeTask',
      tokenId: 't1',
      output: { x: 1 },
    });
    expect(commandFromEntry(entry('signal', { name: 'Pago' }))).toEqual({
      type: 'signal',
      name: 'Pago',
    });
    expect(commandFromEntry(entry('tick', {}))).toEqual({ type: 'tick' });
    expect(commandFromEntry(entry('completeJob', { tokenId: 't1' }))).toEqual({
      type: 'completeJob',
      tokenId: 't1',
    });
    expect(
      commandFromEntry(entry('failJob', { tokenId: 't1', error: { message: 'x', code: 'C' } })),
    ).toEqual({ type: 'failJob', tokenId: 't1', error: { message: 'x', code: 'C' } });
    expect(commandFromEntry(entry('retryTask', { tokenId: 't1' }))).toEqual({
      type: 'retryTask',
      tokenId: 't1',
    });
    expect(commandFromEntry(entry('resolveIncident', { tokenId: 't1' }))).toEqual({
      type: 'resolveIncident',
      tokenId: 't1',
    });
  });

  it.each([
    [entry('completeTask', {}), /Entrada 2.*tokenId/],
    [entry('failJob', { tokenId: 't1', error: {} }), /Entrada 2.*error\.message/],
    [entry('signal', { name: 'x', output: 'nope' }), /Entrada 2.*output/],
    [entry('start', { variables: {} }, 1), /Entrada 1.*engine/],
    [entry('teleport', {}), /Entrada 2.*type/],
  ])('falha dizendo seq e campo (%#)', (bad, message) => {
    expect(() => commandFromEntry(bad)).toThrow(JournalShapeError);
    expect(() => commandFromEntry(bad)).toThrow(message);
  });
});

// O journal que começa por outra coisa que `start` é corrupção, não journal.
it('recusa journal que não começa por start', async () => {
  const journal: JournalEntry[] = [
    { seq: 1, type: 'tick', payload: {}, at: AT, recordedAt: '2026-01-01T00:00:00.000Z' },
  ];
  await expect(replayJournal(PEDIDO, journal)).rejects.toThrow(/Entrada 1.*start/);
});
```

Run: `npx vitest run packages/runtime/test/replay.test.ts`
Expected: FAIL: `../src/replay.js` não existe.

- [ ] **Step 3: Guarda de comando em `commands.ts`**

Acrescente ao fim de `packages/runtime/src/commands.ts` (e `import type { JournalEntry } from '@ebb/store';` no topo):

```ts
/** Uma entrada do journal que não tem a forma de nenhum comando conhecido. */
export class JournalShapeError extends Error {
  constructor(
    readonly seq: number,
    readonly field: string,
    detail: string,
  ) {
    super(`Entrada ${seq} do journal: "${field}" ${detail}.`);
    this.name = 'JournalShapeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * As políticas de falha do payload do `start`, lidas de volta via
 * `JSON.parse`. `undefined` quando não casam, para o chamador decidir se isso
 * é padrão (retomada pelo snapshot) ou erro (replay).
 */
export function parseStartEngineOptions(
  value: unknown,
): Pick<StartEngineOptions, 'onHandlerError' | 'retry'> | undefined {
  if (!isRecord(value)) return undefined;
  const { onHandlerError, retry } = value;
  if (onHandlerError !== 'fail' && onHandlerError !== 'incident') return undefined;
  if (!isRecord(retry) || typeof retry.attempts !== 'number') return undefined;
  return { onHandlerError, retry: { attempts: retry.attempts } };
}

function parseEngine(value: unknown): StartEngineOptions | undefined {
  const policies = parseStartEngineOptions(value);
  if (!policies || !isRecord(value)) return undefined;
  const { mode, maxSteps, expressions } = value;
  if (mode !== 'automation' && mode !== 'auto') return undefined;
  if (typeof maxSteps !== 'number') return undefined;
  if (expressions !== 'safe' && expressions !== 'javascript') return undefined;
  return { mode, maxSteps, expressions, ...policies };
}

/**
 * A entrada gravada de volta como comando, sem `as`: o payload veio de
 * `JSON.parse` e o replay não pode reexecutar um comando com forma errada
 * como se fosse o que aconteceu.
 */
export function commandFromEntry(
  entry: Pick<JournalEntry, 'seq' | 'type' | 'payload'>,
): InstanceCommand {
  const { seq, type, payload } = entry;
  const text = (field: string): string => {
    const value = payload[field];
    if (typeof value !== 'string') throw new JournalShapeError(seq, field, 'deveria ser texto');
    return value;
  };
  const object = (field: string): Record<string, unknown> | undefined => {
    const value = payload[field];
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new JournalShapeError(seq, field, 'deveria ser um objeto');
    return value;
  };
  const withOutput = () => {
    const output = object('output');
    return output ? { output } : {};
  };

  switch (type) {
    case 'start': {
      const engine = parseEngine(payload.engine);
      // Sem as opções completas, o replay não sabe com que motor a instância
      // nasceu — adivinhar o padrão de hoje reconstruiria outra execução.
      if (!engine) {
        throw new JournalShapeError(
          seq,
          'engine',
          'deveria trazer as opções com que o motor nasceu',
        );
      }
      const variables = object('variables');
      return { type, engine, ...(variables ? { variables } : {}) };
    }
    case 'completeTask':
      return { type, tokenId: text('tokenId'), ...withOutput() };
    case 'completeJob':
      return { type, tokenId: text('tokenId'), ...withOutput() };
    case 'resolveIncident':
      return { type, tokenId: text('tokenId'), ...withOutput() };
    case 'signal':
      return { type, name: text('name'), ...withOutput() };
    case 'tick':
      return { type };
    case 'retryTask':
      return { type, tokenId: text('tokenId') };
    case 'failJob': {
      const error = object('error');
      if (!error || typeof error.message !== 'string') {
        throw new JournalShapeError(seq, 'error.message', 'deveria ser texto');
      }
      const { code } = error;
      if (code !== undefined && typeof code !== 'string') {
        throw new JournalShapeError(seq, 'error.code', 'deveria ser texto');
      }
      return {
        type,
        tokenId: text('tokenId'),
        error: { message: error.message, ...(code ? { code } : {}) },
      };
    }
    default:
      throw new JournalShapeError(seq, 'type', `desconhecido: "${type}"`);
  }
}
```

Confira `ExpressionMode` em `../bpmn-flow/packages/core/src/engine/expression.ts`. Se houver valores além de `'safe' | 'javascript'`, inclua todos em `parseEngine`.

Em `runtime.ts`, apague as funções `isRecord` e `parseStartEngineOptions` do fim do arquivo e importe `parseStartEngineOptions` de `'./commands.js'`.

- [ ] **Step 4: `replay.ts`**

```ts
import { executableProcess, parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type {
  ExecutionSnapshot,
  GatewayDecision,
  HistoryEntry,
  IncidentState,
  PendingTask,
} from '@bpmn-flow/core';
import type { JournalEntry } from '@ebb/store';
import {
  applyCommand,
  commandFromEntry,
  JournalShapeError,
  type InstanceCommand,
} from './commands.js';

/** Por que um gateway foi por onde foi, no instante em que decidiu. */
export interface GatewayTrace {
  nodeId: string;
  name?: string;
  options: { flowId: string; targetId: string; condition?: string; isDefault: boolean }[];
  taken: string[];
  variables: Record<string, unknown>;
}

/** Um comando do journal e o que ele fez com a instância. */
export interface ReplayStep {
  seq: number;
  at: number;
  command: InstanceCommand;
  /** Estado logo depois do comando. */
  snapshot: ExecutionSnapshot;
  /** O que este comando acrescentou à history do motor. */
  entered: HistoryEntry[];
  /** Fluxos tomados durante o comando, em ordem. */
  flows: string[];
  decisions: GatewayTrace[];
  tasks: PendingTask[];
  incidents: IncidentState[];
}

/** Pediram um passo que o journal não tem. */
export class ReplayRangeError extends Error {
  constructor(
    readonly upTo: number,
    readonly last: number,
  ) {
    super(
      last === 0
        ? 'O journal está vazio: não há passo para reconstruir.'
        : `Passo ${upTo} fora do journal: os passos vão de [1, ${last}].`,
    );
    this.name = 'ReplayRangeError';
  }
}

function trace(decision: GatewayDecision): GatewayTrace {
  return {
    nodeId: decision.nodeId,
    ...(decision.name ? { name: decision.name } : {}),
    options: decision.options.map((option) => ({
      flowId: option.flowId,
      targetId: option.targetId,
      isDefault: option.isDefault,
      ...(option.condition ? { condition: option.condition } : {}),
    })),
    taken: [...decision.suggested],
    // Cópia de propósito: o motor pode entregar o objeto vivo do escopo, e o
    // próximo comando reescreveria o "porquê" deste passo.
    variables: structuredClone(decision.variables),
  };
}

/**
 * Reconstrói uma instância a partir do journal, sem tocar store nenhum.
 *
 * Um motor só, com os comandos aplicados em sequência e o relógio posto no
 * `at` de cada um antes de aplicá-lo — a mesma disciplina do relógio congelado
 * do caminho ao vivo. O `decide` só registra e devolve `undefined`, que pelo
 * contrato do hook deixa a decisão com os dados: é assim que a razão do
 * gateway sai sem mudar o motor nem o journal.
 */
export async function replayJournal(
  xml: string,
  journal: JournalEntry[],
  options: { upTo?: number } = {},
): Promise<{ engine: WorkflowEngine; steps: ReplayStep[] }> {
  const last = journal.at(-1)?.seq ?? 0;
  const upTo = options.upTo ?? last;
  if (last === 0 || !Number.isInteger(upTo) || upTo < 1 || upTo > last) {
    throw new ReplayRangeError(upTo, last);
  }
  const entries = journal.slice(0, upTo);
  entries.forEach((entry, index) => {
    if (entry.seq !== index + 1) {
      throw new JournalShapeError(entry.seq, 'seq', `deveria ser ${index + 1}: journal com buraco`);
    }
  });
  const commands = entries.map(commandFromEntry);
  const [birth] = commands;
  if (birth?.type !== 'start') {
    throw new JournalShapeError(1, 'type', 'deveria ser start: é o comando que cria a instância');
  }

  const model = await parseBpmn(xml);
  const process = executableProcess(model);
  let clock = entries[0]?.at ?? 0;
  let decisions: GatewayTrace[] = [];
  let flows: string[] = [];
  const engine = new WorkflowEngine(process, {
    processes: model.processes,
    now: () => clock,
    ...birth.engine,
    ...(birth.variables ? { variables: birth.variables } : {}),
    decide: (decision) => {
      decisions.push(trace(decision));
      return undefined;
    },
  });
  engine.on('flow.take', ({ flowId }) => flows.push(flowId));

  const steps: ReplayStep[] = [];
  let seen = 0;
  for (const [index, command] of commands.entries()) {
    const entry = entries[index];
    if (!entry) break;
    clock = entry.at;
    decisions = [];
    flows = [];
    const snapshot = await applyCommand(engine, command);
    steps.push({
      seq: entry.seq,
      at: entry.at,
      command,
      snapshot,
      entered: snapshot.history.slice(seen),
      flows,
      decisions,
      tasks: engine.tasks(),
      incidents: engine.incidentList(),
    });
    seen = snapshot.history.length;
  }
  return { engine, steps };
}
```

Se o TypeScript reclamar que `GatewayDecision` não é exportado por `@bpmn-flow/core`, confira `../bpmn-flow/packages/core/src/index.ts` (bloco `export type { … } from './engine/types.js'`). Se faltar, tipe o parâmetro como `Parameters<NonNullable<EngineOptions['decide']>>[0]`, com `EngineOptions` importado do core, **sem** mexer no core.

- [ ] **Step 5: Exportar**

Em `packages/runtime/src/index.ts`:

```ts
export { applyCommand, commandFromEntry, JournalShapeError, payloadOf } from './commands.js';
export { replayJournal, ReplayRangeError } from './replay.js';
export type { GatewayTrace, ReplayStep } from './replay.js';
```

Os dois primeiros substituem a linha `export { applyCommand, payloadOf }` atual.

- [ ] **Step 6: Rodar**

Run: `npx vitest run packages/runtime/test/replay.test.ts`
Expected: PASS.

**Se a equivalência falhar** num passo, o diff do `toEqual` diz o campo. Compare com o que `WorkflowEngine.restore` (`../bpmn-flow/packages/core/src/engine/engine.ts`, `static restore`) faz com ele. Divergência entre motor único e restore-por-comando é defeito do core. Pare, relate o campo e o cenário ao usuário, e **não** contorne aqui (regra do CLAUDE.md do ebb). A correção vira PR no bpmn-flow, no molde da Tarefa 5.

- [ ] **Step 7: Gate e commit**

Run: `npm run verify` → PASS.

```bash
git add packages/runtime
git commit -m "feat(runtime): rebuild an instance from its journal alone"
```

---

### Task 7: Snapshot como cache — guarda e fallback do `hydrate`

**Files:**

- Create: `packages/runtime/src/state.ts`
- Modify: `packages/runtime/src/runtime.ts` (`hydrate`, `inspect`)
- Modify: `packages/runtime/src/errors.ts` (remove `EngineStateMismatchError`), `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/runtime.test.ts:5-9` (import) e `:198-213` (teste do esquema)
- Test: `packages/runtime/test/runtime.test.ts`

**Interfaces:**

- Consumes: `replayJournal` (Tarefa 6), `parseStartEngineOptions` (`commands.ts`)
- Produces: `parseEngineState(json: string): EngineState | undefined` (interno, não exportado no `index.ts`)

- [ ] **Step 1: Testes que falham**

Em `runtime.test.ts`, substitua o teste `'falha com a própria mensagem quando o esquema do motor mudou'` por:

```ts
it('reconstrói pelo journal quando o esquema do motor mudou, e se cura no próximo comando', async () => {
  const { store, runtime } = await fixture();
  const started = await runtime.start('Pedido', { variables: { total: 42 } });
  // Simula um ebb atualizado lendo o que a versão anterior gravou.
  await store.append({
    instanceId: 'inst-1',
    status: 'waiting',
    command: { type: 'tick', payload: {}, at: AT },
    state: { engineVersion: ENGINE_STATE_VERSION - 1, json: '{}' },
    jobs: [],
  });

  const view = await runtime.inspect('inst-1');
  expect(view.snapshot.variables).toMatchObject({ total: 42 });
  expect(view.tasks.map((task) => task.nodeId)).toEqual(['Separar']);
  // Ler não escreve: o snapshot velho continua lá até um comando.
  expect((await store.readInstanceState('inst-1'))?.engineVersion).toBe(ENGINE_STATE_VERSION - 1);

  const [task] = started.tasks;
  await runtime.apply('inst-1', { type: 'completeTask', tokenId: task?.tokenId ?? '' });
  expect((await store.readInstanceState('inst-1'))?.engineVersion).toBe(ENGINE_STATE_VERSION);
  store.close();
});

it('reconstrói pelo journal quando o snapshot tem a versão certa e a forma errada', async () => {
  const { store, runtime } = await fixture();
  await runtime.start('Pedido', { variables: { total: 42 } });
  await store.append({
    instanceId: 'inst-1',
    status: 'waiting',
    command: { type: 'tick', payload: {}, at: AT },
    state: { engineVersion: ENGINE_STATE_VERSION, json: '{"nope":true}' },
    jobs: [],
  });

  const view = await runtime.inspect('inst-1');
  expect(view.tasks.map((task) => task.nodeId)).toEqual(['Separar']);
  store.close();
});
```

Tire `EngineStateMismatchError` do import de `'../src/errors.js'`.

Run: `npx vitest run packages/runtime/test/runtime.test.ts`
Expected: FAIL: o primeiro lança `EngineStateMismatchError`, e o segundo estoura dentro do `restore`.

- [ ] **Step 2: `state.ts`**

```ts
import type { EngineState } from '@bpmn-flow/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * O snapshot gravado, se tiver cara de estado do motor.
 *
 * A guarda é estrutural e mínima de propósito — `restore()` confere o resto.
 * O que ela evita é o `as EngineState` cego em cima de `JSON.parse`: um
 * snapshot que não casa devolve `undefined`, e quem chamou reconstrói pelo
 * journal. Snapshot é cache; cache ruim se descarta.
 */
export function parseEngineState(json: string): EngineState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.version !== 'number') return undefined;
  if (!Array.isArray(parsed.tokens) || !Array.isArray(parsed.history)) return undefined;
  return isEngineState(parsed) ? parsed : undefined;
}

// Predicado separado só para o narrowing: as checagens acima são as que
// valem, e esta função existe para o compilador aceitar o retorno sem `as`.
function isEngineState(
  value: Record<string, unknown>,
): value is Record<string, unknown> & EngineState {
  return typeof value.version === 'number';
}
```

Confira os nomes `tokens` e `history` em `EngineState` (`../bpmn-flow/packages/core/src/engine/state.ts:133`). Se forem outros, use os reais.

- [ ] **Step 3: `hydrate` com fallback**

Em `runtime.ts`, troque o miolo de `hydrate` a partir de `const stored = …` até a construção do `engine`:

```ts
const log = journal ?? (await this.store.journal(instanceId));
const stored = await this.store.readInstanceState(instanceId);
// Snapshot é cache: versão de motor diferente ou forma inválida não
// tornam a instância ilegível, só mais cara — reconstrói pelo journal.
// Quem regrava na versão atual é o próximo `apply`; ler não escreve.
const cached =
  stored?.engineVersion === ENGINE_STATE_VERSION ? parseEngineState(stored.json) : undefined;
const state = cached ?? (await replayJournal(deployment.xml, log)).engine.getState();

const model = await parseBpmn(deployment.xml);
const process = executableProcess(model);

// As políticas de falha não estão no EngineState (o motor não as
// serializa, nem as devolve em getState()), então quem as lembra é a
// primeira entrada do journal — a que start() gravou. Sem re-lê-las e
// repassá-las a restore(), toda instância re-hidratada voltaria ao padrão
// 'fail' de @bpmn-flow/core, e uma falha de worker derrubaria a instância
// em vez de abrir incidente.
const [birth] = log;
const engineOptions = parseStartEngineOptions(birth?.payload.engine);
```

O resto (`WorkflowEngine.restore(process, state, …)`) fica igual. Remova o `throw new Error('… não tem estado gravado.')` e o `EngineStateMismatchError`, porque o journal cobre os dois casos. Importe `parseEngineState` de `'./state.js'` e `replayJournal` de `'./replay.js'`. Remova o import de `EngineState` se ficar sem uso.

Extraia a busca do deployment para um método privado, que as Tarefas 8 reusam:

```ts
  /** O deployment com que a instância nasceu — não o mais recente. */
  private async deploymentOf(instance: InstanceRecord): Promise<Deployment> {
    const deployment = await this.store.read(instance.processKey, instance.version);
    if (!deployment) {
      throw new Error(
        `A instância ${instance.id} aponta para ${instance.processKey} v${instance.version}, que não está publicado.`,
      );
    }
    return deployment;
  }
```

(`Deployment` vem de `@ebb/store`.) Use-o em `hydrate` no lugar do bloco atual.

- [ ] **Step 4: Remover o erro morto**

Apague a classe `EngineStateMismatchError` de `errors.ts` e a linha correspondente em `index.ts`. Rode `rg -n EngineStateMismatch packages --glob '!dist'`. Deve devolver vazio.

- [ ] **Step 5: Rodar, gate e commit**

Run: `npx vitest run packages/runtime` → PASS. `npm run verify` → PASS.

```bash
git add packages/runtime
git commit -m "feat(runtime): treat the snapshot as a cache the journal can rebuild"
```

---

### Task 8: Proveniência no store, `replay` e `fork` no runtime

**Files:**

- Modify: `packages/store/src/migrations.ts` (migração 4)
- Modify: `packages/store/src/types.ts` (`InstanceRecord`, `ForkInstanceInput`, `Store.forkInstance`)
- Modify: `packages/store/src/rows.ts` (exporta `optionalInteger`), `packages/store/src/jobs.ts` (usa o de `rows.ts`)
- Modify: `packages/store/src/instances.ts` (`toInstance`), `packages/store/src/sqlite.ts` (`forkInstance`), `packages/store/src/index.ts`
- Modify: `packages/runtime/src/runtime.ts` (`replay`, `fork`, `ReplayView`), `packages/runtime/src/index.ts`
- Test: `packages/store/test/instances.test.ts`, `packages/store/test/sqlite.test.ts` (migração), `packages/runtime/test/fork.test.ts` (novo)

**Interfaces:**

- Produces (store):
  - `InstanceRecord.forkedFrom?: string`, `InstanceRecord.forkedAt?: number`
  - `interface ForkInstanceInput { id: string; from: string; at: number; status: InstanceStatus; journal: JournalEntry[]; state: EngineStateInput; jobs: JobProjection[] }`
  - `Store.forkInstance(input: ForkInstanceInput): Promise<InstanceRecord>`
  - `optionalInteger(row: Row, column: string): number | undefined` em `rows.ts`
- Produces (runtime):
  - `interface ReplayView { instance: InstanceRecord; xml: string; steps: ReplayStep[] }`
  - `EbbRuntime.replay(instanceId: string, upTo?: number): Promise<ReplayView>`
  - `EbbRuntime.fork(instanceId: string, seq: number, command?: InstanceCommand): Promise<CommandResult>`

- [ ] **Step 1: Testes do store que falham**

Em `packages/store/test/instances.test.ts`, novo `describe`:

```ts
describe('bifurcação', () => {
  async function withHistory(store: SqliteStore) {
    await store.createInstance(creation('orig'));
    for (const tokenId of ['t1', 't2']) {
      await store.append({
        instanceId: 'orig',
        status: 'waiting',
        command: { type: 'completeTask', payload: { tokenId }, at: 1_700_000_000_500 },
        state: { engineVersion: 10, json: '{"version":10}' },
        jobs: [],
      });
    }
    return store.journal('orig');
  }

  it('cria a instância nova com o journal cortado, o at original e a proveniência', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    const journal = await withHistory(store);

    const forked = await store.forkInstance({
      id: 'fork',
      from: 'orig',
      at: 2,
      status: 'waiting',
      journal: journal.slice(0, 2),
      state: { engineVersion: 10, json: '{"version":10,"forked":true}' },
      jobs: [{ tokenId: 'j1', nodeId: 'Charge', type: 'charge', variables: {}, attempts: 0 }],
    });

    expect(forked).toMatchObject({
      id: 'fork',
      processKey: 'Pedido',
      version: 1,
      seq: 2,
      forkedFrom: 'orig',
      forkedAt: 2,
    });
    const copied = await store.journal('fork');
    expect(copied.map(({ seq, type, payload, at }) => ({ seq, type, payload, at }))).toEqual(
      journal.slice(0, 2).map(({ seq, type, payload, at }) => ({ seq, type, payload, at })),
    );
    expect(await store.readInstanceState('fork')).toMatchObject({ seq: 2 });
    expect(await store.listJobs({ instanceId: 'fork' })).toMatchObject([
      { tokenId: 'j1', state: 'pending' },
    ]);
    // A original não mudou.
    expect(await store.journal('orig')).toHaveLength(3);
    expect(await store.readInstance('orig')).not.toHaveProperty('forkedFrom');
    store.close();
  });

  it('recusa journal que não é [1..at] contíguo', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    const journal = await withHistory(store);
    const input = {
      id: 'fork',
      from: 'orig',
      at: 2,
      status: 'waiting' as const,
      state: { engineVersion: 10, json: '{}' },
      jobs: [],
    };

    await expect(store.forkInstance({ ...input, journal: journal.slice(1, 3) })).rejects.toThrow(
      /\[1\.\.2\]/,
    );
    await expect(store.forkInstance({ ...input, journal: journal.slice(0, 1) })).rejects.toThrow(
      /\[1\.\.2\]/,
    );
    expect(await store.readInstance('fork')).toBeUndefined();
    store.close();
  });

  it('recusa bifurcar de instância que não existe', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await expect(
      store.forkInstance({
        id: 'fork',
        from: 'nada',
        at: 1,
        status: 'waiting',
        journal: [],
        state: { engineVersion: 10, json: '{}' },
        jobs: [],
      }),
    ).rejects.toThrow(/nada/);
    store.close();
  });
});
```

Em `packages/store/test/sqlite.test.ts`, perto dos testes de migração existentes (procure `SCHEMA_VERSION` ou `schema_migrations` no arquivo e siga o padrão deles), acrescente:

```ts
it('migra um banco no esquema 3 com instâncias sem perder nada', async () => {
  const path = join(dir, 'v3.db');
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  // Aplica só até a 3, como um ebb do chunk 2 teria deixado o arquivo.
  raw.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) {
    raw.exec(migration.up);
    raw.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, 'x');
  }
  raw.exec(`INSERT INTO deployments VALUES ('Pedido', 1, NULL, '<x/>', 'c', NULL, 'x')`);
  raw.exec(`INSERT INTO instances VALUES ('i1', 'Pedido', 1, 'waiting', 1, 'x', 'x')`);
  raw.close();

  const store = new SqliteStore({ path });
  const instance = await store.readInstance('i1');
  store.close();

  expect(instance).toMatchObject({ id: 'i1', status: 'waiting' });
  expect(instance).not.toHaveProperty('forkedFrom');
});
```

Importe `MIGRATIONS` de `'../src/migrations.js'` (confira que é exportado; se não for, exporte-o) e `DatabaseSync` de `'node:sqlite'`, se ainda não estiver.

Run: `npx vitest run packages/store`
Expected: FAIL: `forkInstance` não existe.

- [ ] **Step 2: Migração 4**

Em `MIGRATIONS` (`migrations.ts`), depois da 3:

```ts
  // Proveniência de bifurcação. Sem FOREIGN KEY em `forked_from` de
  // propósito: apagar a original não pode apagar nem travar as bifurcações,
  // que carregam journal próprio e completo.
  {
    version: 4,
    name: 'fork provenance',
    up: `
      ALTER TABLE instances ADD COLUMN forked_from TEXT;
      ALTER TABLE instances ADD COLUMN forked_at   INTEGER;
    `,
  },
```

- [ ] **Step 3: Tipos e leitura**

`types.ts`, em `InstanceRecord`, depois de `updatedAt`:

```ts
  /** A instância de onde esta foi bifurcada, quando foi. */
  forkedFrom?: string;
  /** O `seq` da original em que o corte foi feito. */
  forkedAt?: number;
```

Novo tipo, depois de `AppendInput`:

```ts
export interface ForkInstanceInput {
  id: string;
  from: string;
  /** O `seq` de corte: o journal novo é o `[1..at]` da original. */
  at: number;
  status: InstanceStatus;
  /** As entradas `[1..at]` como lidas da original — `at` e payload intactos. */
  journal: JournalEntry[];
  state: EngineStateInput;
  jobs: JobProjection[];
}
```

Em `Store`, depois de `append`:

```ts
  /**
   * Cria uma instância a partir do passo `at` de outra: a linha nova, a cópia
   * do journal até ali e o estado reconstruído — numa transação só. A
   * original não é tocada: journal é imutável.
   */
  forkInstance(input: ForkInstanceInput): Promise<InstanceRecord>;
```

Exporte `ForkInstanceInput` em `packages/store/src/index.ts`, junto dos outros tipos.

`rows.ts`: mova `optionalInteger` de `jobs.ts` para cá, exportada:

```ts
export function optionalInteger(row: Row, column: string): number | undefined {
  const value = row[column];
  return value === null || value === undefined ? undefined : integer(row, column);
}
```

Em `jobs.ts`, apague a local e importe de `'./rows.js'`.

`instances.ts`, `toInstance`:

```ts
export function toInstance(row: Row): InstanceRecord {
  const forkedFrom = optionalText(row, 'forked_from');
  const forkedAt = optionalInteger(row, 'forked_at');
  return {
    id: text(row, 'id'),
    processKey: text(row, 'process_key'),
    version: integer(row, 'version'),
    status: status(row),
    seq: integer(row, 'seq'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
    ...(forkedAt === undefined ? {} : { forkedAt }),
  };
}
```

(`optionalText` e `optionalInteger` importados de `'./rows.js'`.)

- [ ] **Step 4: `forkInstance` no `SqliteStore`**

Depois de `append`:

```ts
  forkInstance(input: ForkInstanceInput): Promise<InstanceRecord> {
    const at = this.now().toISOString();
    return promised(() => {
      const origin = this.instanceRow(input.from);
      const contiguous =
        input.journal.length === input.at &&
        input.journal.every((entry, index) => entry.seq === index + 1);
      if (!contiguous) {
        throw new Error(`forkInstance: o journal tem de ser o [1..${input.at}] da original.`);
      }
      return transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO instances (id, process_key, version, status, seq, created_at, updated_at,
                                    forked_from, forked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            origin.processKey,
            origin.version,
            input.status,
            input.at,
            at,
            at,
            input.from,
            input.at,
          );
        // `at` de cada entrada é o relógio do motor e vai intacto: é o que o
        // replay da bifurcação reinjeta. `recorded_at` é de agora — a cópia
        // aconteceu agora.
        for (const entry of input.journal) this.writeJournal(input.id, entry.seq, entry);
        this.writeEngineState(input.id, input.at, input.state);
        this.reconcileJobs(input.id, input.jobs);
        return this.instanceRow(input.id);
      });
    });
  }
```

Acrescente `ForkInstanceInput` ao import de tipos.

Run: `npx vitest run packages/store` → PASS.

- [ ] **Step 5: Testes do runtime que falham**

`packages/runtime/test/fork.test.ts`:

```ts
import { checksumOf, SqliteStore } from '@ebb/store';
import { describe, expect, it } from 'vitest';
import { InstanceNotFoundError } from '../src/errors.js';
import { ReplayRangeError } from '../src/replay.js';
import { EbbRuntime } from '../src/runtime.js';
import { EXTERNAL_JOB, GATEWAY } from './fixtures.js';

const AT = 1_700_000_000_000;

async function fixture() {
  const store = new SqliteStore({ path: ':memory:', now: () => new Date(AT) });
  await store.deploy({ processKey: 'Aprovacao', xml: GATEWAY, checksum: checksumOf(GATEWAY) });
  await store.deploy({ processKey: 'Job', xml: EXTERNAL_JOB, checksum: checksumOf(EXTERNAL_JOB) });
  let ids = 0;
  const runtime = new EbbRuntime({ store, now: () => new Date(AT), newId: () => `inst-${++ids}` });
  return { store, runtime };
}

/** Aprovação de valor alto, concluída: inst-1 com três comandos. */
async function approvedHigh(runtime: EbbRuntime) {
  const started = await runtime.start('Aprovacao');
  const avaliar = started.tasks[0]?.tokenId ?? '';
  const high = await runtime.apply('inst-1', {
    type: 'completeTask',
    tokenId: avaliar,
    output: { valor: 150 },
  });
  await runtime.apply('inst-1', { type: 'completeTask', tokenId: high.tasks[0]?.tokenId ?? '' });
  return avaliar;
}

describe('EbbRuntime.replay', () => {
  it('devolve todos os passos, o xml da versão congelada e a instância', async () => {
    const { store, runtime } = await fixture();
    await approvedHigh(runtime);

    const view = await runtime.replay('inst-1');

    expect(view.instance.id).toBe('inst-1');
    expect(view.xml).toBe(GATEWAY);
    expect(view.steps.map((step) => step.command.type)).toEqual([
      'start',
      'completeTask',
      'completeTask',
    ]);
    expect(view.steps[1]?.decisions[0]?.taken).toEqual(['Flow_Alto']);
    store.close();
  });

  it('corta em upTo e não escreve nada', async () => {
    const { store, runtime } = await fixture();
    await approvedHigh(runtime);
    const before = await store.readInstanceState('inst-1');

    const view = await runtime.replay('inst-1', 1);

    expect(view.steps).toHaveLength(1);
    expect(await store.readInstanceState('inst-1')).toEqual(before);
    store.close();
  });

  it('diz quando a instância não existe', async () => {
    const { store, runtime } = await fixture();
    await expect(runtime.replay('nada')).rejects.toThrow(InstanceNotFoundError);
    store.close();
  });
});

describe('EbbRuntime.fork', () => {
  it('bifurca no passo 1 e segue por outro ramo, sem tocar a original', async () => {
    const { store, runtime } = await fixture();
    const avaliar = await approvedHigh(runtime);
    const originalJournal = await store.journal('inst-1');

    const forked = await runtime.fork('inst-1', 1);
    expect(forked.instance).toMatchObject({
      id: 'inst-2',
      seq: 1,
      forkedFrom: 'inst-1',
      forkedAt: 1,
    });
    // O mesmo token existe na bifurcação: ids do motor são determinísticos.
    expect(forked.tasks.map((task) => task.tokenId)).toEqual([avaliar]);

    const low = await runtime.apply('inst-2', {
      type: 'completeTask',
      tokenId: avaliar,
      output: { valor: 50 },
    });
    expect(low.snapshot.status).toBe('completed');
    expect(low.snapshot.completedNodes).toContain('EndBaixo');
    expect(await store.journal('inst-1')).toEqual(originalJournal);
    store.close();
  });

  it('aplica o comando novo quando vem junto', async () => {
    const { store, runtime } = await fixture();
    const avaliar = await approvedHigh(runtime);

    const forked = await runtime.fork('inst-1', 1, {
      type: 'completeTask',
      tokenId: avaliar,
      output: { valor: 50 },
    });

    expect(forked.instance).toMatchObject({ id: 'inst-2', seq: 2, forkedFrom: 'inst-1' });
    expect(forked.snapshot.status).toBe('completed');
    store.close();
  });

  it('bifurca de uma bifurcação apontando para a intermediária', async () => {
    const { store, runtime } = await fixture();
    const avaliar = await approvedHigh(runtime);
    await runtime.fork('inst-1', 1);
    await runtime.apply('inst-2', {
      type: 'completeTask',
      tokenId: avaliar,
      output: { valor: 50 },
    });

    const again = await runtime.fork('inst-2', 2);

    expect(again.instance).toMatchObject({ id: 'inst-3', forkedFrom: 'inst-2', forkedAt: 2 });
    expect(again.snapshot.status).toBe('completed');
    store.close();
  });

  it('leva o job pendente do corte para a bifurcação, livre de trava', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Job');
    await runtime.activateJobs({ type: 'charge', worker: 'w1' });

    const forked = await runtime.fork('inst-1', 1);

    expect(await store.listJobs({ instanceId: forked.instance.id })).toMatchObject([
      { nodeId: 'Charge', state: 'pending' },
    ]);
    expect(await store.listJobs({ instanceId: 'inst-1' })).toMatchObject([
      { state: 'locked', worker: 'w1' },
    ]);
    store.close();
  });

  it('recusa passo fora do journal', async () => {
    const { store, runtime } = await fixture();
    await approvedHigh(runtime);
    await expect(runtime.fork('inst-1', 9)).rejects.toThrow(ReplayRangeError);
    expect(await store.readInstance('inst-2')).toBeUndefined();
    store.close();
  });
});
```

Run: `npx vitest run packages/runtime/test/fork.test.ts`
Expected: FAIL: `runtime.replay` não é função.

- [ ] **Step 6: `replay` e `fork` no `EbbRuntime`**

Tipos, depois de `InstanceView`:

```ts
export interface ReplayView {
  instance: InstanceRecord;
  /** O XML da versão com que a instância nasceu — o que o viewer desenha. */
  xml: string;
  steps: ReplayStep[];
}
```

Métodos, depois de `inspect`:

```ts
  /**
   * Reconstrói os passos de uma instância a partir do journal. Não escreve:
   * rebobinar é leitura.
   */
  async replay(instanceId: string, upTo?: number): Promise<ReplayView> {
    const instance = await this.store.readInstance(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);
    const deployment = await this.deploymentOf(instance);
    const journal = await this.store.journal(instanceId);
    const { steps } = await replayJournal(
      deployment.xml,
      journal,
      upTo === undefined ? {} : { upTo },
    );
    return { instance, xml: deployment.xml, steps };
  }

  /**
   * Cria uma instância nova parada no passo `seq` de outra e, se vier,
   * aplica `command` nela.
   *
   * A bifurcação é viva: um job pendente no corte volta para a fila e um
   * worker o executa. É o "seguir com outras variáveis" do time-travel, não
   * efeito colateral. O journal da original não é tocado.
   */
  async fork(instanceId: string, seq: number, command?: InstanceCommand): Promise<CommandResult> {
    const instance = await this.store.readInstance(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);
    const deployment = await this.deploymentOf(instance);
    const journal = await this.store.journal(instanceId);
    const { engine, steps } = await replayJournal(deployment.xml, journal, { upTo: seq });
    const cut = steps.at(-1);
    // replayJournal já recusou seq fora de [1, último], então há ao menos um passo.
    if (!cut) throw new ReplayRangeError(seq, journal.length);

    const forked = await this.store.forkInstance({
      id: this.newId(),
      from: instance.id,
      at: seq,
      status: cut.snapshot.status,
      journal: journal.slice(0, seq),
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
      jobs: projectJobs(engine),
    });
    // Transação à parte de propósito: a bifurcação sem comando já é um estado
    // válido, então não há atomicidade a perder entre as duas escritas.
    if (command) return this.apply(forked.id, command);
    return { instance: forked, snapshot: cut.snapshot, tasks: cut.tasks, incidents: cut.incidents };
  }
```

Imports: `replayJournal`, `ReplayRangeError` e `type ReplayStep` de `'./replay.js'`. Em `index.ts`, acrescente `ReplayView` ao `export type { … } from './runtime.js'`.

- [ ] **Step 7: Rodar, gate e commit**

Run: `npx vitest run packages/store packages/runtime` → PASS. `npm run verify` → PASS.

Dois commits:

```bash
git add packages/store
git commit -m "feat(store): record fork provenance and copy a journal prefix atomically"
git add packages/runtime
git commit -m "feat(runtime): replay an instance and fork it at any step"
```

---

### Task 9: CLI — `ebb show --at`

**Files:**

- Create: `packages/cli/src/timeline.ts`
- Modify: `packages/cli/src/bin.ts` (`case 'show'`, USAGE)
- Modify: `packages/cli/src/instances.ts` (exporta `pendingLines` e `message`)
- Test: `packages/cli/test/timeline.test.ts` (novo)

**Interfaces:**

- Consumes: `EbbRuntime.replay` → `ReplayView`; `GatewayTrace` (`@ebb/runtime`); `withInstance`, `pendingLines` (`instances.ts`)
- Produces:
  - `showStep(store: Store, runtime: EbbRuntime, prefix: string, seq: number): Promise<CommandResult>`
  - `gatewayLine(trace: GatewayTrace): string`

- [ ] **Step 1: Testes que falham**

`packages/cli/test/timeline.test.ts`:

```ts
import { checksumOf, SqliteStore } from '@ebb/store';
import { EbbRuntime } from '@ebb/runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import { gatewayLine, showStep } from '../src/timeline.js';

const GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Aprovacao" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Avaliar" name="Avaliar pedido" />
    <bpmn:exclusiveGateway id="Gateway_Valor" name="Valor alto?" default="Flow_Baixo" />
    <bpmn:userTask id="Diretoria" name="Aprovar na diretoria" />
    <bpmn:endEvent id="EndAlto" />
    <bpmn:endEvent id="EndBaixo" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Avaliar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Avaliar" targetRef="Gateway_Valor" />
    <bpmn:sequenceFlow id="Flow_Alto" sourceRef="Gateway_Valor" targetRef="Diretoria">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">valor &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Baixo" sourceRef="Gateway_Valor" targetRef="EndBaixo" />
    <bpmn:sequenceFlow id="f4" sourceRef="Diretoria" targetRef="EndAlto" />
  </bpmn:process>
</bpmn:definitions>`;

let store: SqliteStore;
let runtime: EbbRuntime;

beforeEach(async () => {
  store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'Aprovacao', xml: GATEWAY, checksum: checksumOf(GATEWAY) });
  let ids = 0;
  runtime = new EbbRuntime({ store, newId: () => `abc${++ids}def` });
});

async function highApproval(): Promise<void> {
  const started = await runtime.start('Aprovacao', { variables: { cliente: 'ACME' } });
  await runtime.apply('abc1def', {
    type: 'completeTask',
    tokenId: started.tasks[0]?.tokenId ?? '',
    output: { valor: 150 },
  });
}

describe('showStep', () => {
  it('mostra o comando, as variáveis, os nós entrados e o porquê do gateway', async () => {
    await highApproval();

    const result = await showStep(store, runtime, 'abc1', 2);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('passo 2 de 2');
    expect(result.output).toContain('completeTask');
    expect(result.output).toContain('"valor":150');
    expect(result.output).toContain('Gateway_Valor: "valor > 100" → Flow_Alto (valor=150)');
    expect(result.output).toContain('Diretoria');
  });

  it('no passo 1 não há gateway e a tarefa pendente é a primeira', async () => {
    await highApproval();

    const result = await showStep(store, runtime, 'abc1', 1);

    expect(result.output).toContain('passo 1 de 2');
    expect(result.output).not.toContain('Gateway_Valor:');
    expect(result.output).toContain('Avaliar pedido');
  });

  it('sai com 1 e diz o intervalo quando o passo não existe', async () => {
    await highApproval();

    const result = await showStep(store, runtime, 'abc1', 3);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('[1, 2]');
  });
});

describe('gatewayLine', () => {
  const base = { nodeId: 'G', variables: { valor: 50, cliente: 'ACME' } };

  it('mostra só as variáveis que as condições citam', () => {
    expect(
      gatewayLine({
        ...base,
        options: [
          { flowId: 'A', targetId: 'x', condition: 'valor > 100', isDefault: false },
          { flowId: 'B', targetId: 'y', isDefault: true },
        ],
        taken: ['B'],
      }),
    ).toBe('G: default → B (valor=50)');
  });

  it('mostra todas quando a condição não cita nenhuma variável conhecida', () => {
    expect(
      gatewayLine({
        ...base,
        options: [{ flowId: 'A', targetId: 'x', condition: 'true', isDefault: false }],
        taken: ['A'],
      }),
    ).toBe('G: "true" → A (valor=50, cliente="ACME")');
  });

  it('lista todos os fluxos tomados num gateway inclusivo', () => {
    expect(
      gatewayLine({
        ...base,
        options: [
          { flowId: 'A', targetId: 'x', condition: 'valor > 10', isDefault: false },
          { flowId: 'B', targetId: 'y', condition: 'valor < 100', isDefault: false },
        ],
        taken: ['A', 'B'],
      }),
    ).toBe('G: "valor > 10" → A, "valor < 100" → B (valor=50)');
  });
});
```

Run: `npx vitest run packages/cli/test/timeline.test.ts`
Expected: FAIL: `../src/timeline.js` não existe.

- [ ] **Step 2: Exportar os helpers de `instances.ts`**

Em `instances.ts`, troque `function pendingLines` por `export function pendingLines` e `function message` por `export function message`.

- [ ] **Step 3: `timeline.ts`**

```ts
import type { EbbRuntime, GatewayTrace } from '@ebb/runtime';
import type { Store } from '@ebb/store';
import type { CommandResult } from './commands.js';
import { pendingLines, withInstance } from './instances.js';
import { table } from './output.js';

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Uma linha por gateway: a condição de cada fluxo tomado e as variáveis que
 * decidiram. "Que decidiram" é heurística de exibição: identificadores que
 * aparecem nas condições e existem entre as variáveis. Quando nenhum casa,
 * mostra todas — errar para o lado de mostrar demais. Fica no CLI, nunca no
 * runtime, porque não é semântica do motor.
 */
export function gatewayLine(trace: GatewayTrace): string {
  const taken = trace.taken.map((flowId) => {
    const option = trace.options.find((candidate) => candidate.flowId === flowId);
    const why = option?.condition ? `"${option.condition}"` : 'default';
    return `${why} → ${flowId}`;
  });
  const cited = new Set(
    trace.options.flatMap((option) => option.condition?.match(IDENTIFIER) ?? []),
  );
  const relevant = Object.entries(trace.variables).filter(([key]) => cited.has(key));
  const shown = relevant.length > 0 ? relevant : Object.entries(trace.variables);
  const values = shown.map(([key, value]) => `${key}=${JSON.stringify(value) ?? 'undefined'}`);
  return `${trace.nodeId}: ${taken.join(', ')} (${values.join(', ')})`;
}

/** `ebb show <id> --at <seq>` — a instância como estava depois do passo `seq`. */
export async function showStep(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  seq: number,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    // O journal inteiro de uma vez: o total de passos entra no cabeçalho, e
    // um seq fora do intervalo vira ReplayRangeError com o intervalo certo.
    const total = (await store.journal(instance.id)).length;
    const { steps } = await runtime.replay(instance.id, seq);
    const step = steps.at(-1);
    if (!step) return { output: `nenhum passo ${seq}`, exitCode: 1 };

    const { type, ...payload } = step.command;
    const lines = [
      `passo ${step.seq} de ${total} — ${type} em ${new Date(step.at).toISOString()}`,
      JSON.stringify(payload),
      '',
      `${instance.id} — ${step.snapshot.status}`,
    ];

    const variables = Object.entries(step.snapshot.variables);
    if (variables.length > 0) {
      lines.push(
        '',
        table(
          ['VARIÁVEL', 'VALOR'],
          variables.map(([key, value]) => [key, JSON.stringify(value) ?? 'undefined']),
        ),
      );
    }

    const entered = step.entered.filter((entry) => entry.event === 'enter');
    if (entered.length > 0) {
      lines.push('', `entrou em: ${entered.map((entry) => entry.nodeId).join(', ')}`);
    }

    if (step.decisions.length > 0) {
      lines.push('', 'GATEWAY', ...step.decisions.map(gatewayLine));
    }

    const pending = pendingLines(step.tasks);
    if (pending.length > 0) lines.push('', ...pending);
    return { output: lines.join('\n'), exitCode: 0 };
  });
}
```

Confira `StartEngineOptions` no payload de `start`: o `JSON.stringify(payload)` do passo 1 imprime `engine` e `variables`, o que é aceitável e informativo.

- [ ] **Step 4: Ligar no `bin.ts`**

Importe `showStep` de `'./timeline.js'`. No `case 'show'`, depois da checagem do id:

```ts
const at = positiveInteger(argv, 'at');
if (at === INVALID) return usageError(invalidOption('at', option(argv, 'at')));
const result =
  at === undefined
    ? await showInstance(store, runtime, id)
    : await showStep(store, runtime, id, at);
```

E na USAGE, abaixo da linha de `ebb show <id>`:

```
  ebb show <id> --at <n>                a instância depois do passo n, e o porquê de cada gateway
```

Na seção Opções, troque a linha do `--at` por:

```
  --at <iso>          (tick) instante que o tick usa, em vez do relógio de parede
  --at <n>            (show, fork) o passo do journal, a partir de 1
```

- [ ] **Step 5: Rodar, gate e commit**

Run: `npx vitest run packages/cli` → PASS. `npm run verify` → PASS.

```bash
git add packages/cli
git commit -m "feat(cli): show an instance at any step with the reason for each gateway"
```

---

### Task 10: CLI — `ebb fork --at` e proveniência em `ps`/`show`

**Files:**

- Modify: `packages/cli/src/timeline.ts` (`forkAt`)
- Modify: `packages/cli/src/instances.ts` (`listInstances`, `describe`)
- Modify: `packages/cli/src/bin.ts` (`case 'fork'`, USAGE)
- Test: `packages/cli/test/timeline.test.ts`, `packages/cli/test/instances.test.ts`, `packages/cli/test/bin.test.ts`

**Interfaces:**

- Consumes: `EbbRuntime.fork`; `InstanceRecord.forkedFrom/forkedAt`
- Produces: `forkAt(store: Store, runtime: EbbRuntime, prefix: string, seq: number): Promise<CommandResult>`

- [ ] **Step 1: Testes que falham**

Em `timeline.test.ts` (acrescente `forkAt` ao import e `completeTask, listInstances, showInstance` de `'../src/instances.js'`):

```ts
describe('forkAt', () => {
  it('bifurca, imprime o id novo e o que ficou pendente, e o valor novo leva a outro ramo', async () => {
    await highApproval();

    const result = await forkAt(store, runtime, 'abc1', 1);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('abc2def');
    expect(result.output).toContain('abc1def@1');
    expect(result.output).toContain('Avaliar pedido');

    const [task] = (await runtime.inspect('abc2def')).tasks;
    const low = await completeTask(store, runtime, 'abc2', task?.tokenId ?? '', { valor: 50 });
    expect(low.output).toContain('completed');
  });

  it('sai com 1 e diz o intervalo quando o passo não existe', async () => {
    await highApproval();
    const result = await forkAt(store, runtime, 'abc1', 7);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('[1, 2]');
  });
});

describe('proveniência', () => {
  it('ps e show dizem de onde a bifurcação saiu', async () => {
    await highApproval();
    await forkAt(store, runtime, 'abc1', 1);

    expect((await listInstances(store)).output).toContain('abc1def@1');
    expect((await showInstance(store, runtime, 'abc2')).output).toContain('bifurcada de abc1def@1');
    expect((await showInstance(store, runtime, 'abc1')).output).not.toContain('bifurcada');
  });
});
```

Em `bin.test.ts`, siga o padrão do helper `ebb(...)` existente e acrescente, usando um diagrama que o arquivo já publica (confira quais existem no topo do arquivo):

```ts
it('fork e show --at recusam passo que não é inteiro positivo', async () => {
  // …deploy + start no mesmo padrão dos outros testes do arquivo…
  for (const bad of ['0', '1.5', '-1', 'x']) {
    const fork = await ebb('fork', '<id>', '--at', bad);
    expect(fork.code).toBe(2);
    expect(fork.stderr + fork.stdout).toContain('--at');
    const show = await ebb('show', '<id>', '--at', bad);
    expect(show.code).toBe(2);
  }
  const missing = await ebb('fork', '<id>');
  expect(missing.code).toBe(2);
});
```

Substitua `<id>` pelo id impresso pelo `ebb start` no próprio teste, e os nomes `code`/`stdout`/`stderr` pelos que o helper `ebb` do arquivo realmente devolve. Leia o helper antes de escrever.

Run: `npx vitest run packages/cli`
Expected: FAIL: `forkAt` não existe.

- [ ] **Step 2: `forkAt`**

Em `timeline.ts` (importe `CHECK` de `'./output.js'` e `SHORT` de `'./instances.js'`):

```ts
/** `ebb fork <id> --at <seq>` — instância nova parada no passo `seq` da original. */
export async function forkAt(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  seq: number,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const forked = await runtime.fork(instance.id, seq);
    return {
      output: [
        `${CHECK} bifurcada ${forked.instance.id} de ${instance.id.slice(0, SHORT)}@${seq} — ${forked.snapshot.status}`,
        ...pendingLines(forked.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  });
}
```

Com `SHORT = 8` e ids `abc1def` (7 caracteres), o `slice` não corta, e o teste espera `abc1def@1`.

- [ ] **Step 3: Proveniência em `ps` e `show`**

Em `instances.ts`, função auxiliar:

```ts
/** `<id-curto>@<seq>` de onde a instância foi bifurcada, ou vazio. */
function origin(instance: InstanceRecord): string {
  return instance.forkedFrom === undefined
    ? ''
    : `${instance.forkedFrom.slice(0, SHORT)}@${instance.forkedAt ?? '?'}`;
}
```

`listInstances`: acrescente `origin(entry)` ao fim de cada linha e `'ORIGEM'` ao fim dos cabeçalhos.

`describe`: logo depois do primeiro `table(...)` em `lines`:

```ts
const from = origin(instance);
if (from) lines.push(`bifurcada de ${from}`);
```

- [ ] **Step 4: `bin.ts`**

Importe `forkAt`. Novo case, depois de `show`:

```ts
      case 'fork': {
        const id = argv[1];
        if (!id || id.startsWith('--')) return usageError('Informe o id da instância.');
        const at = positiveInteger(argv, 'at');
        if (at === INVALID) return usageError(invalidOption('at', option(argv, 'at')));
        if (at === undefined) return usageError('Informe o passo com --at <n>.');
        const result = await forkAt(store, runtime, id, at);
        console.log(result.output);
        return result.exitCode;
      }
```

USAGE, abaixo de `ebb journal <id>`:

```
  ebb fork <id> --at <n>                instância nova a partir do passo n; a original não muda
```

- [ ] **Step 5: Rodar, gate e commit**

Run: `npx vitest run packages/cli` → PASS. `npm run verify` → PASS.

```bash
git add packages/cli
git commit -m "feat(cli): fork an instance at a step and show where forks came from"
```

---

### Task 11: Vitrine, roteiro e demonstração fim a fim

**Files:**

- Modify: `README.md` (bloco de comandos de instância, perto da linha 64)
- Modify: `handoff.md`
- Modify: `CLAUDE.md` (tabela de pacotes: `@ebb/runtime` ganha "replay")

- [ ] **Step 1: Demonstração real no terminal**

Num diretório temporário do scratchpad, com o `GATEWAY` salvo como `aprovacao.bpmn` (é o mesmo XML de `packages/runtime/test/fixtures.ts`; se o `deploy` recusar por aviso de validação, use `--force` e registre o aviso):

```bash
EBB=/home/bappoz/Work/personal_repos/ebb/packages/cli/dist/bin.js
node $EBB deploy aprovacao.bpmn
node $EBB start Aprovacao                       # anote <id> e o token de Avaliar
node $EBB complete <id> <token> --var valor=150
node $EBB show <id> --at 2                      # linha do Gateway_Valor com valor=150
node $EBB fork <id> --at 1                      # anote <novo>
node $EBB complete <novo> <token> --var valor=50
node $EBB show <novo>                           # completed, bifurcada de <id>@1
node $EBB ps
```

Cole a saída real no relato final. Se algum passo divergir do esperado, isso é defeito: volte à tarefa dona.

- [ ] **Step 2: README**

No bloco de comandos de instância, acrescente:

```bash
ebb show <id> --at 2                # a instância depois do passo 2, e o porquê de cada gateway
ebb fork <id> --at 1                # instância nova a partir do passo 1; a original não muda
```

E, depois do parágrafo "Mate o processo…", uma subseção curta **"Rebobinar e bifurcar"**. Três ou quatro frases: o journal reconstrói qualquer passo; o gateway mostra condição e variáveis daquele instante; a bifurcação é viva (job pendente volta para a fila). Use trechos da saída real do Step 1.

- [ ] **Step 3: `handoff.md`**

- "Onde estamos": chunks 0-2 mergeados (#1, #2); PR #58 do bpmn-flow mergeado; 3a entregue na branch `feat/replay-and-fork`; próximo passo é o 3b (`apps/console`).
- "Dívida técnica do chunk 2": remova os itens resolvidos (typecheck de teste, `as EngineState`, `db` protegido, decode UTF-8, `updated_at`, contenção, `activity.end`, este último com o número do PR da Tarefa 5). Mantenha prefixo, incidents O(n) e timeout de filho.
- "Seção 1": marque o 3a como feito, com os itens 1, 2, 3 e 5 entregues e o "achado do bump" resolvido pelo fallback. Deixe o item 4 (`apps/console`) como 3b, com a nota de que `EbbRuntime.replay` devolve `{ instance, xml, steps }` em uma chamada, e que os passos têm `flows` e `decisions` prontos para `markFlowTaken` do viewer.
- "O que isto cobra do bpmn-flow" no design geral ficou resolvido. Anote isso na Seção 1.

- [ ] **Step 4: Gate final e commit**

Run: `npm run verify` → PASS. Cole o resumo de cobertura no relato.

```bash
git add README.md handoff.md CLAUDE.md
git commit -m "docs: document replay and fork, and hand off to chunk 3b"
```

- [ ] **Step 5: PR (com confirmação)**

Push e PR são ações externas: confirme com o usuário antes. O corpo segue o formato dos PRs #1 e #2 ("O que muda", "Verificação", "Fica para depois") e termina com `https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb`.

```bash
git push -u origin feat/replay-and-fork
gh pr create -R Bappoz/ebb --base master --title "feat: chunk 3a — replay and fork" --body-file <arquivo no scratchpad>
```
