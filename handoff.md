# Handoff — chunk 2: workers e jobs

> Escrito ao final da sessão que entregou o chunk 1. Esta é a _única_ fonte de
> contexto que a próxima sessão precisa — não releia a conversa anterior, ela
> não existe mais para você. Se algo aqui contradizer o código do repo, o
> código está certo e este documento está desatualizado; diga isso e corrija
> ao final do chunk.

## O que é o ebb, em dois parágrafos

Plataforma de orquestração BPMN 2.0 sobre o motor do `bpmn-flow`
(`../bpmn-flow`, repositório irmão, consumido como dependência de caminho
porque ainda não está no npm). Existe porque não há alternativa livre e nativa
em TypeScript: Camunda 8 exige licença de produção, Camunda 7 Community morreu,
o que resta de BPMN livre é JVM, e o que é Node não é motor de processo.

O diferencial: o motor é determinístico dado `(estado, sequência de comandos)`.
Um **journal** de `[comando, resultado dos handlers que ele disparou]`
reconstrói qualquer passo de qualquer instância. Desenho completo com os 8
chunks: [`docs/superpowers/specs/2026-09-14-ebb-design.md`](docs/superpowers/specs/2026-09-14-ebb-design.md).

Decisões não renegociáveis: SQLite via `node:sqlite`, Node ≥ 24, Apache-2.0 sem
edição paga, dev-first, build **sem bundle** (`bundle: false` em `tsup.base.ts`
— o esbuild normaliza `node:sqlite` para `sqlite`, que não resolve, e só o
binário construído mostra isso).

## O que já existe (chunks 0 e 1, entregues)

```
packages/store/src/
  types.ts        Deployment, Instance*, Journal*, Store (a interface)
  sqlite.ts       SqliteStore — node:sqlite; toda operação devolve Promise mesmo
                  falhando (helper `promised`), para o contrato não mentir
  migrations.ts   esquema versionado; SCHEMA_VERSION = 2
  tx.ts           transaction(db, fn) — interno ao pacote, não é API pública
  instances.ts    mapeadores linha→objeto das três tabelas de instância
  rows.ts         leitura de coluna com tipo — nunca `as` numa linha do SQLite
  checksum.ts     checksumOf(xml)

packages/runtime/src/
  commands.ts     InstanceCommand (união discriminada) + applyCommand + payloadOf
  runtime.ts      EbbRuntime: start / apply / inspect — sem estado entre comandos
  errors.ts       InstanceNotFoundError, EngineStateMismatchError

packages/cli/src/
  commands.ts     deploy, list, versions      instances.ts  os 7 de instância
  bin.ts          argv                        vars.ts       --var k=v
  output.ts       CHECK/CROSS/WARN/table      paths.ts      resolveStorePath
```

`npm run verify` verde: 92 testes, cobertura 96.41/86.11/97.08/98.18 contra
pisos de 90/85/90/90. **Rode primeiro**, antes de tocar em qualquer coisa.

### As três regras que o chunk 1 fixou

1. **O relógio é congelado por comando.** O motor lê `this.now()` uma vez por
   entrada de histórico (`engine/engine.ts`, método `record`) e uma por timer
   agendado; `history` faz parte de `EngineState`. Com relógio de parede, dois
   replays do mesmo comando produzem estados diferentes. Medido: `start()` no
   diagrama de teste gera 3 entradas com 3 instantes distintos. Todo motor
   construído ou restaurado recebe `now: () => at`, e `at` é o que o journal
   grava.
2. **A versão do deployment é congelada na criação da instância.** `hydrate`
   carrega `store.read(instance.processKey, instance.version)`, nunca a mais
   recente: um redeploy não troca o modelo debaixo de quem está rodando.
3. **Journal e snapshot na mesma transação.** `createInstance` e `append`
   escrevem entrada do journal + snapshot + linha da instância ou nada. O
   snapshot é cache (uma linha sobrescrita por instância); o journal é a verdade.

### O que o journal guarda, e por quê

```
instance_journal(instance_id, seq, type, payload, at, recorded_at)
```

`at` é o relógio do **motor** (o que o replay reinjeta); `recorded_at` é o de
parede (auditoria). Divergem num `tick --at`.

O payload do `start` guarda `variables` **e** `engine: { mode, maxSteps,
expressions }`, lidos de volta de `engine.getState()` — valores resolvidos, não
presumidos. Isso não é zelo: `ENGINE_STATE_VERSION` foi de 9 para 10 no meio do
chunk 1 justamente porque `expressions` entrou no `EngineState`. Como o snapshot
é uma linha sobrescrita, do seq 2 em diante o valor original não sobrevive em
lugar nenhum que um replay do zero alcance. Sem isso, o próximo bump tornaria
irreplayável, em silêncio, toda instância já criada.

