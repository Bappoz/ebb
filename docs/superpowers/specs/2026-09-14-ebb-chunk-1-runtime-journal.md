# ebb chunk 1 — runtime durável + journal

> Decidido em 2026-09-14, sobre o desenho geral em
> [`2026-09-14-ebb-design.md`](2026-09-14-ebb-design.md). Substitui conversa,
> não código: quando o código divergir daqui, este documento é que está errado.

## O que o chunk termina

Mata o processo no meio da execução, sobe de novo, ele continua de onde parou.

Em concreto: `@ebb/runtime` dá ciclo de vida de instância ao `WorkflowEngine`,
`@ebb/store` ganha instância + journal + snapshot, e `@ebb/cli` ganha os
comandos para operar uma instância. Nada disso precisa de processo residente:
cada invocação do CLI é um processo novo, e é exatamente esse o teste.

## O achado que decide o desenho

O motor chama `this.now()` **por entrada de histórico**
(`engine/engine.ts:1814`) e **por timer agendado**
(`engine/timer-scheduler.ts:58,79`) — várias vezes dentro do drain de um único
comando. E `history` faz parte de `EngineState`.

Logo, com um relógio de parede, dois replays do mesmo comando produzem
`EngineState` diferentes. **O relógio é congelado por comando, e o instante
congelado é o que o journal grava.** Sem isso o journal deste chunk não serve
para o chunk 3, que é a única razão de gravá-lo agora.

## Modelo de dados

