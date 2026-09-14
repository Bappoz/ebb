# Chunk 1 — runtime durável + journal: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma instância de processo sobrevive à morte do processo do sistema
operacional: `ebb start` cria, o processo acaba, `ebb show` vê o mesmo estado,
`ebb complete` continua de onde parou — e todo comando aplicado fica gravado
num journal replayável.

**Architecture:** Comando é dado (`InstanceCommand`), aplicado por uma única
função (`applyCommand`) que a execução ao vivo e o replay do chunk 3
compartilham. `@ebb/runtime` não guarda estado entre comandos: re-hidrata do
snapshot, aplica, grava e descarta o motor. `@ebb/store` grava entrada do
journal e snapshot na mesma transação. O relógio do motor é congelado por
comando, e o instante congelado é o que o journal guarda.

**Tech Stack:** TypeScript strict, Node ≥ 24, `node:sqlite`, `@bpmn-flow/core`,
Vitest, tsup (`bundle: false`), npm workspaces.

**Spec:** [`docs/superpowers/specs/2026-09-14-ebb-chunk-1-runtime-journal.md`](../specs/2026-09-14-ebb-chunk-1-runtime-journal.md)

## Global Constraints

- **Node ≥ 24.** `node:sqlite` sem flag é o que sustenta "sobe sem infraestrutura".
- **Sem dependência nova.** Nenhuma das tarefas adiciona pacote de runtime.
  `@ebb/runtime` depende só de `@bpmn-flow/core` e `@ebb/store`.
- **`bundle: false`** em todo `tsup.config.ts`: o esbuild normaliza
  `node:sqlite` para `sqlite`, que não resolve, e só o binário construído mostra.
- **Linha de SQLite não vira tipo por `as`** — passa por
  `packages/store/src/rows.ts` ou estende o padrão dele.
- **`noUncheckedIndexedAccess: true`**: `array[0]` é `T | undefined`. Use
  desestruturação com guarda, não `!`.
- **`verbatimModuleSyntax` + `consistent-type-imports`**: tipo se importa com
  `import type`.
- **Limiares de cobertura** (`vitest.config.ts`, `all: true` sobre
  `packages/*/src/**/*.ts`, exceto `**/src/bin.ts`): statements 90, branches
  **85**, functions 90, lines 90. A base está em 85.57 de branches — arquivo
  novo sem teste derruba o `verify`.
- **Gate**: `npm run verify` (build → format:check → lint → typecheck →
  coverage) verde antes de cada commit.
- **`@ebb/runtime` e `@ebb/cli` importam `@ebb/store` pelo `dist`**, como os
  testes do chunk 0 já fazem. Um `npx vitest` solto não reconstrói nada: rode
  `npm run build` antes quando tiver acabado de mexer num pacote de que o teste
  depende (`npm test` e `npm run coverage` já buildam sozinhos).
- **Armadilha de shell**: o Bash não carrega o `.zshrc`. Antes de qualquer
  `npm`/`npx`: `unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH`.
- **Idioma**: identificador, docstring e commit em inglês; comentário
  explicativo, saída do CLI e documento em PT-BR — como o código já está.
- Branch: `feat/runtime-and-journal`. Um commit por tarefa, Conventional
  Commits, terminando com `Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb`.

## Estrutura de arquivos

```
packages/store/src/
  tx.ts           NOVO  transaction(db, fn) — BEGIN/COMMIT/ROLLBACK
  instances.ts    NOVO  mapeadores linha→objeto das três tabelas novas
  types.ts        +     tipos de instância, journal, snapshot; Store estendida
  migrations.ts   +     migração 2; migrate() passa a usar transaction()
  rows.ts         +     isRecord / jsonObject
  sqlite.ts       +     as sete operações novas, com o ponto de falha protegido
  index.ts        +     reexporta o que é novo

packages/runtime/  NOVO PACOTE
  package.json · tsconfig.json · tsconfig.lint.json · tsup.config.ts · vitest.config.ts
  src/commands.ts  InstanceCommand, applyCommand, payloadOf
  src/errors.ts    InstanceNotFoundError, EngineStateMismatchError
  src/runtime.ts   EbbRuntime: start / apply / inspect
  src/index.ts

packages/cli/src/
  output.ts       NOVO  CHECK/CROSS/WARN/table — movidos de commands.ts
  vars.ts         NOVO  parseVars
  instances.ts    NOVO  start, ps, show, complete, signal, tick, journal
  commands.ts     -     passa a importar de output.ts
  bin.ts          +     roteamento e USAGE
```

---

### Task 1: transação e esquema

**Files:**

- Create: `packages/store/src/tx.ts`
- Create: `packages/store/test/tx.test.ts`
- Modify: `packages/store/src/migrations.ts`
- Test: `packages/store/test/sqlite.test.ts` (acrescenta um caso)

**Interfaces:**

- Consumes: nada.
- Produces: `transaction<T>(db: DatabaseSync, fn: () => T): T`;
  `SCHEMA_VERSION === 2`; as tabelas `instances`, `instance_journal`,
  `instance_state`.

- [ ] **Step 1: Write the failing test**

Crie `packages/store/test/tx.test.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { transaction } from '../src/tx.js';

function db(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE t (x INTEGER)');
  return database;
}

describe('transaction', () => {
  it('devolve o valor da função e mantém o que ela escreveu', () => {
    const database = db();
    const written = transaction(database, () => {
      database.prepare('INSERT INTO t (x) VALUES (1)').run();
      return 'pronto';
    });

    expect(written).toBe('pronto');
    expect(database.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  it('desfaz o que a função escreveu quando ela lança', () => {
    const database = db();

    expect(() =>
      transaction(database, () => {
        database.prepare('INSERT INTO t (x) VALUES (1)').run();
        throw new Error('meio do caminho');
      }),
    ).toThrow('meio do caminho');

    // O ponto inteiro: a primeira escrita não pode sobreviver à segunda falhar.
    expect(database.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
  });
});
```

E em `packages/store/test/sqlite.test.ts`, acrescente dentro de
`describe('SqliteStore', ...)`:

```ts
it('aplica a migração das tabelas de instância', async () => {
  const store = new SqliteStore({ path: join(dir, 'ebb.db') });
  await store.deploy(input(XML_V1));
  store.close();

  const raw = new DatabaseSync(join(dir, 'ebb.db'));
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  raw.close();

  expect(SCHEMA_VERSION).toBe(2);
  expect(tables).toContain('instances');
  expect(tables).toContain('instance_journal');
  expect(tables).toContain('instance_state');
});
```

Acrescente `import { DatabaseSync } from 'node:sqlite';` ao topo do arquivo.

- [ ] **Step 2: Run test to verify it fails**

```bash
unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH
npx vitest run packages/store/test/tx.test.ts packages/store/test/sqlite.test.ts
```

Esperado: FAIL — `Cannot find module '../src/tx.js'` e `expected 1 to be 2`.

- [ ] **Step 3: Write minimal implementation**

`packages/store/src/tx.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';

/**
 * Roda `fn` numa transação, desfazendo o que ela escreveu quando ela lança.
 *
 * Existe porque a entrada do journal e o snapshot que ela produziu têm de ser
 * gravados juntos ou não serem gravados: uma instância cujo journal passou do
 * seu estado (ou o contrário) não dá para retomar nem para replayar.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

Em `packages/store/src/migrations.ts`: importe `transaction` e troque o
`BEGIN`/`try`/`COMMIT`/`ROLLBACK` manual do laço por ele — é o mesmo código.

```ts
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './tx.js';
```

```ts
const record = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
for (const migration of MIGRATIONS) {
  if (migration.version <= current) continue;
  transaction(db, () => {
    db.exec(migration.up);
    record.run(migration.version, new Date().toISOString());
  });
}
return SCHEMA_VERSION;
```

E acrescente a migração 2 ao array `MIGRATIONS`, depois da 1:

```ts
  {
    version: 2,
    name: 'instances',
    up: `
      CREATE TABLE instances (
        id           TEXT PRIMARY KEY,
        process_key  TEXT    NOT NULL,
        version      INTEGER NOT NULL,
        status       TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        FOREIGN KEY (process_key, version) REFERENCES deployments (process_key, version)
      );
      CREATE INDEX instances_process ON instances (process_key, created_at DESC);

      CREATE TABLE instance_journal (
        instance_id  TEXT    NOT NULL,
        seq          INTEGER NOT NULL,
        type         TEXT    NOT NULL,
        payload      TEXT    NOT NULL,
        at           INTEGER NOT NULL,
        recorded_at  TEXT    NOT NULL,
        PRIMARY KEY (instance_id, seq),
        FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
      );

      CREATE TABLE instance_state (
        instance_id     TEXT PRIMARY KEY,
        seq             INTEGER NOT NULL,
        engine_version  INTEGER NOT NULL,
        state           TEXT    NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
      );
    `,
  },