## O chunk 2, ao pé da letra

> **Workers e jobs** — termina quando: um worker em outro processo executa a
> service task, com retry e incidente.

Hoje toda execução é síncrona: sem handler registrado, uma service task passa
direto. O chunk 2 põe o trabalho fora do processo do CLI.

### O que o journal vai precisar ganhar

O desenho geral define journal como `[comando, resultado dos handlers que ele
disparou]`. A metade dos handlers **não existe ainda** — de propósito, porque
no chunk 1 não há handler nenhum e coluna vazia não guarda informação. Agora
passa a haver.

`ALTER TABLE instance_journal ADD COLUMN effects TEXT` numa migração 3 é barato
e não perde nada do que já está gravado. O que **não** dá para adiar é o
contrato: todo handler que lê relógio, sorteia ou chama serviço externo tem o
resultado journalado, e o replay serve o gravado em vez de executar de novo. É
isso que neutraliza o não-determinismo, como o Temporal faz com activity.

### A API do motor que você vai usar

```ts
engine.registerHandler(selector, handler)   // por node id, kind, ou '*'
engine.retryTask(tokenId)                   // roda de novo a partir do incidente
engine.resolveIncident(tokenId, output?)
engine.incidentList(): IncidentState[]
new WorkflowEngine(p, { onHandlerError: 'fail' | 'incident', retry: { attempts, delay } })
```

`applyCommand` (`packages/runtime/src/commands.ts`) é a **única** porta por onde
um comando toca o motor — ao vivo e, no chunk 3, no replay. `retryTask` e
`resolveIncident` viram variantes novas de `InstanceCommand` ali; a união é
exaustiva sem `default`, então o `tsc` recusa se você esquecer um caso.

### Fora de escopo (é ordem, não preguiça)

Replay a partir do journal (chunk 3) · Postgres (8) · `CollaborationEngine` (6)
· scheduler de timer em background — o `tick` continua manual.

## Dívida conhecida, com endereço

- **Resolução de prefixo de id mora no CLI.** `packages/cli/src/instances.ts`
  (`withInstance`) fala direto com `store.findInstances`, passando por cima do
  `@ebb/runtime`. Não é defeito hoje; vira duplicação quando o chunk 4 expuser
  HTTP e a regra de ambiguidade ganhar um segundo consumidor. Mover para o
  `EbbRuntime` quando isso acontecer.
- **`apply` não tem guarda de status terminal.** Um `tick` numa instância
  concluída acrescenta entrada no-op no journal para sempre. Determinístico,
  não corrompe — mas o que uma instância terminada responde a um comando é
  decisão que o chunk 2 ou 3 precisa tomar.
- **`append` lê o próximo `seq` fora da transação.** Dentro de um processo é
  seguro (`node:sqlite` é síncrono). Entre processos, a PK `(instance_id, seq)`
  faz o perdedor falhar limpo com rollback. Concorrência otimista de verdade é
  do chunk 8.
- **Três ramos sem teste, todos triados e aceitos:** o não-`Error` de
  `message()` (`cli/src/instances.ts` — a regra `prefer-promise-reject-errors`
  impede escrever o dublê, e o repo não tem nenhum `eslint-disable`); o `throw`
  do `hydrate` para versão que deixou de estar publicada (exigiria API de apagar
  deployment); e o teste ponta a ponta de `--version` malformado.
- **`@ebb/cli` importa `@bpmn-flow/core` direto** para `parseBpmn`/`validateBpmn`
  no `deploy`. Precede o chunk 1. Se o runtime virar dono exclusivo do motor,
  isto é o que sobra para mover.

## Como trabalhar neste repo

- **Skill de brainstorming antes de escrever código.** O chunk 2 é arquitetural
  (subsistema novo, contrato de handler). Proponha abordagens antes.
- TDD: cada unidade de comportamento ganha teste antes ou junto.
- Um commit por unidade lógica, Conventional Commits, **em inglês**;
  `npm run verify` verde em cada um.
- Defeito em `@bpmn-flow/core` se corrige **lá**, com teste lá, e vai por PR —
  foi assim com `restore()` perdendo o modo de expressão (PR #55, `3a01ddf`).
- Linha do SQLite não vira tipo por `as`: passa por `packages/store/src/rows.ts`.
- O shell do Bash não carrega o `.zshrc` inteiro: antes de `npm`/`npx`, rode
  `unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH`.
