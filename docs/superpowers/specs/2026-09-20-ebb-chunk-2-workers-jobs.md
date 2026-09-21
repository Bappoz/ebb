# ebb chunk 2 — workers e jobs

> Decidido em 2026-09-20, sobre o desenho geral em
> [`2026-09-14-ebb-design.md`](2026-09-14-ebb-design.md) e o chunk 1 em
> [`2026-09-14-ebb-chunk-1-runtime-journal.md`](2026-09-14-ebb-chunk-1-runtime-journal.md).
> Substitui conversa, não código: quando o código divergir daqui, este
> documento é que está errado.

## O que o chunk termina

Um worker em **outro processo** executa a service task, com retry e incidente.

Em concreto: em dois terminais, `ebb worker charge -- ./charge.sh` completa a
service task de uma instância iniciada no outro. Matar o worker segurando o job
o devolve por vencimento do lease. Um `exit 1` consome os retries e para como
incidente, que `ebb retry` refaz e `ebb resolve` encerra.

## O achado que decide o desenho

Hoje **não existe estado em que um token espera trabalho de fora do processo**.
`handleActivity` (`engine/engine.ts:839`) resolve o handler e o roda inline,
dentro do `drain()`; sem handler, `userTask`/`receiveTask` parqueiam e qualquer
outra atividade **passa direto** (`engine/engine.ts:849`). As razões de espera
são seis, e nenhuma é job (`engine/types.ts:9`).

Então o chunk 2 começa por um PR no `@bpmn-flow/core`. Duas restrições moldam
esse PR:

1. **Nada de `EngineOption` nova.** A razão de espera é serializada como string
   no token (`engine/state-serializer.ts:70`), então o valor `'job'` não muda a
   forma de `EngineState`. Uma opção que altera a execução, sim: pelo precedente
   do chunk 1 — `expressions` entrou em `EngineState` e levou
   `ENGINE_STATE_VERSION` de 9 para 10 — ela teria de entrar no estado, e todo
   snapshot já gravado seria invalidado.
2. **Nada de "é job porque há um worker registrado".** Se a decisão viesse do
   registro de handler, o replay dependeria de quais workers estavam conectados
   na hora de rodar — o chunk 3 inteiro cai. Quem decide é o **diagrama**, que
   já está congelado na versão da instância (regra 2 do chunk 1).

## O PR no `bpmn-flow`

### Parser

O tipo de job vem do diagrama, nas duas convenções que ferramenta real emite.
Ambas as formas foram verificadas contra o `bpmn-moddle` 10.2 instalado, sem
extensão de moddle:

| Convenção | Onde cai no moddle |
| --------- | ------------------ |
| `<zeebe:taskDefinition type="ship" retries="3"/>` sob `extensionElements` | `extensionElements.values[]` com `$type: 'zeebe:taskDefinition'` e `type`/`retries` como propriedades diretas (strings) |
| `camunda:type="external" camunda:topic="charge"` no próprio elemento | `el.$attrs['camunda:type']` / `el.$attrs['camunda:topic']` |

Vira um campo normalizado no modelo:

```ts
FlowNode.job?: { type: string; retries?: number }
```

`retries` é o do diagrama quando declarado; quem o usa é o host, não o motor.
Diagrama sem nenhuma das duas marcações não ganha `job` e continua se
comportando como hoje.

### Motor

```
WaitReason        += 'job'
PendingTask.job?:  { type: string }
engine.failJob(tokenId, error: Error): Promise<ExecutionSnapshot>
```

`handleActivity` ganha um ramo **antes** do "passa direto": nó com `node.job` e
**sem handler local** parqueia como `'job'`. Handler local continua vencendo —
é o que mantém verde o que existe hoje e o que deixa o `@ebb/testing` do chunk
4 dublar um job sem subir worker nenhum.

Retomar reusa `completeTask(tokenId, output)`, que já aceita qualquer token
parado (`engine/engine.ts:175`). Falhar entra por `failJob`, que reaproveita
`handleFailure` (`engine/engine.ts:886`): `retry.attempts`/`delay` e incidente
saem prontos e já testados. Um `BpmnError` vindo do worker toma o mesmo caminho
de boundary de erro do `catch` de hoje (`engine/engine.ts:867`).

