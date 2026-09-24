# ebb chunk 3a — replay e bifurcação

> Decidido em 2026-09-24, sobre o desenho geral em
> [`2026-09-14-ebb-design.md`](2026-09-14-ebb-design.md) e os chunks 1 e 2.
> Substitui conversa, não código: quando o código divergir daqui, este
> documento é que está errado.

A Seção 1 do `handoff.md` (time-travel) foi fatiada em dois ciclos:

- **3a (este)**: dívida do chunk 2, replay puro, razão de gateway, `ebb show
--at`, bifurcação. Tudo provado no terminal.
- **3b**: `apps/console` com `@bpmn-flow/viewer` e slider de passo. Consome a
  API que o 3a entrega e tem spec própria.

## O que o chunk termina

Rebobinar e bifurcar uma instância **pelo terminal**, com o porquê de cada
gateway.

Em concreto: numa instância que passou por um gateway exclusivo,
`ebb show <id> --at 2` mostra o comando daquele passo, as variáveis, os nós
entrados e a linha `Gateway_Valor: "valor > 100" → Flow_Alto (valor=150)`.
`ebb fork <id> --at 1` cria uma instância nova parada no passo 1, e um
`ebb complete <novo> <token> --var valor=50` a leva pelo outro ramo. A
instância original não muda. O teste de equivalência passa em todas as
fixtures, e `npm run verify` fica verde.

## O que já existe e o que falta

`hydrate` **não faz replay**: restaura o motor do snapshot mais recente
(`instance_state`). O journal é gravado desde o chunk 1, mas nunca foi lido de
volta para reconstruir estado, e nada prova hoje que ele basta para isso. O 3a
começa exatamente aí.

O que sustenta a premissa, checado no `@bpmn-flow/core`:

- O motor não lê `Math.random` nem `randomUUID`. Id de token é contador no
  estado, então o `tokenId` gravado em `completeJob` volta a existir no replay.
- O relógio é injetado (`now`), e o journal grava o `at` congelado de cada
  comando (decisão do chunk 1).
- `start` grava `variables` e todas as opções que mudam a execução (`mode`,
  `maxSteps`, `expressions`, `onHandlerError`, `retry`), e o comando é aplicado
  pelo mesmo `applyCommand` ao vivo e no replay.

## Razão do gateway sem mudar o motor

O design geral listava como pendência no `bpmn-flow` um evento de "condição
avaliada", porque o porquê de um gateway hoje só se reconstrói a partir de
`flow.take`. Esse evento **não é necessário**. `EngineOptions.decide`
(`engine/engine.ts:1240`) é chamado em todo gateway exclusivo e inclusivo com:

- `options`: cada fluxo de saída com `condition` e `isDefault`;
- `suggested`: os fluxos que os dados escolheriam;
- `variables`: as variáveis visíveis no gateway naquele instante.

No replay, um `decide` que **só registra e devolve `undefined`** deixa a
decisão com os dados (é o contrato do hook) e captura exatamente a razão.
O runtime ao vivo não passa `decide`, então a decisão gravada no replay é a
mesma que aconteceu. O custo é zero no core e zero coluna nova no journal.

Fica de fora o **gateway baseado em evento**: ele não passa por `decide`, e a
razão ali é "qual evento chegou primeiro", que já é o próprio comando
journalado (`signal`, `tick`).

## Replay puro

Mora em `@ebb/runtime` (`src/replay.ts`) e não conhece o store:

```ts
function replayJournal(
  xml: string,
  journal: JournalEntry[],
  options?: { upTo?: number },
): Promise<{ engine: WorkflowEngine; steps: ReplayStep[] }>;

interface ReplayStep {
  seq: number;
  at: number;
  command: InstanceCommand;
  /** Estado logo depois do comando. */
  snapshot: ExecutionSnapshot;
  /** O que este comando acrescentou à history do motor. */
  entered: HistoryEntry[];
  /** Fluxos tomados durante o comando, em ordem (evento `flow.take`). */
  flows: string[];
  decisions: GatewayTrace[];
  tasks: PendingTask[];
  incidents: IncidentState[];
}

interface GatewayTrace {
  nodeId: string;
  name?: string;
  options: { flowId: string; targetId: string; condition?: string; isDefault: boolean }[];
  taken: string[];
  variables: Record<string, unknown>;
}
```

Regras:

1. **Um motor só.** A primeira entrada tem de ser `start`. Dela saem as
   `variables` e as opções do construtor. As demais entradas são aplicadas em
   sequência no mesmo motor, sem `getState`/`restore` entre elas.
2. **Relógio mutável**: `now = () => clock`, com `clock = entry.at` antes de
   cada comando. É a mesma disciplina do relógio congelado do chunk 1.