```

Comente no array, acima da migração 2, o porquê que não está no SQL:

```ts
// `version` fica congelada na instância de propósito: um redeploy não pode
// trocar o modelo debaixo de uma instância viva. `at` é o relógio do motor,
// que o replay reinjeta; `recorded_at` é o relógio de parede, que só serve
// para auditoria — os dois divergem num tick com instante explícito.
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/store/test/tx.test.ts packages/store/test/sqlite.test.ts
```

Esperado: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src/tx.ts packages/store/src/migrations.ts \
        packages/store/test/tx.test.ts packages/store/test/sqlite.test.ts
git commit -m "$(cat <<'EOF'
feat(store): add the instance, journal and snapshot tables

A journal entry and the engine snapshot it produced have to be written
together or not at all, so the transaction helper lands with the schema that
needs it; migrate() now shares it instead of repeating BEGIN/COMMIT/ROLLBACK.

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb
EOF
)"
```

---

### Task 2: escrita de instância, atômica

**Files:**

- Create: `packages/store/src/instances.ts`
- Modify: `packages/store/src/types.ts`, `packages/store/src/rows.ts`,
  `packages/store/src/sqlite.ts`, `packages/store/src/index.ts`
- Test: `packages/store/test/instances.test.ts` (criar)

**Interfaces:**

- Consumes: `transaction` da Task 1.
- Produces: `InstanceStatus`, `InstanceRecord`, `JournalEntry`, `CommandInput`,
  `EngineStateInput`, `StoredEngineState`, `CreateInstanceInput`, `AppendInput`;
  `Store.createInstance`, `Store.append`, `Store.readInstance`,
  `Store.readInstanceState`; `SqliteStore.writeEngineState` (protegido, é o
  ponto de falha que o teste de atomicidade usa).

- [ ] **Step 1: Write the failing test**

Crie `packages/store/test/instances.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksumOf } from '../src/checksum.js';
import { SqliteStore } from '../src/sqlite.js';
import type { EngineStateInput } from '../src/types.js';

const XML = '<definitions><process id="Pedido" /></definitions>';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-instances-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Uma loja com o processo `Pedido` v1 já publicado. */
async function seeded(store: SqliteStore): Promise<SqliteStore> {
  await store.deploy({ processKey: 'Pedido', xml: XML, checksum: checksumOf(XML) });
  return store;
}

function creation(id = 'i1') {
  return {
    id,
    processKey: 'Pedido',
    version: 1,
    status: 'waiting' as const,
    command: { type: 'start', payload: { variables: { total: 42 } }, at: 1_700_000_000_000 },
    state: { engineVersion: 10, json: '{"version":10,"steps":1}' },
  };
}

describe('escrita de instância', () => {
  it('cria a linha, a primeira entrada do journal e o estado de uma vez', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    const instance = await store.createInstance(creation());

    expect(instance).toMatchObject({ id: 'i1', processKey: 'Pedido', version: 1, seq: 1 });
    expect(await store.readInstance('i1')).toMatchObject({ status: 'waiting', seq: 1 });
    expect(await store.readInstanceState('i1')).toEqual({
      seq: 1,
      engineVersion: 10,
      json: '{"version":10,"steps":1}',
    });
    store.close();
  });

  it('numera cada comando aplicado a partir de 1', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await store.createInstance(creation());

    const after = await store.append({
      instanceId: 'i1',
      status: 'completed',
      command: { type: 'completeTask', payload: { tokenId: 't1' }, at: 1_700_000_001_000 },
      state: { engineVersion: 10, json: '{"version":10,"steps":2}' },
    });

    expect(after).toMatchObject({ seq: 2, status: 'completed' });
    expect(await store.readInstanceState('i1')).toMatchObject({ seq: 2 });
    store.close();
  });

  it('recusa uma instância de uma versão que não está publicada', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await expect(store.createInstance({ ...creation(), version: 7 })).rejects.toThrow();
    store.close();
  });

  it('não avança journal nem estado quando a escrita falha no meio', async () => {
    /** Grava o primeiro estado e falha do segundo em diante. */
    class FailsOnSecondState extends SqliteStore {
      private writes = 0;

      protected override writeEngineState(
        instanceId: string,
        seq: number,
        state: EngineStateInput,
      ): void {
        this.writes += 1;
        if (this.writes > 1) throw new Error('disco cheio no meio da escrita');
        super.writeEngineState(instanceId, seq, state);
      }
    }

    const store = await seeded(new FailsOnSecondState({ path: join(dir, 'ebb.db') }));
    await store.createInstance(creation());

    await expect(
      store.append({
        instanceId: 'i1',
        status: 'completed',
        command: { type: 'completeTask', payload: { tokenId: 't1' }, at: 1_700_000_001_000 },
        state: { engineVersion: 10, json: '{"version":10,"steps":2}' },
      }),
    ).rejects.toThrow('disco cheio');

    // Nem um nem o outro: a entrada do journal não pode sobreviver ao estado
    // que ela deveria ter produzido.
    expect(await store.readInstance('i1')).toMatchObject({ seq: 1, status: 'waiting' });
    expect(await store.readInstanceState('i1')).toMatchObject({ seq: 1 });
    expect(await store.journal('i1')).toHaveLength(1);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/store/test/instances.test.ts
```

Esperado: FAIL — `store.createInstance is not a function`.

- [ ] **Step 3: Write minimal implementation**

Em `packages/store/src/rows.ts`, acrescente ao final:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coluna de texto que guarda um objeto JSON. O `JSON.parse` devolve `any`, e
 * aceitar isso seria o mesmo `as` que este módulo existe para evitar.
 */
export function jsonObject(row: Row, column: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text(row, column));
  if (!isRecord(parsed)) throw new TypeError(`Coluna "${column}" deveria ser um objeto JSON.`);
  return parsed;
}
```

Em `packages/store/src/types.ts`, acrescente antes da interface `Store`:

```ts
/**
 * O estado de execução de uma instância.
 *
 * Repete `ExecutionStatus` do `@bpmn-flow/core` de propósito: o store é
 * persistência e não conhece o motor. Os dois conjuntos têm de continuar
 * iguais, e é o `@ebb/runtime` que falha em compilar se divergirem, ao atribuir
 * um ao outro.
 */
export type InstanceStatus = 'idle' | 'running' | 'waiting' | 'completed' | 'terminated' | 'failed';

/** Uma instância de processo em execução (ou já terminada). */
export interface InstanceRecord {
  id: string;
  processKey: string;
  /** A versão publicada com que ela começou, congelada aqui. */
  version: number;
  status: InstanceStatus;
  /** Número do último comando aplicado; o primeiro é 1. */
  seq: number;
  createdAt: string;
  updatedAt: string;
}

/** Um comando aplicado a uma instância, como o journal o guarda. */
export interface JournalEntry {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  /** Relógio do motor, epoch ms — é isto que o replay reinjeta. */
  at: number;
  /** Relógio de parede, ISO-8601. Só serve para auditoria. */
  recordedAt: string;
}

/** O comando a gravar, sem o número de sequência, que é do store. */
export interface CommandInput {
  type: string;
  payload: Record<string, unknown>;
  at: number;
}

/**
 * O snapshot do motor, já serializado: o store guarda texto e um número de
 * versão de esquema, e não sabe o que há dentro.
 */
export interface EngineStateInput {
  engineVersion: number;
  json: string;
}

export interface StoredEngineState extends EngineStateInput {
  /** O comando que produziu este estado. */
  seq: number;
}

export interface CreateInstanceInput {
  id: string;
  processKey: string;
  version: number;
  status: InstanceStatus;
  command: CommandInput;
  state: EngineStateInput;
}

export interface AppendInput {
  instanceId: string;
  status: InstanceStatus;
  command: CommandInput;
  state: EngineStateInput;
}
```

E acrescente à interface `Store`, antes de `close()`:

```ts
  /**
   * Cria uma instância: a linha, a primeira entrada do journal (`seq` 1) e o
   * estado que ela produziu — numa transação só.
   */
  createInstance(input: CreateInstanceInput): Promise<InstanceRecord>;

  /**
   * Grava mais um comando aplicado: a entrada do journal, o estado resultante
   * e a linha da instância — numa transação só.
   */
  append(input: AppendInput): Promise<InstanceRecord>;

  readInstance(id: string): Promise<InstanceRecord | undefined>;

  readInstanceState(id: string): Promise<StoredEngineState | undefined>;

  /** O journal de uma instância, do primeiro comando ao último. */
  journal(id: string): Promise<JournalEntry[]>;
```

Crie `packages/store/src/instances.ts`:

```ts
import { integer, jsonObject, text, type Row } from './rows.js';
import type { InstanceRecord, InstanceStatus, JournalEntry, StoredEngineState } from './types.js';

const STATUSES: readonly InstanceStatus[] = [
  'idle',
  'running',
  'waiting',
  'completed',
  'terminated',
  'failed',
];

/** Estado vindo do banco, conferido contra o conjunto que este código conhece. */
function status(row: Row): InstanceStatus {
  const value = text(row, 'status');
  const known = STATUSES.find((candidate) => candidate === value);
  if (!known) throw new TypeError(`Coluna "status" trouxe um estado desconhecido: "${value}".`);
  return known;
}