`tasks({ reason: 'job' })` passa a listar job pendente, com as variáveis do
escopo — é a mesma superfície do inbox de tarefa humana.

**Sem bump de `ENGINE_STATE_VERSION`.**

## Modelo de dados no ebb

Migração 3: uma tabela, escrita **na mesma transação** do journal e do
snapshot. A verdade continua sendo o journal; `jobs` é índice, como o snapshot
— existe porque um worker precisa varrer trabalho pendente de todas as
instâncias sem re-hidratar motor nenhum.

```sql
CREATE TABLE jobs (
  instance_id   TEXT    NOT NULL,
  token_id      TEXT    NOT NULL,   -- o token parado no motor
  node_id       TEXT    NOT NULL,
  type          TEXT    NOT NULL,   -- o que o worker pede por nome
  variables     TEXT    NOT NULL,   -- JSON do escopo visível à atividade
  state         TEXT    NOT NULL,   -- 'pending' | 'locked' | 'done'
  worker        TEXT,               -- quem segura, quando locked
  locked_until  INTEGER,            -- epoch ms; lease, não heartbeat
  attempts      INTEGER NOT NULL,   -- projeção de incidentList(); só para exibir
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  PRIMARY KEY (instance_id, token_id),
  FOREIGN KEY (instance_id) REFERENCES instances (id) ON DELETE CASCADE
);
CREATE INDEX jobs_pending ON jobs (type, state, locked_until);
```

A projeção é **derivada, nunca autoritativa**: depois de cada comando, o
runtime reconcilia a tabela com `engine.tasks({ reason: 'job' })` — job que
sumiu do motor sai, job novo entra, job que continua parado fica como está
(inclusive a trava). Reconstruí-la do zero é sempre possível a partir do
journal, e é o que o chunk 3 fará de graça.

`attempts` é projeção de `engine.incidentList()`, para o `ebb jobs` dizer algo
útil — a contagem autoritativa é a do motor, que é quem compara com
`retry.attempts`. Duplicá-la aqui como contador próprio criaria duas verdades.

Um job que falha deixa de ser job: o token passa a esperar por `'incident'`,
some de `tasks({ reason: 'job' })` e a reconciliação apaga a linha. `ebb retry`
roda a atividade de novo, ela volta a parar sem handler, e a linha reaparece —
com `attempts` já diferente de zero. É por isso que a reconciliação não pode
ser um `INSERT OR IGNORE`: ela é uma diferença nos dois sentidos.

`locked_until` é lease porque é o único mecanismo que sobrevive à morte do
worker sem processo residente do outro lado: um `ebb worker` morto não avisa
ninguém, e o vencimento é o que devolve o job.

### O que **não** entra: a coluna `effects`

O handoff do chunk 1 previa `ALTER TABLE instance_journal ADD COLUMN effects
TEXT` aqui. Não entra, e o motivo é o mesmo pelo qual ela não existe hoje: o
chunk 2 não introduz **nenhum handler local** — o trabalho sai do processo
justamente para não ser handler, e o resultado do worker chega como *payload de
comando*, que o journal já guarda. A coluna nasceria vazia.

`effects` entra quando houver handler in-process com não-determinismo de
verdade: o dublê do `@ebb/testing` (chunk 4) ou os conectores (chunk 7). O
contrato continua valendo, só não tem sujeito ainda.

## O comando como dado

`InstanceCommand` (`packages/runtime/src/commands.ts`) ganha quatro variantes. A
união é exaustiva sem `default`, então o `tsc` cobra cada ponto que precise
tratá-las:

```ts
| { type: 'completeJob'; tokenId: string; output?: Record<string, unknown> }
| { type: 'failJob'; tokenId: string; error: { message: string; code?: string } }
| { type: 'retryTask'; tokenId: string }
| { type: 'resolveIncident'; tokenId: string; output?: Record<string, unknown> }
```

`completeJob` chama `engine.completeTask`; `failJob` reconstrói o erro
(`BpmnError` quando há `code`, `Error` caso contrário) e chama `engine.failJob`;
os outros dois chamam os homônimos do motor. Tudo por `applyCommand` — porta
única, ao vivo e no replay do chunk 3.