3. **Entrada vira comando por guarda.** `commandFromEntry(entry)` em
   `commands.ts` valida `type` e `payload` e falha com o `seq` e o campo
   errado. Nada de `as`. O `parseStartEngineOptions` de `runtime.ts` muda para
   `commands.ts` e passa a ser parte dessa guarda. O `start` exige `engine`
   completo: sem ele, o replay não sabe com que `mode`, `maxSteps` e
   `expressions` o motor nasceu, e a guarda falha dizendo isso. A retomada
   pelo snapshot válido continua tolerante e cai nas políticas padrão do ebb,
   como hoje.
4. `upTo` omitido significa o journal inteiro. `upTo` fora de `[1, último seq]`
   é erro (`ReplayRangeError`), e não um corte silencioso.
5. `entered` é o delta de `snapshot().history` (entradas com `seq` maior que o
   último visto). `flows` vem de `engine.on('flow.take')`, que é ligado antes
   do primeiro comando.

**Custo**: O(n) comandos por chamada, e cada `ReplayStep` carrega um snapshot
com a `history` acumulada, portanto O(n²) de memória. Aceitável até alguém ter
instância com milhares de comandos. O remédio conhecido, se for preciso, é
devolver a history só no último passo e deltas nos demais.

## Runtime

### `replay`

```ts
EbbRuntime.replay(instanceId: string, upTo?: number):
  Promise<{ instance: InstanceRecord; xml: string; steps: ReplayStep[] }>
```

Lê instância, deployment (a versão congelada) e journal, e chama
`replayJournal`. Uma chamada devolve **todos** os passos até `upTo`, que é o
que o slider do 3b consome de uma vez. Não escreve nada.

### `fork`

```ts
EbbRuntime.fork(instanceId: string, seq: number, command?: InstanceCommand):
  Promise<CommandResult>
```

1. Replay até `seq`.
2. `store.forkInstance(...)` cria, **numa transação**, a linha da instância
   nova (mesmo `processKey`/`version`, `status` e `seq` do passo, e
   `forkedFrom`/`forkedAt`), copia as entradas `[1..seq]` do journal **com o
   `at` e o `payload` originais** (o `recordedAt` é o de agora), grava o
   snapshot do motor replayado e projeta `jobs` dele.
3. Se veio `command`, aplica pelo `apply` normal, numa transação própria. Um
   fork sem comando já é estado válido, então não há atomicidade a perder.

O fork é **vivo**. Se no passo `seq` havia job pendente, ele entra na tabela
`jobs` da instância nova e um `ebb worker` o executa. É o "seguir ao vivo com
outras variáveis" do design, e não um efeito colateral.

Bifurcar a partir de instância terminal é permitido quando `seq` é anterior ao
fim, que é o caso de uso principal. O `apply` subsequente continua recusando
comando em estado terminal.

O journal da original nunca é tocado: journal é imutável.

### Snapshot volta a ser cache

Hoje `EngineStateMismatchError` torna uma instância ilegível quando
`ENGINE_STATE_VERSION` sobe. O design geral já dizia que snapshot é cache
descartável. O 3a cumpre isso:

- `hydrate` com `engineVersion` divergente reconstrói o motor por
  `replayJournal` (journal inteiro) em vez de lançar.
- `apply` grava o snapshot novo na versão atual como sempre, e a instância se
  cura no primeiro comando.
- `inspect` e `replay` não escrevem.
- `EngineStateMismatchError` sai da API pública do `@ebb/runtime`.

O replay sob um motor mais novo pode, em tese, divergir do que aconteceu. Isso
é inerente a trocar de motor, e o journal ainda é a melhor fonte que existe.

### Guarda do estado gravado

`JSON.parse(stored.json) as EngineState` sai. O snapshot é validado por uma
guarda estrutural mínima (objeto com `version` numérico, `tokens` e `history`
arrays). Se não casar, cai no replay, pelo mesmo motivo do item anterior:
snapshot ruim é cache ruim, e cache ruim se descarta.

## Modelo de dados

Migração **4**:

```sql
ALTER TABLE instances ADD COLUMN forked_from TEXT;
ALTER TABLE instances ADD COLUMN forked_at   INTEGER;
```

Sem `FOREIGN KEY` em `forked_from`. Apagar a original não pode apagar nem
bloquear as bifurcações, que têm journal próprio e completo. `InstanceRecord`
ganha `forkedFrom?: string` e `forkedAt?: number`, lidos por `rows.ts`.

`Store` ganha:

```ts
forkInstance(input: {
  id: string;
  from: string;
  at: number;              // seq de corte
  status: InstanceStatus;
  journal: JournalEntry[]; // [1..at], como lido da original
  state: EngineStateInput;
  jobs: JobProjection[];
}): Promise<InstanceRecord>;
```

## CLI

