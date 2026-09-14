# Handoff — chunk 1: runtime durável + journal

> Escrito ao final da sessão que entregou o chunk 0. Esta é a _única_ fonte de
> contexto que a próxima sessão precisa — não releia a conversa anterior, ela
> não existe mais para você. Se algo aqui contradizer o código do repo, o
> código está certo e este documento está desatualizado; diga isso e corrija
> ao final do chunk.

## O que é o ebb, em três parágrafos

Plataforma de orquestração BPMN 2.0 sobre o motor do `bpmn-flow`
(`../bpmn-flow`, repositório irmão, consumido como dependência de caminho
porque ainda não está no npm). Existe porque não há alternativa livre e
nativa em TypeScript: Camunda 8 exige licença de produção desde a 8.6,
Camunda 7 Community morreu em out/2025, o que resta de BPMN livre é JVM, e o
que é Node (n8n, Windmill) não é motor de processo — sem compensação,
boundary event, multi-instância, correlação.

O diferencial: o motor é determinístico dado `(estado, sequência de
comandos)` e aceita relógio e handlers injetados. Um **journal** de
`[comando, resultado dos handlers que ele disparou]` reconstrói qualquer
passo de qualquer instância — rebobinar produção, explicar por que um
gateway escolheu um caminho, bifurcar a partir do passo N com outras
variáveis. Nenhum concorrente tem isso.

Decisões já tomadas e não renegociáveis neste chunk: SQLite via `node:sqlite`
(zero dependência nativa — é o que sustenta "sobe sem infraestrutura"),
Node ≥ 24, Apache-2.0 sem edição paga, dev-first (SDK/CLI antes de UI
no-code), build **sem bundle** (`bundle: false` em `tsup.base.ts` — o esbuild
normaliza `node:sqlite` para `sqlite`, que não resolve, e só o binário
construído mostra isso).

Desenho completo, com os 8 chunks e os riscos assumidos:
[`docs/superpowers/specs/2026-09-14-ebb-design.md`](docs/superpowers/specs/2026-09-14-ebb-design.md).

## O que já existe (chunk 0, entregue e mesclado)

```
packages/store/src/
  types.ts        Deployment, DeployInput, DeployResult, ProcessSummary, Store (interface)
  sqlite.ts       SqliteStore — implementação via node:sqlite
  migrations.ts   esquema versionado (SCHEMA_VERSION), aplicado em transação
  rows.ts         leitura de coluna com tipo — nunca `as` numa linha do SQLite
  checksum.ts     checksumOf(xml) — SHA-256, identidade de conteúdo

packages/cli/src/
  commands.ts     deploy, list, versions — puros, sem process/argv/IO
  bin.ts          o binário: parseia argv, chama commands.ts
  paths.ts        resolveStorePath — .ebb/ebb.db por padrão, --store/EBB_STORE por cima
```

`Store` é o contrato de persistência: SQLite hoje, Postgres quando houver mais
de um nó (chunk 8). O `deploy` do CLI é um portão — erro de validação do
`@bpmn-flow/core` barra, aviso barra e pede `--force`, colaboração com mais de
um pool executável é recusada mesmo com `--force` (publicar um pool e ignorar
o resto seria rodar metade do desenho — publicar colaboração é o chunk 6).

`npm run verify` (build → format → lint com tipos → typecheck → coverage) está
verde. Rode primeiro, antes de tocar em qualquer coisa, para confirmar que a
base que você herdou está no estado que este documento descreve.

## A API do motor que você vai orquestrar

`@bpmn-flow/core` (`../bpmn-flow/packages/core/src`), classe `WorkflowEngine`
(`engine/engine.ts`), processo único — `CollaborationEngine` (múltiplos pools)
fica para o chunk 6, não toque nele agora:

```ts
new WorkflowEngine(process: ProcessModel, options?: EngineOptions)
engine.start(): Promise<ExecutionSnapshot>
engine.completeTask(tokenId, output?): Promise<ExecutionSnapshot>
engine.signal(nameOrId, output?): Promise<ExecutionSnapshot>
engine.tick(now?): Promise<ExecutionSnapshot>
engine.retryTask(tokenId): Promise<ExecutionSnapshot>
engine.resolveIncident(tokenId, output?): Promise<ExecutionSnapshot>
engine.tasks(filter?): PendingTask[]
engine.snapshot(): ExecutionSnapshot
engine.getState(): EngineState                       // serializável, JSON-safe
WorkflowEngine.restore(process, state, options?): WorkflowEngine
engine.resume(): Promise<ExecutionSnapshot>           // depois de restore()
```