`error` é gravado como dado, não como `Error`: um `Error` não sobrevive a
`JSON.stringify` e o replay precisa reproduzir exatamente a mesma falha.

## `@ebb/runtime`

```ts
activateJobs(options: { type: string; worker: string; count?: number; lease?: number }): Promise<ActivatedJob[]>
completeJob(instanceId: string, tokenId: string, output?): Promise<CommandResult>
failJob(instanceId: string, tokenId: string, error: { message: string; code?: string }): Promise<CommandResult>
```

`activateJobs` **não aplica comando nenhum**: só trava linhas pendentes (ou com
lease vencido) e as devolve com as variáveis. Trava não é evento de negócio e
não entra no journal — o que entra é o desfecho, `completeJob` ou `failJob`. Um
job travado e nunca concluído não deixa rastro na instância, que é o
comportamento certo: para a instância, nada aconteceu.

`completeJob` e `failJob` passam por `apply`, que já re-hidrata, journala e
persiste. A reconciliação da tabela `jobs` acontece dentro da mesma transação de
`append`.

### Guarda de status terminal

Fecha a dívida que o chunk 1 deixou endereçada: comando em instância
`completed`, `terminated` ou `failed` falha com `InstanceTerminatedError` em vez
de acrescentar entrada no-op no journal para sempre. `inspect` continua livre —
ler uma instância terminada é o caso normal.

## Superfície do CLI

| Comando | O que faz |
| ------- | --------- |
| `ebb jobs [--type t] [--instance id]` | trabalho pendente, com estado e lease |
| `ebb worker <type> -- <comando>` | trava job, roda o comando por job, conclui ou falha |
| `ebb incidents` | atividades paradas por falha, com tentativas e mensagem |
| `ebb retry <token>` | roda a atividade de novo a partir do incidente |
| `ebb resolve <token> [--var k=v]` | desiste e segue como se tivesse dado certo |

`ebb worker` roda **um processo filho por job**: variáveis em JSON no stdin,
stdout JSON vira o output do job, código de saída diferente de zero vira
`failJob` com o stderr como mensagem. É a forma mais honesta de provar "outro
processo" sem inventar protocolo: long-poll HTTP só faz sentido a partir do
chunk 4, quando existe `@ebb/api`.

O loop é `--once` (uma rodada e sai, que é o que o teste usa) ou contínuo com
intervalo de sondagem. Sem processo residente obrigatório, como no resto do ebb.

## Testes

- **Parser**: as duas convenções viram `FlowNode.job`; diagrama sem marcação não
  ganha `job`; `retries` malformado é ignorado, não quebra a publicação.
- **Motor**: nó com `job` e sem handler parqueia com `reason: 'job'`; com
  handler local, o handler ganha; `completeTask` segue o fluxo; `failJob`
  consome `retry.attempts` e depois vira incidente; `failJob` com `BpmnError`
  aciona o boundary de erro.
- **Store**: reconciliação (job some, entra, permanece travado); lease vencido
  volta a ser ativável; duas ativações concorrentes não entregam o mesmo job.
- **Runtime**: `completeJob`/`failJob` journalam com o mesmo relógio congelado;
  job travado e abandonado não deixa entrada no journal; comando em instância
  terminal falha.
- **CLI**: ponta a ponta com processo filho de verdade (um script que ecoa JSON,
  outro que sai com 1), em banco temporário — o mesmo padrão dos testes do
  chunk 1.

## Fora de escopo

Replay a partir do journal (chunk 3) · Postgres (8) · `CollaborationEngine` (6)
· scheduler de timer em background — o `tick` continua manual · long-poll ou
streaming de job (4, com o `@ebb/api`) · a coluna `effects`, pelo motivo acima.

## O que isto cobra do `bpmn-flow`

Um PR, antes de qualquer linha de ebb: `WaitReason: 'job'`, `FlowNode.job` lido
das duas convenções, `PendingTask.job` e `engine.failJob`. Com teste lá, como
manda o CLAUDE.md dos dois repos.