export function toInstance(row: Row): InstanceRecord {
  return {
    id: text(row, 'id'),
    processKey: text(row, 'process_key'),
    version: integer(row, 'version'),
    status: status(row),
    seq: integer(row, 'seq'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function toJournalEntry(row: Row): JournalEntry {
  return {
    seq: integer(row, 'seq'),
    type: text(row, 'type'),
    payload: jsonObject(row, 'payload'),
    at: integer(row, 'at'),
    recordedAt: text(row, 'recorded_at'),
  };
}

export function toStoredState(row: Row): StoredEngineState {
  return {
    seq: integer(row, 'seq'),
    engineVersion: integer(row, 'engine_version'),
    json: text(row, 'state'),
  };
}
```

Em `packages/store/src/sqlite.ts`, importe o que é novo, acrescente o auxiliar
de módulo abaixo (junto de `toDeployment`/`toSummary`) e os métodos à classe,
antes de `close()`:

```ts
/**
 * Entrega um resultado síncrono como a interface promete — o erro inclusive.
 *
 * `createInstance` e `append` falham de verdade (chave estrangeira, disco), e
 * um método que às vezes lança e às vezes rejeita quebraria quem usa `.catch()`
 * e a implementação Postgres que um dia vai rejeitar sempre.
 */
function promised<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
```

```ts
import { toInstance, toJournalEntry, toStoredState } from './instances.js';
import { transaction } from './tx.js';
import type {
  AppendInput,
  CommandInput,
  CreateInstanceInput,
  EngineStateInput,
  InstanceRecord,
  JournalEntry,
  StoredEngineState,
} from './types.js';
```

```ts
  createInstance(input: CreateInstanceInput): Promise<InstanceRecord> {
    const at = this.now().toISOString();
    return promised(() =>
      transaction(this.db, () => {
        this.db
          .prepare(
            `INSERT INTO instances (id, process_key, version, status, seq, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(input.id, input.processKey, input.version, input.status, at, at);
        this.writeJournal(input.id, 1, input.command);
        this.writeEngineState(input.id, 1, input.state);
        return this.instanceRow(input.id);
      }),
    );
  }

  append(input: AppendInput): Promise<InstanceRecord> {
    return promised(() => {
      const seq = this.instanceRow(input.instanceId).seq + 1;
      return transaction(this.db, () => {
        this.writeJournal(input.instanceId, seq, input.command);
        this.writeEngineState(input.instanceId, seq, input.state);
        this.db
          .prepare('UPDATE instances SET status = ?, seq = ?, updated_at = ? WHERE id = ?')
          .run(input.status, seq, this.now().toISOString(), input.instanceId);
        return this.instanceRow(input.instanceId);
      });
    });
  }

  readInstance(id: string): Promise<InstanceRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    return Promise.resolve(row ? toInstance(row) : undefined);
  }

  readInstanceState(id: string): Promise<StoredEngineState | undefined> {
    const row = this.db.prepare('SELECT * FROM instance_state WHERE instance_id = ?').get(id);
    return Promise.resolve(row ? toStoredState(row) : undefined);
  }

  journal(id: string): Promise<JournalEntry[]> {
    const rows = this.db
      .prepare('SELECT * FROM instance_journal WHERE instance_id = ? ORDER BY seq')
      .all(id);
    return Promise.resolve(rows.map(toJournalEntry));
  }

  /**
   * A escrita do snapshot, separada por ser o passo que o teste de atomicidade
   * faz falhar: o journal já foi escrito quando ela roda, e é isso que a
   * transação tem de desfazer.
   */
  protected writeEngineState(instanceId: string, seq: number, state: EngineStateInput): void {
    this.db
      .prepare(
        `INSERT INTO instance_state (instance_id, seq, engine_version, state)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (instance_id) DO UPDATE SET seq = excluded.seq,
           engine_version = excluded.engine_version, state = excluded.state`,
      )
      .run(instanceId, seq, state.engineVersion, state.json);
  }

  private writeJournal(instanceId: string, seq: number, command: CommandInput): void {
    this.db
      .prepare(
        `INSERT INTO instance_journal (instance_id, seq, type, payload, at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instanceId,
        seq,
        command.type,
        JSON.stringify(command.payload),
        command.at,
        this.now().toISOString(),
      );
  }

  private instanceRow(id: string): InstanceRecord {
    const row = this.db.prepare('SELECT * FROM instances WHERE id = ?').get(id);
    if (!row) throw new Error(`Nenhuma instância com o id "${id}".`);
    return toInstance(row);
  }
```

Em `packages/store/src/index.ts`, acrescente:

```ts
export { transaction } from './tx.js';
export type {
  AppendInput,
  CommandInput,
  CreateInstanceInput,
  EngineStateInput,
  InstanceRecord,
  InstanceStatus,
  JournalEntry,
  StoredEngineState,
} from './types.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/store/test/instances.test.ts
```

Esperado: PASS, 4 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src packages/store/test/instances.test.ts
git commit -m "$(cat <<'EOF'
feat(store): persist an instance, its journal and its snapshot atomically

createInstance and append each write the journal entry, the engine snapshot
and the instance row in one transaction. writeEngineState is protected so a
test can make it fail after the journal insert and prove neither advanced —
an instance whose journal ran ahead of its state can be neither resumed nor
replayed.

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb
EOF
)"
```

---

### Task 3: consulta de instância

**Files:**

- Modify: `packages/store/src/types.ts`, `packages/store/src/sqlite.ts`
- Test: `packages/store/test/instances.test.ts`

**Interfaces:**

- Consumes: `toInstance` da Task 2.
- Produces: `Store.listInstances(): Promise<InstanceRecord[]>`,
  `Store.findInstances(prefix: string): Promise<InstanceRecord[]>`.

- [ ] **Step 1: Write the failing test**

Acrescente a `packages/store/test/instances.test.ts`:

```ts
describe('consulta de instância', () => {
  it('lista da mais nova para a mais antiga', async () => {
    let tick = 0;
    const store = await seeded(
      new SqliteStore({ path: ':memory:', now: () => new Date(1_700_000_000_000 + tick++ * 1000) }),
    );
    await store.createInstance(creation('aaa1'));
    await store.createInstance(creation('bbb2'));

    expect((await store.listInstances()).map((entry) => entry.id)).toEqual(['bbb2', 'aaa1']);
    store.close();
  });

  it('acha por prefixo e devolve todas as ambíguas', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await store.createInstance(creation('ab11'));
    await store.createInstance(creation('ab22'));
    await store.createInstance(creation('cd33'));

    expect((await store.findInstances('ab')).map((entry) => entry.id).sort()).toEqual([
      'ab11',
      'ab22',
    ]);
    expect(await store.findInstances('cd33')).toHaveLength(1);
    expect(await store.findInstances('zz')).toEqual([]);
    store.close();
  });

  it('trata o prefixo como texto, não como padrão de LIKE', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await store.createInstance(creation('ab11'));

    // `_` e `%` casariam com qualquer coisa num LIKE; aqui não casam com nada.
    expect(await store.findInstances('a_')).toEqual([]);
    expect(await store.findInstances('%')).toEqual([]);
    store.close();
  });

  it('devolve o journal na ordem em que os comandos foram aplicados', async () => {
    const store = await seeded(new SqliteStore({ path: ':memory:' }));
    await store.createInstance(creation());
    await store.append({
      instanceId: 'i1',
      status: 'completed',
      command: { type: 'completeTask', payload: { tokenId: 't1' }, at: 1_700_000_001_000 },
      state: { engineVersion: 10, json: '{}' },
    });

    const entries = await store.journal('i1');
    expect(entries.map((entry) => [entry.seq, entry.type])).toEqual([
      [1, 'start'],
      [2, 'completeTask'],
    ]);
    expect(entries[0]?.payload).toEqual({ variables: { total: 42 } });
    expect(entries[0]?.at).toBe(1_700_000_000_000);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/store/test/instances.test.ts
```

Esperado: FAIL — `store.listInstances is not a function`.

- [ ] **Step 3: Write minimal implementation**

Em `packages/store/src/types.ts`, acrescente à interface `Store`:

```ts
  /** Toda instância, da mais nova para a mais antiga. */
  listInstances(): Promise<InstanceRecord[]>;

  /**
   * Instâncias cujo id começa por `prefix`, para que o CLI aceite um prefixo
   * curto como o git. Vazio quando nenhuma casa.
   */
  findInstances(prefix: string): Promise<InstanceRecord[]>;
```

Em `packages/store/src/sqlite.ts`, acrescente à classe:

```ts
  listInstances(): Promise<InstanceRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM instances ORDER BY created_at DESC, id DESC')
      .all();
    return Promise.resolve(rows.map(toInstance));
  }

  findInstances(prefix: string): Promise<InstanceRecord[]> {
    // `substr` em vez de `LIKE`: num LIKE o `_` e o `%` que o usuário digitasse
    // virariam curinga, e um prefixo não é um padrão.
    const rows = this.db
      .prepare('SELECT * FROM instances WHERE substr(id, 1, length(?)) = ? ORDER BY id')
      .all(prefix, prefix);
    return Promise.resolve(rows.map(toInstance));
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/store/test/instances.test.ts
npm run verify
```

Esperado: PASS; `verify` exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/store/src packages/store/test/instances.test.ts
git commit -m "$(cat <<'EOF'
feat(store): list instances and resolve one by id prefix

findInstances matches with substr rather than LIKE: a prefix is not a pattern,
and an underscore the user typed would otherwise be a wildcard.

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb
EOF
)"
```

---

### Task 4: `@ebb/runtime` e o comando como dado

**Files:**

- Create: `packages/runtime/package.json`, `packages/runtime/tsconfig.json`,
  `packages/runtime/tsconfig.lint.json`, `packages/runtime/tsup.config.ts`,
  `packages/runtime/vitest.config.ts`, `packages/runtime/src/commands.ts`,
  `packages/runtime/src/errors.ts`, `packages/runtime/src/index.ts`
- Modify: `package.json` (raiz, script `build`)
- Test: `packages/runtime/test/commands.test.ts`

**Interfaces:**

- Consumes: `WorkflowEngine`, `ExecutionSnapshot` do `@bpmn-flow/core`.
- Produces: `InstanceCommand` (união discriminada com `start`, `completeTask`,
  `signal`, `tick`), `applyCommand(engine, command): Promise<ExecutionSnapshot>`,
  `payloadOf(command): Record<string, unknown>`, `InstanceNotFoundError`,
  `EngineStateMismatchError`.

- [ ] **Step 1: Write the failing test**

Crie os arquivos de andaime primeiro (não são passo separado: sem eles o teste
nem roda).

`packages/runtime/package.json`:

```json
{
  "name": "@ebb/runtime",
  "version": "0.0.0",
  "description": "Instance lifecycle for ebb: applies a command to a process, journals it, and persists the state it produced.",
  "type": "module",
  "license": "Apache-2.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@bpmn-flow/core": "file:../../../bpmn-flow/packages/core",
    "@ebb/store": "^0.0.0"
  }
}
```

`packages/runtime/tsconfig.json`, `tsconfig.lint.json`, `tsup.config.ts` e
`vitest.config.ts`: copie os de `packages/store/` sem alterar nada — são
idênticos.

Acrescente `@ebb/runtime` ao `build` da raiz, **entre** store e cli, porque o
cli vai depender dele:

```json
    "build": "npm run build -w @ebb/store && npm run build -w @ebb/runtime && npm run build -w @ebb/cli",
```

Instale para criar o link do workspace:

```bash
unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH
npm install
```

Crie `packages/runtime/test/commands.test.ts`:

```ts
import { parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type { ProcessModel } from '@bpmn-flow/core';
import { describe, expect, it } from 'vitest';
import { applyCommand, payloadOf } from '../src/commands.js';

const PEDIDO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" name="Processo de Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

async function pedido(): Promise<ProcessModel> {
  const [first] = (await parseBpmn(PEDIDO)).processes;
  if (!first) throw new Error('fixture sem processo');
  return first;
}

describe('applyCommand', () => {
  it('start leva a execução até o primeiro ponto de espera', async () => {
    const engine = new WorkflowEngine(await pedido(), { variables: { total: 42 } });
    const snapshot = await applyCommand(engine, { type: 'start', variables: { total: 42 } });

    expect(snapshot.status).toBe('waiting');
    expect(snapshot.variables).toMatchObject({ total: 42 });
  });

  it('completeTask conclui a tarefa parada e segue', async () => {
    const engine = new WorkflowEngine(await pedido());
    await applyCommand(engine, { type: 'start' });
    const [task] = engine.tasks();
    if (!task) throw new Error('nenhuma tarefa pendente');

    const snapshot = await applyCommand(engine, {
      type: 'completeTask',
      tokenId: task.tokenId,
      output: { separadoPor: 'ana' },
    });

    expect(snapshot.status).toBe('completed');
    expect(snapshot.variables).toMatchObject({ separadoPor: 'ana' });
  });

  it('tick usa o relógio congelado do motor, sem argumento próprio', async () => {
    const engine = new WorkflowEngine(await pedido(), { now: () => 1_700_000_000_000 });
    await applyCommand(engine, { type: 'start' });

    // Nada vencido: tick é uma não-operação, e não pode explodir por isso.
    const snapshot = await applyCommand(engine, { type: 'tick' });
    expect(snapshot.status).toBe('waiting');
  });

  it('signal recusa um evento que o diagrama não tem', async () => {
    const engine = new WorkflowEngine(await pedido());
    await applyCommand(engine, { type: 'start' });

    await expect(applyCommand(engine, { type: 'signal', name: 'Inexistente' })).rejects.toThrow();
  });
});

describe('payloadOf', () => {
  it('tira o tipo, que o journal guarda na coluna própria', () => {
    expect(payloadOf({ type: 'completeTask', tokenId: 't1', output: { a: 1 } })).toEqual({
      tokenId: 't1',
      output: { a: 1 },
    });
    expect(payloadOf({ type: 'tick' })).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/runtime/test/commands.test.ts
```

Esperado: FAIL — `Cannot find module '../src/commands.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/runtime/src/commands.ts`:

```ts
import type { ExecutionSnapshot, WorkflowEngine } from '@bpmn-flow/core';

/**
 * Tudo que muda uma instância, como dado.
 *
 * É o que faz o time-travel possível: a execução ao vivo e o replay do journal
 * passam os dois por {@link applyCommand}, então um comando gravado significa
 * exatamente o que significou quando foi aplicado.
 */
export type InstanceCommand =
  | { type: 'start'; variables?: Record<string, unknown> }
  | { type: 'completeTask'; tokenId: string; output?: Record<string, unknown> }
  | { type: 'signal'; name: string; output?: Record<string, unknown> }
  | { type: 'tick' };

export type CommandType = InstanceCommand['type'];

/** Aplica um comando ao motor. O único caminho — ao vivo e no replay. */
export function applyCommand(
  engine: WorkflowEngine,
  command: InstanceCommand,
): Promise<ExecutionSnapshot> {
  switch (command.type) {
    case 'start':
      // As variáveis iniciais entram na construção do motor, não aqui. Elas
      // ficam no payload porque o replay precisa construir o mesmo motor.
      return engine.start();
    case 'completeTask':
      return engine.completeTask(command.tokenId, command.output);
    case 'signal':
      return engine.signal(command.name, command.output);
    case 'tick':
      // Sem argumento de propósito: o relógio do motor já está congelado no
      // instante que o journal gravou.
      return engine.tick();
  }
}

/** O comando sem o tipo, que o journal guarda numa coluna própria. */
export function payloadOf(command: InstanceCommand): Record<string, unknown> {
  const { type: _type, ...payload } = command;
  return payload;
}
```

`packages/runtime/src/errors.ts`:

```ts
/** A instância pedida não existe. */
export class InstanceNotFoundError extends Error {
  constructor(readonly instanceId: string) {
    super(`Nenhuma instância com o id "${instanceId}".`);
    this.name = 'InstanceNotFoundError';
  }
}

/**
 * O snapshot foi gravado por um motor de outro esquema.
 *
 * Vale a mensagem própria em vez da do motor porque a diferença importa: o
 * snapshot é cache e o journal é a verdade, então a instância não está
 * perdida — só não dá para retomá-la pelo atalho.
 */
export class EngineStateMismatchError extends Error {
  constructor(
    readonly instanceId: string,
    readonly stored: number,
    readonly expected: number,
  ) {
    super(
      `A instância ${instanceId} foi gravada com o esquema de motor ${stored} e este ebb usa o ${expected}. ` +
        'O journal está intacto — o replay poderá reconstruí-la; retomar pelo snapshot, não.',
    );
    this.name = 'EngineStateMismatchError';
  }
}
```

`packages/runtime/src/index.ts`:

```ts
export { applyCommand, payloadOf } from './commands.js';
export type { CommandType, InstanceCommand } from './commands.js';
export { EngineStateMismatchError, InstanceNotFoundError } from './errors.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/runtime/test/commands.test.ts
```

Esperado: PASS, 5 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(runtime): add @ebb/runtime and the command-as-data surface

Every mutation to an instance is a value, and applyCommand is the single place
that turns one into an engine call. Live execution and the journal replay of
chunk 3 both go through it, which is what makes a recorded command mean the
same thing later as it did when it was applied.

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb
EOF
)"
```

---

### Task 5: `EbbRuntime` — ciclo de vida e relógio congelado

**Files:**

- Create: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/runtime.test.ts`

**Interfaces:**

- Consumes: `applyCommand`, `payloadOf`, os dois erros (Task 4);
  `Store.createInstance/append/readInstance/readInstanceState/journal` (Tasks 2-3).
- Produces:
  - `EbbRuntime` com `start(processKey, options?): Promise<CommandResult>`,
    `apply(instanceId, command, at?): Promise<CommandResult>`,
    `inspect(instanceId): Promise<InstanceView>`.
  - `EbbRuntimeOptions { store: Store; now?: () => Date; newId?: () => string }`
  - `StartOptions { version?: number; variables?: Record<string, unknown> }`
  - `CommandResult { instance: InstanceRecord; snapshot: ExecutionSnapshot; tasks: PendingTask[] }`
  - `InstanceView extends CommandResult { journal: JournalEntry[] }`

- [ ] **Step 1: Write the failing test**

Crie `packages/runtime/test/runtime.test.ts`:

```ts
import { ENGINE_STATE_VERSION } from '@bpmn-flow/core';
import { checksumOf, SqliteStore } from '@ebb/store';
import { describe, expect, it } from 'vitest';
import { EngineStateMismatchError, InstanceNotFoundError } from '../src/errors.js';
import { EbbRuntime } from '../src/runtime.js';

const PEDIDO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" name="Processo de Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const AT = 1_700_000_000_000;

/** Uma loja com o `Pedido` publicado e um runtime de relógio e id fixos. */
async function fixture(): Promise<{ store: SqliteStore; runtime: EbbRuntime }> {
  const store = new SqliteStore({ path: ':memory:', now: () => new Date(AT) });
  await store.deploy({ processKey: 'Pedido', xml: PEDIDO, checksum: checksumOf(PEDIDO) });
  let ids = 0;
  const runtime = new EbbRuntime({
    store,
    now: () => new Date(AT),
    newId: () => `inst-${++ids}`,
  });
  return { store, runtime };
}

describe('EbbRuntime.start', () => {
  it('cria a instância parada na tarefa, com as variáveis iniciais', async () => {
    const { store, runtime } = await fixture();
    const result = await runtime.start('Pedido', { variables: { total: 42 } });

    expect(result.instance).toMatchObject({
      id: 'inst-1',
      processKey: 'Pedido',
      version: 1,
      seq: 1,
    });
    expect(result.snapshot.status).toBe('waiting');
    expect(result.tasks.map((task) => task.nodeId)).toEqual(['Separar']);
    expect(result.snapshot.variables).toMatchObject({ total: 42 });
    store.close();
  });

  it('grava o comando start com as variáveis, para o replay reconstruir o motor', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido', { variables: { total: 42 } });

    const [first] = await store.journal('inst-1');
    expect(first).toMatchObject({ seq: 1, type: 'start', at: AT });
    expect(first?.payload).toEqual({ variables: { total: 42 } });
    store.close();
  });

  it('recusa uma chave que não está publicada', async () => {
    const { store, runtime } = await fixture();
    await expect(runtime.start('Inexistente')).rejects.toThrow('Inexistente');
    store.close();
  });
});

describe('EbbRuntime.apply', () => {
  it('continua de onde o comando anterior parou, sem motor em memória', async () => {
    const { store, runtime } = await fixture();
    const started = await runtime.start('Pedido');
    const [task] = started.tasks;
    if (!task) throw new Error('nenhuma tarefa pendente');

    const done = await runtime.apply('inst-1', {
      type: 'completeTask',
      tokenId: task.tokenId,
      output: { separadoPor: 'ana' },
    });

    expect(done.snapshot.status).toBe('completed');
    expect(done.instance).toMatchObject({ seq: 2, status: 'completed' });
    expect(done.snapshot.variables).toMatchObject({ separadoPor: 'ana' });
    store.close();
  });

  it('reclama de uma instância que não existe', async () => {
    const { store, runtime } = await fixture();
    await expect(runtime.apply('sumiu', { type: 'tick' })).rejects.toThrow(InstanceNotFoundError);
    store.close();
  });
});

describe('o relógio congelado', () => {
  it('carimba todo o histórico de um comando com o instante que o journal gravou', async () => {
    const { store, runtime } = await fixture();
    const started = await runtime.start('Pedido');

    const [entry] = await store.journal('inst-1');
    // O motor lê o relógio uma vez por entrada de histórico; com um relógio de
    // parede cada entrada teria um instante próprio e o replay divergiria.
    expect(started.snapshot.history.length).toBeGreaterThan(1);
    for (const record of started.snapshot.history) expect(record.at).toBe(entry?.at);
    store.close();
  });

  it('usa o instante explícito quando o chamador dá um', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido');
    await runtime.apply('inst-1', { type: 'tick' }, AT + 60_000);

    const entries = await store.journal('inst-1');
    expect(entries[1]).toMatchObject({ type: 'tick', at: AT + 60_000 });
    // O relógio de parede é outro campo e continua sendo o de verdade.
    expect(entries[1]?.recordedAt).toBe(new Date(AT).toISOString());
    store.close();
  });
});

describe('EbbRuntime.inspect', () => {
  it('devolve estado, tarefas e journal sem aplicar nada', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido', { variables: { total: 42 } });

    const view = await runtime.inspect('inst-1');
    expect(view.instance.seq).toBe(1);
    expect(view.snapshot.variables).toMatchObject({ total: 42 });
    expect(view.tasks.map((task) => task.nodeId)).toEqual(['Separar']);
    expect(view.journal).toHaveLength(1);
    store.close();
  });

  it('falha com a própria mensagem quando o esquema do motor mudou', async () => {
    const { store, runtime } = await fixture();
    await runtime.start('Pedido');
    // Simula um ebb atualizado lendo o que a versão anterior gravou.
    await store.append({
      instanceId: 'inst-1',
      status: 'waiting',
      command: { type: 'tick', payload: {}, at: AT },
      state: { engineVersion: ENGINE_STATE_VERSION - 1, json: '{}' },
    });

    await expect(runtime.inspect('inst-1')).rejects.toThrow(EngineStateMismatchError);
    await expect(runtime.inspect('inst-1')).rejects.toThrow(/journal está intacto/);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/runtime/test/runtime.test.ts
```

Esperado: FAIL — `Cannot find module '../src/runtime.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/runtime/src/runtime.ts`:

```ts
import { randomUUID } from 'node:crypto';
import {
  ENGINE_STATE_VERSION,
  executableProcess,
  parseBpmn,
  WorkflowEngine,
} from '@bpmn-flow/core';
import type { EngineState, ExecutionSnapshot, PendingTask } from '@bpmn-flow/core';
import type { InstanceRecord, JournalEntry, Store } from '@ebb/store';
import { applyCommand, payloadOf, type InstanceCommand } from './commands.js';
import { EngineStateMismatchError, InstanceNotFoundError } from './errors.js';

export interface EbbRuntimeOptions {
  store: Store;
  /** Relógio de parede. Injetável para o teste não depender do de verdade. */
  now?: () => Date;
  /** Gerador de id, pelo mesmo motivo. */
  newId?: () => string;
}

export interface StartOptions {
  /** A versão a instanciar. A mais recente quando omitida. */
  version?: number;
  variables?: Record<string, unknown>;
}

export interface CommandResult {
  instance: InstanceRecord;
  snapshot: ExecutionSnapshot;
  tasks: PendingTask[];
}

export interface InstanceView extends CommandResult {
  journal: JournalEntry[];
}

/**
 * O ciclo de vida de uma instância.
 *
 * Não guarda motor entre comandos: cada comando re-hidrata do snapshot,
 * aplica, grava e descarta. É por isso que uma instância sobrevive à morte do
 * processo sem nenhum mecanismo a mais — o caso normal e o caso do restart são
 * o mesmo caminho.
 */
export class EbbRuntime {
  private readonly store: Store;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: EbbRuntimeOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
  }

  /** Instancia um processo publicado e o leva até o primeiro ponto de espera. */
  async start(processKey: string, options: StartOptions = {}): Promise<CommandResult> {
    const deployment = await this.store.read(processKey, options.version);
    if (!deployment) {
      const what = options.version === undefined ? processKey : `${processKey} v${options.version}`;
      throw new Error(`Nada publicado com a chave "${what}".`);
    }

    const model = await parseBpmn(deployment.xml);
    const process = executableProcess(model);
    const at = this.now().getTime();
    const command: InstanceCommand = {
      type: 'start',
      ...(options.variables ? { variables: options.variables } : {}),
    };

    const engine = new WorkflowEngine(process, {
      processes: model.processes,
      now: () => at,
      ...(options.variables ? { variables: options.variables } : {}),
    });
    const snapshot = await applyCommand(engine, command);

    const instance = await this.store.createInstance({
      id: this.newId(),
      processKey: deployment.processKey,
      version: deployment.version,
      status: snapshot.status,
      command: { type: command.type, payload: payloadOf(command), at },
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
    });

    return { instance, snapshot, tasks: engine.tasks() };
  }

  /**
   * Aplica um comando a uma instância existente e grava o resultado.
   *
   * `at` é o relógio do motor para este comando; o padrão é o de parede. Dar um
   * explícito é como um `tick` anda até um timer vencer sem esperar.
   */
  async apply(instanceId: string, command: InstanceCommand, at?: number): Promise<CommandResult> {
    const when = at ?? this.now().getTime();
    const { instance, engine } = await this.hydrate(instanceId, when);
    const snapshot = await applyCommand(engine, command);

    const updated = await this.store.append({
      instanceId: instance.id,
      status: snapshot.status,
      command: { type: command.type, payload: payloadOf(command), at: when },
      state: { engineVersion: ENGINE_STATE_VERSION, json: JSON.stringify(engine.getState()) },
    });

    return { instance: updated, snapshot, tasks: engine.tasks() };
  }

  /** Lê uma instância sem aplicar nada. */
  async inspect(instanceId: string): Promise<InstanceView> {
    const journal = await this.store.journal(instanceId);
    // Nada vai ler este relógio, mas restore() exige um: o último instante
    // journalado mantém a leitura determinística.
    const at = journal.at(-1)?.at ?? this.now().getTime();
    const { instance, engine } = await this.hydrate(instanceId, at);
    return { instance, snapshot: engine.snapshot(), tasks: engine.tasks(), journal };
  }

  /** Reconstrói o motor de uma instância com o relógio congelado em `at`. */
  private async hydrate(
    instanceId: string,
    at: number,
  ): Promise<{ instance: InstanceRecord; engine: WorkflowEngine }> {
    const instance = await this.store.readInstance(instanceId);
    if (!instance) throw new InstanceNotFoundError(instanceId);

    // A versão com que a instância começou, não a mais recente: um redeploy não
    // troca o modelo debaixo de uma instância viva.
    const deployment = await this.store.read(instance.processKey, instance.version);
    if (!deployment) {
      throw new Error(
        `A instância ${instanceId} aponta para ${instance.processKey} v${instance.version}, que não está publicado.`,
      );
    }

    const stored = await this.store.readInstanceState(instanceId);
    if (!stored) throw new Error(`A instância ${instanceId} não tem estado gravado.`);
    if (stored.engineVersion !== ENGINE_STATE_VERSION) {
      throw new EngineStateMismatchError(instanceId, stored.engineVersion, ENGINE_STATE_VERSION);
    }

    const model = await parseBpmn(deployment.xml);
    const process = executableProcess(model);
    const state = JSON.parse(stored.json) as EngineState;
    const engine = WorkflowEngine.restore(process, state, {
      processes: model.processes,
      now: () => at,
    });
    return { instance, engine };
  }
}
```

Acrescente a `packages/runtime/src/index.ts`:

```ts
export { EbbRuntime } from './runtime.js';
export type { CommandResult, EbbRuntimeOptions, InstanceView, StartOptions } from './runtime.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/runtime/test/runtime.test.ts
npm run verify
```

Esperado: PASS, 9 testes; `verify` exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime
git commit -m "$(cat <<'EOF'
feat(runtime): give an instance a durable life cycle

EbbRuntime holds no engine between commands: each one rehydrates from the
snapshot, applies, persists and drops it, so the restart case and the normal
case are the same path. The engine clock is frozen per command and that
instant is what the journal stores — the engine reads its clock once per
history entry, so a wall clock would make the same command unreproducible.

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb
EOF
)"
```

---

### Task 6: comandos de instância no CLI

**Files:**

- Create: `packages/cli/src/output.ts`, `packages/cli/src/vars.ts`,
  `packages/cli/src/instances.ts`
- Modify: `packages/cli/src/commands.ts`, `packages/cli/src/index.ts`,
  `packages/cli/package.json`
- Test: `packages/cli/test/vars.test.ts`, `packages/cli/test/instances.test.ts`

**Interfaces:**

- Consumes: `EbbRuntime`, `InstanceCommand` (Tasks 4-5);
  `Store.findInstances`, `Store.listInstances` (Task 3).
- Produces: `parseVars(argv): Record<string, unknown>`;
  `startInstance`, `listInstances`, `showInstance`, `completeTask`,
  `signalInstance`, `tickInstance`, `showJournal` — todos
  `(...): Promise<CommandResult>` com `{ output, exitCode }`;
  `CHECK`, `CROSS`, `WARN`, `table` em `output.ts`.

- [ ] **Step 1: Write the failing test**

Acrescente `@ebb/runtime` às dependências de `packages/cli/package.json`:

```json
  "dependencies": {
    "@bpmn-flow/core": "file:../../../bpmn-flow/packages/core",
    "@ebb/runtime": "^0.0.0",
    "@ebb/store": "^0.0.0"
  }
```

Rode `npm install`.

Crie `packages/cli/test/vars.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseVars } from '../src/vars.js';

describe('parseVars', () => {
  it('lê JSON quando o valor parseia e texto quando não', () => {
    expect(parseVars(['--var', 'total=42', '--var', 'nome=ana', '--var', 'pago=true'])).toEqual({
      total: 42,
      nome: 'ana',
      pago: true,
    });
  });

  it('aceita objeto e lista', () => {
    expect(parseVars(['--var', 'itens=[1,2]', '--var', 'cliente={"id":7}'])).toEqual({
      itens: [1, 2],
      cliente: { id: 7 },
    });
  });

  it('preserva o = que aparece dentro do valor', () => {
    expect(parseVars(['--var', 'query=a=b'])).toEqual({ query: 'a=b' });
  });

  it('ignora o resto do argv', () => {
    expect(parseVars(['show', 'abc', '--store', 'x.db'])).toEqual({});
  });

  it('reclama de um par sem chave ou sem =', () => {
    expect(() => parseVars(['--var', 'solto'])).toThrow('chave=valor');
    expect(() => parseVars(['--var', '=1'])).toThrow('chave=valor');
    expect(() => parseVars(['--var'])).toThrow('chave=valor');
  });
});
```

Crie `packages/cli/test/instances.test.ts`:

```ts
import { checksumOf, SqliteStore } from '@ebb/store';
import { EbbRuntime } from '@ebb/runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  completeTask,
  listInstances,
  showInstance,
  showJournal,
  startInstance,
} from '../src/instances.js';

const PEDIDO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" name="Processo de Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

let store: SqliteStore;
let runtime: EbbRuntime;

beforeEach(async () => {
  store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'Pedido', xml: PEDIDO, checksum: checksumOf(PEDIDO) });
  let ids = 0;
  runtime = new EbbRuntime({ store, newId: () => `abc${++ids}def` });
});

describe('startInstance', () => {
  it('cria e mostra o id e o que ficou pendente', async () => {
    const result = await startInstance(runtime, 'Pedido', { variables: { total: 42 } });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('abc1def');
    expect(result.output).toContain('Separar itens');
  });

  it('sai com 1 quando a chave não existe', async () => {
    const result = await startInstance(runtime, 'Inexistente', {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Inexistente');
  });
});

describe('listInstances', () => {
  it('diz como começar quando não há nenhuma', async () => {
    const result = await listInstances(store);
    expect(result.output).toContain('ebb start');
  });

  it('lista uma linha por instância', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await listInstances(store);
    expect(result.output).toContain('abc1def');
    expect(result.output).toContain('waiting');
  });
});

describe('resolução por prefixo', () => {
  it('aceita um prefixo curto', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await showInstance(store, runtime, 'abc1');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Separar itens');
  });

  it('sai com 1 e lista as candidatas quando o prefixo é ambíguo', async () => {
    await startInstance(runtime, 'Pedido', {});
    await startInstance(runtime, 'Pedido', {});
    const result = await showInstance(store, runtime, 'abc');

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('abc1def');
    expect(result.output).toContain('abc2def');
  });

  it('sai com 1 quando nada casa', async () => {
    const result = await showInstance(store, runtime, 'zzz');
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('zzz');
  });
});

describe('completeTask', () => {
  it('conclui a tarefa pendente e leva a instância ao fim', async () => {
    await startInstance(runtime, 'Pedido', {});
    const view = await runtime.inspect('abc1def');
    const [task] = view.tasks;
    if (!task) throw new Error('nenhuma tarefa pendente');

    const result = await completeTask(store, runtime, 'abc1', task.tokenId, {
      separadoPor: 'ana',
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('completed');
  });
});

describe('showJournal', () => {
  it('mostra um comando por linha, em ordem', async () => {
    await startInstance(runtime, 'Pedido', {});
    const result = await showJournal(store, 'abc1');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('start');
    expect(result.output).toContain('1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run packages/cli/test/vars.test.ts packages/cli/test/instances.test.ts
```

Esperado: FAIL — `Cannot find module '../src/vars.js'`.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/output.ts` — mova de `commands.ts` sem alterar o corpo:

```ts
export const CHECK = '✓';
export const CROSS = '✗';
export const WARN = '!';

/** Tabela de largura fixa, alinhada pela coluna mais larga. */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
```

Em `packages/cli/src/commands.ts`: apague as constantes `CHECK`/`CROSS`/`WARN`
e a função `table`, e importe-as:

```ts
import { CHECK, CROSS, table, WARN } from './output.js';
```

`packages/cli/src/vars.ts`:

```ts
/**
 * `--var chave=valor`, repetível.
 *
 * O valor é JSON quando parseia e texto quando não: `--var total=42` é número,
 * `--var nome=ana` é `"ana"`. Sem isso toda variável de processo chegaria como
 * string e toda condição numérica do diagrama ficaria falsa.
 */
export function parseVars(argv: string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--var') continue;
    const pair = argv[index + 1];
    const split = pair === undefined ? -1 : pair.indexOf('=');
    if (pair === undefined || split <= 0) {
      throw new Error(`--var espera chave=valor e veio "${pair ?? ''}".`);
    }
    vars[pair.slice(0, split)] = parseValue(pair.slice(split + 1));
  }
  return vars;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
```

`packages/cli/src/instances.ts`:

```ts
import type { EbbRuntime, InstanceView } from '@ebb/runtime';
import type { InstanceRecord, Store } from '@ebb/store';
import type { CommandResult } from './commands.js';
import { CHECK, CROSS, table } from './output.js';

/** Quanto de um id aparece numa listagem; o CLI aceita qualquer prefixo único. */
const SHORT = 8;

export interface StartCliOptions {
  version?: number;
  variables?: Record<string, unknown>;
}

/** `ebb start <chave>` — instancia um processo publicado. */
export async function startInstance(
  runtime: EbbRuntime,
  processKey: string,
  options: StartCliOptions,
): Promise<CommandResult> {
  try {
    const started = await runtime.start(processKey, options);
    return {
      output: [
        `${CHECK} instância ${started.instance.id} — ${started.snapshot.status}`,
        ...pendingLines(started.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  } catch (error) {
    return { output: `${CROSS} ${message(error)}`, exitCode: 1 };
  }
}

/** `ebb ps` — as instâncias, da mais nova para a mais antiga. */
export async function listInstances(store: Store): Promise<CommandResult> {
  const instances = await store.listInstances();
  if (instances.length === 0) {
    return { output: 'Nenhuma instância. Comece com: ebb start <chave>', exitCode: 0 };
  }
  const rows = instances.map((entry) => [
    entry.id.slice(0, SHORT),
    entry.processKey,
    `v${entry.version}`,
    entry.status,
    `${entry.seq}`,
    entry.updatedAt,
  ]);
  return {
    output: table(['ID', 'PROCESSO', 'VERSÃO', 'ESTADO', 'COMANDOS', 'ATUALIZADA'], rows),
    exitCode: 0,
  };
}

/** `ebb show <id>` — estado, variáveis e o que está pendente. */
export async function showInstance(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const view = await runtime.inspect(instance.id);
    return { output: describe(view), exitCode: 0 };
  });
}

/** `ebb complete <id> <tokenId>` — conclui uma tarefa parada. */
export async function completeTask(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  tokenId: string,
  output: Record<string, unknown>,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, {
      type: 'completeTask',
      tokenId,
      ...(hasKeys(output) ? { output } : {}),
    });
    return {
      output: [
        `${CHECK} ${instance.id} — ${result.snapshot.status}`,
        ...pendingLines(result.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  });
}

/** `ebb signal <id> <nome>` — entrega um evento ao diagrama. */
export async function signalInstance(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  name: string,
  output: Record<string, unknown>,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, {
      type: 'signal',
      name,
      ...(hasKeys(output) ? { output } : {}),
    });
    return {
      output: [
        `${CHECK} ${instance.id} — ${result.snapshot.status}`,
        ...pendingLines(result.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  });
}

/** `ebb tick <id> [--at <iso>]` — dispara os timers vencidos. */
export async function tickInstance(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  at?: number,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const result = await runtime.apply(instance.id, { type: 'tick' }, at);
    return {
      output: [
        `${CHECK} ${instance.id} — ${result.snapshot.status}`,
        ...pendingLines(result.tasks),
      ].join('\n'),
      exitCode: 0,
    };
  });
}

/** `ebb journal <id>` — os comandos aplicados, em ordem. */
export async function showJournal(store: Store, prefix: string): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const entries = await store.journal(instance.id);
    const rows = entries.map((entry) => [
      `${entry.seq}`,
      entry.type,
      entry.recordedAt,
      JSON.stringify(entry.payload),
    ]);
    return { output: table(['#', 'COMANDO', 'QUANDO', 'PAYLOAD'], rows), exitCode: 0 };
  });
}

/**
 * Resolve o prefixo numa instância e roda `fn`, ou explica por que não deu.
 *
 * Prefixo ambíguo lista as candidatas em vez de escolher uma: aplicar um
 * comando na instância errada não tem desfazer.
 */
async function withInstance(
  store: Store,
  prefix: string,
  fn: (instance: InstanceRecord) => Promise<CommandResult>,
): Promise<CommandResult> {
  const [first, ...rest] = await store.findInstances(prefix);
  if (!first) {
    return { output: `${CROSS} nenhuma instância com o id "${prefix}"`, exitCode: 1 };
  }
  if (rest.length > 0) {
    return {
      output: [
        `${CROSS} "${prefix}" casa com ${rest.length + 1} instâncias:`,
        ...[first, ...rest].map((entry) => `  ${entry.id}  ${entry.processKey}  ${entry.status}`),
      ].join('\n'),
      exitCode: 1,
    };
  }
  try {
    return await fn(first);
  } catch (error) {
    return { output: `${CROSS} ${message(error)}`, exitCode: 1 };
  }
}

function describe(view: InstanceView): string {
  const { instance, snapshot } = view;
  const lines = [
    table(
      ['INSTÂNCIA', 'PROCESSO', 'VERSÃO', 'ESTADO', 'COMANDOS'],
      [
        [
          instance.id,
          instance.processKey,
          `v${instance.version}`,
          instance.status,
          `${instance.seq}`,
        ],
      ],
    ),
  ];

  const variables = Object.entries(snapshot.variables);
  if (variables.length > 0) {
    lines.push(
      '',
      table(
        ['VARIÁVEL', 'VALOR'],
        variables.map(([key, value]) => [key, JSON.stringify(value) ?? 'undefined']),
      ),
    );
  }

  const pending = pendingLines(view.tasks);
  if (pending.length > 0) lines.push('', ...pending);

  return lines.join('\n');
}

function pendingLines(tasks: InstanceView['tasks']): string[] {
  if (tasks.length === 0) return [];
  return [
    table(
      ['TOKEN', 'ATIVIDADE', 'NOME', 'ESPERANDO'],
      tasks.map((task) => [task.tokenId, task.nodeId, task.name ?? '', task.reason]),
    ),
  ];
}

function hasKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

Acrescente a `packages/cli/src/index.ts`:

```ts
export {
  completeTask,
  listInstances,
  showInstance,
  showJournal,
  signalInstance,
  startInstance,
  tickInstance,
} from './instances.js';
export type { StartCliOptions } from './instances.js';
export { parseVars } from './vars.js';
export { CHECK, CROSS, table, WARN } from './output.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run packages/cli/test/vars.test.ts packages/cli/test/instances.test.ts
npm run verify
```

Esperado: PASS; `verify` exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/cli package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(cli): operate an instance from the terminal

start, ps, show, complete, signal, tick and journal. An id resolves from any
unique prefix the way git does, and an ambiguous one lists the candidates
rather than picking one — applying a command to the wrong instance has no undo.
--var reads its value as JSON when it parses, so a numeric guard in the
diagram is not compared against a string.

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb
EOF
)"
```

---

### Task 7: o binário, e a prova de que a instância sobrevive ao processo

**Files:**

- Modify: `packages/cli/src/bin.ts`, `README.md`, `CLAUDE.md`
- Test: `packages/cli/test/bin.test.ts`

**Interfaces:**

- Consumes: tudo das Tasks 1-6.
- Produces: os subcomandos no binário; `USAGE` atualizado.

- [ ] **Step 1: Write the failing test**

Acrescente a `packages/cli/test/bin.test.ts`, dentro do
`describe('ebb (binário construído)', ...)`:

```ts
it('uma instância sobrevive à morte do processo', async () => {
  await ebb('deploy', 'pedido.bpmn');

  // Processo 1: cria.
  const started = await ebb('start', 'Pedido', '--var', 'total=42');
  expect(started.code).toBe(0);
  const id = started.stdout.match(/instância (\S+)/)?.[1];
  if (!id) throw new Error(`sem id na saída: ${started.stdout}`);

  // Processo 2: outro processo do SO, nada em memória do anterior.
  const shown = await ebb('show', id.slice(0, 8));
  expect(shown.code).toBe(0);
  expect(shown.stdout).toContain('waiting');
  expect(shown.stdout).toContain('Separar itens');
  expect(shown.stdout).toContain('42');

  const token = shown.stdout.match(/^(\S+)\s+Separar\s/m)?.[1];
  if (!token) throw new Error(`sem token na saída: ${shown.stdout}`);

  // Processo 3: continua de onde o processo 1 parou.
  const done = await ebb('complete', id.slice(0, 8), token, '--var', 'separadoPor=ana');
  expect(done.code).toBe(0);
  expect(done.stdout).toContain('completed');

  // Processo 4: o estado final persistiu.
  const after = await ebb('show', id.slice(0, 8));
  expect(after.stdout).toContain('completed');
  expect(after.stdout).toContain('ana');

  // O journal tem os dois comandos, que é o que o chunk 3 vai replayar.
  const journal = await ebb('journal', id.slice(0, 8));
  expect(journal.stdout).toContain('start');
  expect(journal.stdout).toContain('completeTask');
});

it('ps lista o que start criou', async () => {
  await ebb('deploy', 'pedido.bpmn');
  await ebb('start', 'Pedido');

  const listed = await ebb('ps');
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain('Pedido');
  expect(listed.stdout).toContain('waiting');
});

it('sai com 2 quando falta o argumento de um comando de instância', async () => {
  expect((await ebb('start')).code).toBe(2);
  expect((await ebb('show')).code).toBe(2);
  expect((await ebb('complete', 'abc')).code).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run build -w @ebb/cli
npx vitest run packages/cli/test/bin.test.ts
```

Esperado: FAIL — `Comando desconhecido "start"`, código 2.

- [ ] **Step 3: Write minimal implementation**

Em `packages/cli/src/bin.ts`, substitua o `USAGE` e acrescente os casos.

```ts
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { EbbRuntime } from '@ebb/runtime';
import { SqliteStore } from '@ebb/store';
import { deploy, list, versions } from './commands.js';
import {
  completeTask,
  listInstances,
  showInstance,
  showJournal,
  signalInstance,
  startInstance,
  tickInstance,
} from './instances.js';
import { resolveStorePath } from './paths.js';
import { parseVars } from './vars.js';

const USAGE = `ebb — processos BPMN que você pode rebobinar

Definições:
  ebb deploy <arquivo.bpmn> [--force]   valida e publica uma definição
  ebb ls                                o que está publicado
  ebb versions <chave>                  o histórico de uma definição

Instâncias:
  ebb start <chave> [--version N]       instancia um processo publicado
  ebb ps                                as instâncias e o estado de cada uma
  ebb show <id>                         estado, variáveis e o que está pendente
  ebb complete <id> <token>             conclui uma tarefa parada
  ebb signal <id> <nome>                entrega um evento ao diagrama
  ebb tick <id> [--at <iso>]            dispara os timers vencidos
  ebb journal <id>                      os comandos aplicados, em ordem

O <id> aceita qualquer prefixo único, como o git.

Opções:
  --store <arquivo>   onde fica o banco (padrão: .ebb/ebb.db, ou $EBB_STORE)
  --force             publica mesmo com aviso de validação
  --var chave=valor   variável de processo; JSON quando parseia, texto quando não
  --at <iso>          instante que o tick usa, em vez do relógio de parede
`;
```

Dentro de `main()`, depois de construir o `store`, construa o runtime e
acrescente os casos ao `switch`:

```ts
const store = new SqliteStore({ path: resolveStorePath(option(argv, 'store')) });
const runtime = new EbbRuntime({ store });
try {
  switch (command) {
    // ... deploy, ls, versions ficam como estão ...

    case 'start': {
      const key = argv[1];
      if (!key || key.startsWith('--')) return usageError('Informe a chave do processo.');
      const version = option(argv, 'version');
      const result = await startInstance(runtime, key, {
        variables: parseVars(argv),
        ...(version ? { version: Number(version) } : {}),
      });
      console.log(result.output);
      return result.exitCode;
    }
    case 'ps': {
      const result = await listInstances(store);
      console.log(result.output);
      return result.exitCode;
    }
    case 'show': {
      const id = argv[1];
      if (!id || id.startsWith('--')) return usageError('Informe o id da instância.');
      const result = await showInstance(store, runtime, id);
      console.log(result.output);
      return result.exitCode;
    }
    case 'complete': {
      const id = argv[1];
      const token = argv[2];
      if (!id || id.startsWith('--') || !token || token.startsWith('--')) {
        return usageError('Informe o id da instância e o token da tarefa.');
      }
      const result = await completeTask(store, runtime, id, token, parseVars(argv));
      console.log(result.output);
      return result.exitCode;
    }
    case 'signal': {
      const id = argv[1];
      const name = argv[2];
      if (!id || id.startsWith('--') || !name || name.startsWith('--')) {
        return usageError('Informe o id da instância e o nome do evento.');
      }
      const result = await signalInstance(store, runtime, id, name, parseVars(argv));
      console.log(result.output);
      return result.exitCode;
    }
    case 'tick': {
      const id = argv[1];
      if (!id || id.startsWith('--')) return usageError('Informe o id da instância.');
      const iso = option(argv, 'at');
      const at = iso === undefined ? undefined : Date.parse(iso);
      if (at !== undefined && Number.isNaN(at)) {
        return usageError(`--at esperava uma data ISO-8601 e veio "${iso ?? ''}".`);
      }
      const result = await tickInstance(store, runtime, id, at);
      console.log(result.output);
      return result.exitCode;
    }
    case 'journal': {
      const id = argv[1];
      if (!id || id.startsWith('--')) return usageError('Informe o id da instância.');
      const result = await showJournal(store, id);
      console.log(result.output);
      return result.exitCode;
    }
    default:
      console.error(`Comando desconhecido "${command}".\n\n${USAGE}`);
      return 2;
  }
} finally {
  store.close();
}
```

E acrescente, junto de `option()`:

```ts
/** Argumento faltando: a mensagem, o uso, e o código que um script reconhece. */
function usageError(what: string): number {
  console.error(`${what}\n\n${USAGE}`);
  return 2;
}
```

Troque os dois `console.error(...); return 2;` existentes (`deploy` e
`versions`) por `return usageError(...)`, para não repetir o padrão.

Em `README.md`, na seção de uso, acrescente o ciclo de instância depois do
`deploy`/`ls`:

````markdown
```bash
ebb start Pedido --var total=42     # instancia; imprime o id
ebb ps                              # o que está rodando
ebb show <id>                       # estado, variáveis, pendências
ebb complete <id> <token>           # conclui a tarefa parada
ebb journal <id>                    # os comandos aplicados, em ordem
```

Mate o processo entre um comando e outro: o estado está no `.ebb/ebb.db`, e a
próxima invocação continua de onde a anterior parou.
````

Em `CLAUDE.md`, acrescente `@ebb/runtime` à tabela de pacotes e tire-o da lista
"entram nos chunks seguintes":

```markdown
| `@ebb/runtime` | Ciclo de vida de instância: aplica comando, journala, persiste. |
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run verify
```

Esperado: exit 0, com os testes do binário construído passando.

- [ ] **Step 5: Commit**

```bash
git add packages/cli README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(cli): wire the instance commands into the binary

The durability test runs the built binary through execFile, one operating
system process per command: start, then show, then complete, then show again.
Each invocation starts cold, so seeing the previous one's state is the whole
proof — and the journal it leaves behind is what chunk 3 replays.

Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb
EOF
)"
```

---

## Auto-revisão

**Cobertura do spec** — cada seção tem tarefa:

| Seção do spec                               | Tarefa  |
| ------------------------------------------- | ------- |
| Modelo de dados (3 tabelas, migração 2)     | 1       |
| `version` congelada                         | 1, 5    |
| `at` vs `recorded_at`                       | 1, 2, 5 |
| Snapshot sobrescrito, uma linha             | 2       |
| Comando como dado + `applyCommand`          | 4       |
| Relógio congelado                           | 5       |
| `@ebb/runtime` sem estado, `hydrate`        | 5       |
| `ENGINE_STATE_VERSION` com mensagem própria | 5       |
| Atomicidade                                 | 1, 2    |
| Superfície do CLI (7 comandos)              | 6, 7    |
| Prefixo único de id                         | 3, 6    |
| `--var` JSON-ou-texto                       | 6       |
| Teste 1 (durabilidade no binário)           | 7       |
| Teste 2 (atomicidade)                       | 2       |
| Teste 3 (relógio congelado)                 | 5       |
| Teste 4 (esquema incompatível)              | 5       |

**Consistência de tipos** — `InstanceStatus` (store) recebe
`ExecutionSnapshot['status']` (core) em `runtime.ts`; se os dois conjuntos
divergirem, a atribuição não compila, que é o alarme que se quer.
`CommandResult` tem dois significados em pacotes diferentes — `@ebb/runtime`
(instância + snapshot + tarefas) e `@ebb/cli` (texto + código de saída); em
`packages/cli/src/instances.ts` só o do CLI é importado, e o do runtime nunca
entra naquele arquivo.

**Sem placeholder** — todo passo de código traz o código.

**Corrigido na auto-revisão:**

- `createInstance` e `append` lançavam de forma síncrona dentro de um método
  que a interface declara como `Promise`. Quem usasse `.catch()` não veria o
  erro, e o teste de chave estrangeira com `.rejects` falharia por motivo
  errado. Daí o auxiliar `promised`.
- `startInstance` recebia um `store` que não usava, e `showJournal` um
  `runtime` que não usava — parâmetro só por simetria é ruído que o próximo
  leitor vai tentar entender.
- `require-await` está em `error` neste repo (`recommendedTypeChecked`), então
  método `async` sem `await` não passa no lint: é por isso que as operações
  síncronas do store continuam devolvendo `Promise` em vez de virarem `async`.
