# Handoff — chunk 3: time-travel

> Escrito ao final da sessão que entregou o chunk 2. Esta é a _única_ fonte de
> contexto que a próxima sessão precisa. Se algo aqui contradizer o código do
> repo, o código está certo e este documento está desatualizado; diga isso e
> corrija ao final do chunk.

## O que é o ebb

Plataforma de orquestração BPMN 2.0 sobre o motor do `bpmn-flow`
(`../bpmn-flow`, dependência de caminho). O motor é determinístico dado
`(estado, sequência de comandos)`; um **journal** de comandos reconstrói
qualquer passo de qualquer instância. Desenho: `docs/superpowers/specs/`.
Decisões fixas: SQLite via `node:sqlite`, Node ≥ 24, Apache-2.0, build **sem
bundle**.

## O que existe (chunks 0–2)

`@ebb/store` (deployments, instâncias, journal, snapshot, tabela `jobs`),
`@ebb/runtime` (`EbbRuntime`: start / apply / inspect / activateJobs /
completeJob / failJob), `@ebb/cli` (definições, instâncias, `jobs`,
`incidents`, `retry`, `resolve`, `worker`). `npm run verify` verde; **rode
primeiro**.

### Regras que os chunks 1–2 fixaram

1. **Relógio congelado por comando** — o `at` do journal é o que o replay reinjeta.
2. **Versão do deployment congelada** na criação da instância.
3. **Journal e snapshot na mesma transação**; o snapshot é cache.
4. **Job é decisão do diagrama**, nunca de handler registrado nem de opção de
   motor — senão o replay dependeria de quais workers estavam conectados.
5. **`onHandlerError` e `retry` não fazem parte do `EngineState`.** Quem os
   lembra é o payload do `start` no journal, e o `hydrate` os repassa ao
   `restore` a cada comando. Defaults do ebb: `'incident'` e `{ attempts: 0 }`.
6. **Reporte ≠ contabilidade.** `incidentList()` responde "o que segura um token
   agora"; `getState().incidents` guarda o contador de tentativas de todos.
   Misturar os dois faz o orçamento de retry reiniciar a cada comando.
7. **A tabela `jobs` é índice derivado**, reconciliada na transação do append;
   preserva a trava de um job que continua parado. `releaseJob` é fenced por
   worker e best-effort; sem worker informado, cai no lease.

## O chunk 3

> **Time-travel** — termina quando: rebobinar uma instância no navegador e
> andar passo a passo no diagrama.

Pede replay a partir do journal. O que o chunk 2 deixou pronto: todo comando é
dado passando por `applyCommand`, incluindo `completeJob`/`failJob`, e o
`failJob` grava `{ message, code? }` (um `Error` não sobrevive a `JSON.stringify`).

## Dívida conhecida, com endereço

- **Segurança do lease sob contenção real não tem teste.** Um teste com dois
  `SqliteStore` no mesmo processo é impossível (`node:sqlite` é síncrono). O
  teste em `packages/cli/test/bin.test.ts` usa dois processos de verdade mas
  nada força a sobreposição — é rede de regressão contra dupla conclusão, não
  prova de contenção. Uma prova real exige ponto de sincronização controlado.
- **`packages/*/test/` fica fora do `tsc --noEmit`** (cada tsconfig inclui só
  `src/`). Tornar um campo obrigatório não aponta chamadores em teste — isso
  mordeu quatro vezes neste chunk. Proposta: `tsconfig.test.json`.
- **`@ebb/store` e `@ebb/runtime` são consumidos via `dist/`**: um `vitest run`
  parcial sem `npm run build` falha de forma enganosa quando a superfície muda.
- `JSON.parse(stored.json) as EngineState` em `runtime.ts` (`hydrate`) viola a
  regra de "sem `as` em saída de parse" que o guarda novo respeita.
- `SqliteStore.db` virou `protected` só para um teste ler o pragma; um
  acessor dedicado seria mais estreito.
- A correção do decode UTF-8 do `ebb worker` (`Buffer.concat` antes de
  `toString`) não tem teste; dá para testar sem processo.
- `reconcileJobs` atualiza `updated_at` em todo comando, mesmo sem mudança.
- `activity.end` é emitido sem `activity.start` quando um worker devolve
  `BpmnError` (o park de job não emite `start`).
- `ebb incidents` re-hidrata cada instância (O(n)); a saída é projetar
  incidente como se projeta job.
- **Resolução de prefixo de id mora no CLI** (`withInstance`): já tem dois
  consumidores; o terceiro (HTTP, chunk 4) é o gatilho para mover ao `EbbRuntime`.
- A coluna `effects` do journal segue **não existindo**: não há handler local
  com não-determinismo até o dublê do `@ebb/testing` (4) ou os conectores (7).
- Sem timeout de processo filho no `ebb worker`: um filho que vaza o fd de
  stdout para um neto mantém o worker parado (o lease devolve o job).

## Como trabalhar neste repo

- Brainstorming antes de código; TDD; um commit por unidade lógica,
  Conventional Commits **em inglês**; `npm run verify` verde em cada commit.
- Defeito em `@bpmn-flow/core` se corrige **lá**, com teste lá, por PR — foi
  assim com `restore()` (PR #55) e com o estado de espera de job (PR #58).
- Linha do SQLite não vira tipo por `as`: passa por `packages/store/src/rows.ts`.
- Antes de `npm`/`npx` no Bash não-interativo: `unset -f node npm npx
2>/dev/null; export PATH=/usr/bin:$PATH`. No zsh, `$VAR` com espaço não faz
  split — use função.