Três tabelas, migração 2. O journal é a verdade; o snapshot é cache — é o que
a linha de risco do desenho geral já dizia ("journal guarda comandos, não
estado do motor; snapshot é cache descartável").

```sql
CREATE TABLE instances (
  id          TEXT PRIMARY KEY,      -- crypto.randomUUID()
  process_key TEXT    NOT NULL,
  version     INTEGER NOT NULL,      -- congelada na criação
  status      TEXT    NOT NULL,      -- ExecutionStatus do motor
  seq         INTEGER NOT NULL,      -- último comando aplicado
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  FOREIGN KEY (process_key, version) REFERENCES deployments (process_key, version)
);

CREATE TABLE instance_journal (
  instance_id TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL,      -- JSON do comando, sem o tipo
  at          INTEGER NOT NULL,      -- relógio do MOTOR (epoch ms)
  recorded_at TEXT    NOT NULL,      -- relógio de PAREDE (ISO-8601)
  PRIMARY KEY (instance_id, seq),
  FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
);

CREATE TABLE instance_state (
  instance_id    TEXT PRIMARY KEY,
  seq            INTEGER NOT NULL,   -- o comando que produziu este estado
  engine_version INTEGER NOT NULL,   -- ENGINE_STATE_VERSION de quem gravou
  state          TEXT    NOT NULL,   -- JSON de engine.getState()
  FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
);
```

Por que as decisões não óbvias:

- **`version` congelada na criação.** Resume carrega a versão com que a
  instância começou, não a mais recente. Um redeploy no meio da vida de uma
  instância não pode trocar o modelo debaixo dela.
- **`at` e `recorded_at` separados.** Iguais na execução normal; divergem num
  `tick --at`. Um serve ao replay, o outro à auditoria, e misturar os dois é
  gravar uma mentira.
- **`instance_state` sobrescrito, uma linha por instância.** Armazenamento
  limitado e retomada O(1). O chunk 3 troca a chave para `(instance_id, seq)`
  e ganha checkpoint sem tocar no journal.
- **Sem coluna de efeitos de handler.** Não há handler no chunk 1, então
  nenhuma informação se perde: `ALTER TABLE ADD COLUMN` no chunk 2 é barato. O
  que não dava para adiar era `at`, e esse está.

## O comando como dado

É o que faz o chunk 3 existir sem reescrever o chunk 1: um único caminho de
aplicação, que a execução ao vivo e o replay futuro compartilham.

```ts
export type InstanceCommand =
  | { type: 'start'; variables?: Record<string, unknown> }
  | { type: 'completeTask'; tokenId: string; output?: Record<string, unknown> }
  | { type: 'signal'; name: string; output?: Record<string, unknown> }
  | { type: 'tick' };

applyCommand(engine: WorkflowEngine, command: InstanceCommand): Promise<ExecutionSnapshot>;
```

`retryTask` e `resolveIncident` ficam de fora: incidente só nasce de handler
que falha, e handler é o chunk 2.

O instante **não** faz parte do payload: é propriedade de toda entrada do
journal (`at`), e o runtime o injeta como relógio do motor
(`now: () => at`). Assim `engine.tick()` sem argumento já usa o instante
congelado — o `--at` do CLI é só quem escolhe esse instante em vez do relógio
de parede.

## `@ebb/runtime`

Sem estado entre comandos. Cada comando re-hidrata do snapshot, aplica, grava
e descarta o motor — é por isso que "matar o processo" sai de graça.

```
commands.ts   InstanceCommand + applyCommand
clock.ts      relógio congelado por comando
runtime.ts    EbbRuntime: start / apply / load
errors.ts     erros de domínio, com mensagem que diz o que fazer
```

Carregar uma instância:

1. lê `instances`, e daí o `Deployment` da versão congelada;
2. `parseBpmn` + `executableProcess` sobre o XML guardado;
3. lê `instance_state`; se `engine_version !== ENGINE_STATE_VERSION`, falha
   dizendo as duas versões e que **o journal está intacto** — não o erro
   genérico do motor;
4. `WorkflowEngine.restore(process, state, { processes: model.processes, now })`.

## Atomicidade

`Store` ganha duas operações, cada uma atômica por dentro
(`tx.ts`: `BEGIN` / `COMMIT` / `ROLLBACK`):

- `createInstance` — `instances` + journal (`seq` 1, `start`) + `instance_state`;
- `append` — journal + `instance_state` + `UPDATE instances`.

A camada de cima nunca vê transação. Se a escrita falhar no meio, nem o
journal nem o snapshot avançam — não um sim e o outro não.

## Superfície do CLI

```
ebb start <chave> [--version N] [--var k=v]...
ebb ps
ebb show <id>
ebb complete <id> <tokenId> [--var k=v]...
ebb signal <id> <nome> [--var k=v]...
ebb tick <id> [--at <iso>]
ebb journal <id>
```

- `<id>` aceita prefixo único, como o git.
- `--var k=v`: `v` é JSON quando parseia, senão string. `--var total=42` é
  número; `--var nome=ana` é `"ana"`.

## Testes

Além do unitário de cada unidade:

1. **Durabilidade, no binário construído** (`packages/cli/test/bin.test.ts`,
   `execFile` entre invocações separadas): `start` → processo novo → `show`
   vê a tarefa pendente e as variáveis → processo novo → `complete` →
   processo novo → `show` diz concluído; `journal` mostra as duas entradas.
2. **Atomicidade**: subclasse de `SqliteStore` cuja escrita de estado lança
   depois do `INSERT` do journal; o teste confirma que journal, `instances` e
   `instance_state` ficaram como estavam.
3. **Relógio congelado**: toda `HistoryEntry.at` produzida por um comando é
   igual ao `at` journalado daquele comando.
4. **Esquema de motor incompatível**: snapshot com `engine_version` diferente
   falha com a mensagem própria, não com a do motor.

`npm run verify` verde, incluindo o teste do binário.

## Fora de escopo

Handlers e workers (chunk 2) · replay funcional a partir do journal (chunk 3) ·
Postgres (chunk 8) · `CollaborationEngine` (chunk 6) · scheduler de timer em
background (`tick` é manual; um agendador não é a barra deste chunk).

## O que isto cobrou do `bpmn-flow`

`WorkflowEngine.restore()` aceitava `expressions` na assinatura e não repassava
ao construtor; `EngineState` não guardava o modo. Todo motor restaurado voltava
para `safe` em silêncio, e um processo com `expressions: 'javascript'` decidia
gateways diferente depois de um restart. Corrigido lá, com teste lá:
`expressions` entra em `EngineState` e `ENGINE_STATE_VERSION` vai de 9 para 10
— bump feito **antes** do ebb persistir a primeira instância, quando ainda não
custa nada.