- **`ebb show <id> --at <seq>`**: sem `--at`, comportamento de hoje. Com
  `--at`, imprime:
  - o comando do passo (`seq`, tipo, `at` em ISO, payload resumido);
  - status e variáveis naquele passo;
  - nós entrados no passo;
  - uma linha por gateway decidido, no formato
    `<nó>: "<condição>" → <fluxo> (<variáveis que a condição cita>)`. Quando
    extrair os identificadores da condição não for trivial, imprime todas as
    variáveis do gateway. A heurística de extração fica no CLI, nunca no
    runtime.
- **`ebb fork <id> --at <seq>`**: imprime o id novo. O valor diferente entra
  pelo comando de sempre (`ebb complete <novo> …`). O CLI não embute o
  subcomando, porque a composição já sai de graça. A API aceita `command` para
  o console do 3b.
- `ebb ps` e `ebb show` exibem `forked from <id-curto>@<seq>` quando for o caso.
- `--at` inválido (não inteiro, fora do intervalo) é erro de uso, com a
  mensagem dizendo o intervalo válido.

## Dívida do chunk 2

Entra no 3a, na ordem do plano:

1. **Typecheck dos testes**: o `tsconfig.lint.json` de cada pacote já inclui
   `src`, `test` e os configs com `noEmit`, então o script `typecheck` passa a
   rodar também `tsc -p tsconfig.lint.json`, sem arquivo novo. Com isso ele
   entra no `verify`. É o **primeiro commit**, antes de qualquer código novo, porque o
   3a mexe em contrato (`InstanceRecord`, `Store`) e é exatamente o caso que
   mordeu quatro vezes.
2. Guarda do `EngineState` (acima, em "Guarda do estado gravado").
3. `SqliteStore.db` volta a `private`, e o teste passa a ler `busyTimeoutMs()`.
4. Teste do decode UTF-8 do `ebb worker` (`Buffer.concat` antes de
   `toString`), como função pura, com um caractere multibyte partido entre
   dois chunks.
5. `reconcileJobs` só atualiza `updated_at` de linha que mudou.
6. **Contenção real do lease**: dois processos filhos com o mesmo banco, cada
   um aguardando uma barreira (um arquivo que o teste cria) antes de chamar
   `lockJobs`. Afirma que cada job saiu para exatamente um deles.
7. **`activity.end` sem `activity.start`** quando o worker devolve `BpmnError`
   num job parqueado: correção no `@bpmn-flow/core`, com teste lá, por PR, no
   mesmo molde do #55 e do #58.

Fica fora, pelos motivos do handoff: mover a resolução de prefixo para
`EbbRuntime` (seção 3, terceiro consumidor), `ebb incidents` O(n) (ninguém
sentiu a dor) e timeout de processo filho no worker (decisão deliberada).

## Testes

- **Equivalência (a prova central)**: para cada fixture e roteiro de comandos,
  `replayJournal(journal).engine.getState()` é igual, em `toEqual`, ao
  `instance_state` gravado pelo caminho ao vivo. O caminho ao vivo faz
  `restore` a cada comando e o replay usa um motor só. Divergência aqui é bug
  de `restore()` no core, e se corrige lá.
- Fixtures novas em `packages/runtime/test/fixtures.ts`: gateway exclusivo com
  condição e default, timer intermediário (exercita o relógio mutável) e job
  com retry até incidente seguido de `resolveIncident`.
- `GatewayTrace` de um gateway exclusivo: `taken`, `condition` e `variables`
  daquele instante, e não os finais.
- `upTo` no meio devolve estado intermediário. `upTo` fora do intervalo lança
  `ReplayRangeError`.
- Entrada de journal malformada falha dizendo `seq` e campo.
- **Bump simulado**: gravar `engine_version` diferente direto no banco.
  `inspect` ainda lê, e o próximo `apply` regrava na versão atual.
- Fork: journal copiado com `at` original, proveniência gravada, original
  intocada, job pendente no passo de corte aparece em `jobs` da nova, e um
  comando diferente leva a nova por outro ramo.
- Migração 4 sobre banco na versão 3 com instâncias existentes.
- CLI: `show --at`, `fork --at` e os erros de uso.

## Fora de escopo

- `apps/console`, viewer e slider: ficam para o 3b.
- HTTP: a seção 3 decide o `@ebb/api`. O 3b escolhe o mínimo para servir o
  console e diz por quê.
- Comando `setVariables` para operador corrigir instância viva: se aparecer,
  entra na seção 3, com o console. Exige API nova no core.
- A coluna `effects` continua adiável até a seção 5 (conectores).

## O que isto cobra do `bpmn-flow`

Só o PR do `activity.end` (item 7 da dívida). A pendência do "evento de
condição avaliada" do design geral fica **resolvida sem código**, via
`decide`. A de migração de estado quando `ENGINE_STATE_VERSION` sobe fica
resolvida do lado do ebb, com o replay do journal como fallback.