`ENGINE_STATE_VERSION` está em 9 agora (`engine/state.ts`) — `restore()`
recusa uma versão diferente. Isso importa: se este chunk persistir
`EngineState` cru, um `bpmn-flow` atualizado no meio do caminho pode invalidar
journal antigo. Não precisa resolver migração de `EngineState` agora (é risco
conhecido, documentado no design doc), mas não finja que o problema não
existe — pelo menos falhe com uma mensagem clara em vez de um erro genérico do
motor.

`executableProcess(model)` / `findExecutableProcess(model)`
(`model/executable.ts`) escolhem o processo executável de um `BpmnModel` — use
para resolver qual processo instanciar a partir de um `Deployment.xml`, o
mesmo padrão que `packages/cli/src/commands.ts` já usa no `deploy`.

## O chunk 1, ao pé da letra

Da tabela de chunks do design doc:

> **Runtime durável + journal** — termina quando: mata o processo no meio da
> execução, sobe de novo, ele continua de onde parou.

Ou seja: `@ebb/runtime` (pacote novo) dá ciclo de vida de instância ao
`WorkflowEngine`, `@ebb/store` ganha o esquema de instância + journal, e
`@ebb/cli` ganha os comandos para operar uma instância (nomes e forma exata
são decisão sua, documente no `--help`).

### O que o journal precisa ser, e por quê

Grave **agora** o journal completo — comando aplicado + o que ele disparou —
mesmo que este chunk não replay a partir dele. Motivo: é a base do chunk 3
(time-travel). Journal que só nasce no chunk 3 significa que toda instância
criada antes dele é opaca para sempre; journal desde o chunk 1 significa que a
primeira instância de produção já pode ser rebobinada quando o recurso
existir. Isso é o tipo de decisão que sai caro para trocar depois — pense nela
com cuidado antes de escrever a primeira migração.

O que precisa estar no journal, por comando aplicado a uma instância: tipo do
comando, payload (tokenId/output, nome do sinal, etc.), número de sequência
por instância, quando foi aplicado. O estado resultante (`engine.getState()`)
é persistido **na mesma transação** que a entrada do journal — nunca um sem o
outro. Se a escrita falhar no meio, nem o journal nem o snapshot podem ter
avançado.

### Barra de aceitação

1. Um teste que cria uma instância, "mata o processo" (o CLI já é stateless
   por natureza — cada invocação é um processo novo; siga o padrão de
   `packages/cli/test/bin.test.ts`, que roda o binário **construído**, não os
   fontes, num diretório temporário, com `execFile` entre invocações
   separadas) e mostra que uma segunda invocação vê exatamente o estado que a
   primeira deixou: variáveis, tarefa pendente, histórico.
2. Um teste que prova a atomicidade jornal+estado: simule falha no meio da
   escrita (uma dublê de storage que lança depois do primeiro `INSERT` de uma
   transação, por exemplo) e confirme que nem o journal nem o snapshot
   avançaram — não que um avançou e o outro não.
3. `npm run verify` verde, incluindo o teste do binário construído.

### Fora de escopo deste chunk (não é preguiça, é ordem)

- **Handlers externos / workers** — chunk 2. Sem eles, toda execução deste
  chunk é síncrona e determinística por construção; não crie um mecanismo de
  worker/fila agora.
- **Replay funcional a partir do journal** — chunk 3 (time-travel). Grave o
  journal; reconstruir estado _a partir dele_ (em vez de a partir do snapshot
  persistido) é trabalho de outro chunk.
- **Postgres** — chunk 8. `Store` já é uma interface por causa disso; não
  comece a implementação de Postgres agora.
- **`CollaborationEngine` / múltiplos pools** — chunk 6.
- **Timers automáticos em background** (um scheduler que chama `tick()`
  sozinho) — não é a barra de aceitação deste chunk. Se aparecer naturalmente,
  documente como decisão, não como obrigação.

## Como trabalhar neste repo

- **Skill de brainstorming primeiro.** Isto é arquitetural (subsistema novo,
  pacote novo) — classifique como tal, passe pelas perguntas, proponha 2-3
  abordagens para o esquema de journal/instância antes de escrever a primeira
  linha. Não pule para bounded só porque "runtime" soa familiar.
- TDD normal para feature nova (não é bug, não precisa do teste-que-falha-
  primeiro do fluxo de correção — mas cada unidade de comportamento ganha
  teste antes ou junto).
- Um commit por unidade lógica, Conventional Commits, `npm run verify` em
  cada um antes de seguir para o próximo.
- Defeito encontrado em `@bpmn-flow/core` é corrigido **lá**, com teste lá, no
  padrão que o histórico do `bpmn-flow` já mostra (veja
  `9a7870b fix(core): stop demanding a start event from a black-box pool` —
  foi assim que o chunk 0 tratou um defeito achado no meio do trabalho). Não
  contorne no lado do ebb.
- Linha de SQLite não vira tipo por `as` — passa por `packages/store/src/rows.ts`
  (ou você estende o padrão dele), que falha dizendo qual coluna veio errada.
