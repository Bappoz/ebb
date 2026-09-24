# Handoff — roteiro até virar produto

> Escrito ao final do chunk 2 (workers e jobs), 2026-09-24. Substitui o handoff
> anterior, que só cobria o chunk 3 — este cobre tudo que falta para o ebb
> deixar de ser "MVP interessante" e virar algo que alguém de fora escolhe no
> lugar de Camunda/Temporal. Dividido em seções fechadas: trabalhe uma por
> sessão, brainstorming → spec → plano → implementação, como os chunks 0-2.
> Se o código divergir daqui, o código está certo; corrija a seção ao terminá-la.

## Onde estamos

Chunks 0-3a mergeados em `master` (PRs #1, #2 e #3; no `bpmn-flow`, #58 e
#61). **Chunk 3b (console de time-travel) entregue** na branch
`feat/console-time-travel`: spec em
`docs/superpowers/specs/2026-09-24-ebb-chunk-3b-console.md`, plano ao lado,
`npm run verify` verde e o roteiro do "termina quando" verificado no Chrome.
**A Seção 1 está fechada.** O próximo passo é a **Seção 2** (teste de processo).

As regras que os chunks 1-3b fixaram (relógio congelado por comando, versão
congelada na instância, journal+snapshot atômicos, job é decisão do diagrama,
`onHandlerError`/`retry` journalados fora do `EngineState`, reporte≠contabilidade
de incidente, `jobs` como índice reconciliado com lease fenced, snapshot é cache
que o journal reconstrói, bifurcação é viva, HTTP só em loopback até existir
auth) continuam valendo — ver os commits
de cada chunk para o raciocínio.

## Dívida técnica que sobrou

A dívida do chunk 2 foi paga no 3a: typecheck de teste, guarda do
`EngineState`, `db` privado, decode UTF-8, `updated_at` só quando muda,
contenção do lease com dois processos reais e o `activity.end` órfão (este no
`bpmn-flow`, PR #61). Ficam:

- `ebb incidents` re-hidrata cada instância (O(n)); projetar incidente como se
  projeta job resolveria, mas só vale a pena se alguém sentir a dor.
- **Resolução de prefixo de id mora no CLI** (`withInstance`), já com dois
  consumidores. O HTTP do 3b usa o id completo (a lista o entrega), então não
  virou o terceiro; mover para `EbbRuntime` quando alguma rota aceitar prefixo.
- Menores do 3a: `fork` com comando que falha deixa a bifurcação gravada sem
  avisar quem chamou (o HTTP do 3b não aceita comando, então ainda sem efeito);
  `show --at` lê o journal duas vezes; o teste da cópia das variáveis do gateway
  não exercita a cópia; `forkInstance` aceita `at = 0`.
- Sem timeout de processo filho no `ebb worker` — decisão deliberada, mas um
  filho que vaza o fd do stdout para um neto trava o worker (o lease ainda
  devolve o job).
- `replayJournal` é O(n) por chamada e cada passo carrega a `history`
  acumulada (O(n²) de memória). Remédio conhecido: history só no último passo.

---

## Seção 1 — Time-travel

> Termina quando: rebobinar uma instância no navegador e andar passo a passo
> no diagrama, vendo variáveis e o caminho tomado em cada gateway.

Fatiada em dois ciclos. **3a feito**: `replayJournal` puro, `EbbRuntime.replay`
e `fork`, `ebb show --at` e `ebb fork --at`, snapshot como cache (versão de
motor nova ou snapshot inválido reconstroem pelo journal, e o próximo comando
regrava). A razão do gateway saiu **sem mudar o motor**: um `decide` que só
registra e devolve `undefined`. Isso fecha a pendência de "evento de condição
avaliada" do design geral. Event-based gateway fica de fora, porque ali a razão
é o próprio comando.

**3b feito**: `ebb console` sobe o `@ebb/api` (Hono) em `127.0.0.1` com três
rotas (`GET /api/instances`, `GET /api/instances/:id/replay`,
`POST /api/instances/:id/fork`) e serve o `apps/console` (Vite + TS, sem
framework). O depurador anda passo a passo (slider, ◀ ▶, setas), pinta do zero
a cada passo para que voltar despinte, mostra variáveis e cada gateway com as
opções e a tomada, e bifurca a partir do passo. O passo vive na URL
(`#/i/<id>?step=n`).

---

## Seção 2 — Teste de processo (`@ebb/testing`)

> Termina quando: `npm test` falha porque um caminho do diagrama nunca foi
> exercitado.

Este é o outro grande diferencial do design (ao lado do time-travel) e hoje
não tem nem esqueleto. Sem ele, "processo testável como código" é só slogan.

Trabalho:

1. **Relógio determinístico injetável** já existe no motor (`now: () =>
number`); o pacote precisa expor isso como fixture de teste (`withClock`,
   `advanceTo`).
2. **Dublê de worker**: em vez de subir `ebb worker` de verdade, um handler de
   teste que intercepta por `type` do job e devolve/journala uma saída fixa —
   sem processo filho, sem SQLite real (ou com SQLite `:memory:`).
3. **Asserção de caminho**: dado um diagrama e uma sequência de comandos,
   afirmar que os nós X, Y, Z foram visitados e W não foi. Precisa de acesso à
   `history` do `ExecutionSnapshot`, que já existe.
4. **Cobertura de diagrama**: análogo a cobertura de linha — de todos os flows
   do BPMN, quantos foram exercitados pela suíte. Isto é o gancho de
   marketing mais forte do pacote ("seu CI falha se um `<sequenceFlow>` nunca
   rodou") e não existe em nenhum concorrente hoje.
5. Integração com Vitest (o design já decide isso) via matcher customizado
   (`expect(snapshot).toHaveVisited('NodeId')`) e um reporter opcional de
   cobertura de diagrama.

Decisão em aberto: o dublê de worker jornala como se fosse produção (mesmo
`completeJob`/`failJob`) ou é um caminho de teste separado que nunca toca o
store? Recomendo o primeiro — mantém o teste honesto sobre o que realmente
roda em produção — mas precisa de brainstorming antes de codar.

---

## Seção 3 — Tarefa humana + `@ebb/api` + console

> Termina quando: uma pessoa conclui uma tarefa no navegador, com formulário
> vindo das variáveis do processo.

O `@ebb/api` já existe desde o 3b: Hono, `createApp({ store, runtime, assets })`
e `serveApp` (sempre em `127.0.0.1`). A proteção de hoje vem do lugar em que
roda: `Host` fora de loopback → `403` (DNS rebinding) e escrita sem
`Content-Type: application/json` → `415` (CSRF). **Auth substitui a trava de
loopback em vez de se somar a ela às cegas**: no dia em que o servidor sair de
127.0.0.1, a checagem de `Host` e a de `Content-Type` precisam ser repensadas
junto com a API key, não herdadas.

Trabalho:

1. **`@ebb/api`** cresce: rotas para
   instância (start/apply/inspect), jobs (ativar/completar/falhar — mesmo
   contrato do `ebb worker`, mas por HTTP long-poll em vez de processo
   filho), tarefas humanas (listar/completar).
2. **Auth**: mínimo viável é API key por processo/tenant; multi-tenant de
   verdade é seção 6 (operação). Não empurrar OAuth/SSO para cá sem alguém
   pedindo.
3. **Formulário de tarefa humana**: o BPMN não tem schema de formulário
   nativo padronizado (Camunda usa `camunda:formData`, Zeebe usa
   `zeebe:userTask` + JSON forms). Decidir: gerar formulário das variáveis
   visíveis no escopo (schema-less, mais simples, menos preciso) ou suportar
   a extensão do Camunda (mais trabalho, mais compatível com diagrama
   existente). Brainstorming decide isso antes de codar.
4. **`apps/console`**: inbox de tarefa (lista + completar) e lista de
   incidente (reusa o que o CLI já faz, mas na web). O depurador de
   time-travel já existe (3b); "bifurcar com valores novos" entra aqui, junto
   com o formulário.
5. Mover a resolução de prefixo de id (`withInstance`) para `EbbRuntime`
   agora que o HTTP é o terceiro consumidor — dívida nomeada desde o chunk 1.

---

## Seção 4 — Mensagem e correlação

> Termina quando: "pedido 42 pago" chega na instância certa, vindo de fora.

O motor (`@bpmn-flow/core`) já tem `correlate(name, key, output)` e
`subscribedTo(name, key)` — isto é principalmente fiação no ebb, não trabalho
novo de motor.

Trabalho:

1. **Comando `correlate`** em `InstanceCommand`, mesma forma dos outros
   (`applyCommand` cresce mais um `case`).
2. **Roteamento**: dado um nome de mensagem e uma chave de correlação, achar
   _qual_ instância aceita — hoje `subscribedTo` responde por instância; o
   ebb precisa varrer (ou indexar) para saber qual instância entre N está
   esperando aquele par (nome, chave). Isto é candidato a uma tabela de
   índice, no mesmo espírito da `jobs`: projeção derivável, reconciliada.
3. **`ebb message <nome> --key <valor> --var k=v`** no CLI e a rota
   equivalente em `@ebb/api` (webhook genérico: um endpoint HTTP que aceita
   `{ name, key, output }` e entrega).
4. Decisão em aberto: o que acontece quando nenhuma instância aceita a
   mensagem? Hoje o motor simplesmente descarta (`correlate` não lança). Vale
   um outbox/dead-letter no ebb, ou fica documentado como "mensagem perdida é
   normal, seu processo deve tratar timeout"? Trade-off de produto, não só
   técnico.

---

## Seção 5 — Conectores

> Termina quando: processo chama API e posta no Slack sem uma linha de
> código.

Isto é o que mais aproxima o ebb de n8n/Zapier em superfície, mas mantendo
BPMN como fonte da verdade — é o argumento "sem código para o business, com
código para quem precisa" do design.

Trabalho:

1. **`@ebb/connectors`**: HTTP, Postgres, SMTP, Slack, S3, LLM (ordem do
   design). Cada conector é, na prática, um handler pré-registrado
   parametrizado pelo `extensionElements` do nó — mesma mecânica de
   `FlowNode.job`, mas resolvido _dentro_ do processo em vez de esperar
   worker externo.
2. **Aqui a coluna `effects` do journal deixa de ser adiável.** Conectores
   têm não-determinismo de verdade (resposta de API varia, timestamp de
   SMTP, etc.) e rodam in-process — é exatamente o caso que a coluna existe
   para resolver. Migração de schema + o contrato "todo handler que lê
   relógio, sorteia ou chama serviço externo tem o resultado journalado".
3. **Credenciais**: nunca no diagrama (regra do CLAUDE.md do usuário —
   segredo só por env/`.env`). Definir onde o ebb guarda referência a
   segredo por conector (nome de env var, ou um vault mínimo) antes de
   escrever o primeiro conector.
4. Ordem sugerida de entrega: HTTP primeiro (mais genérico, sem SDK de
   terceiro), depois Slack e SMTP (alto valor de demo), Postgres/S3/LLM
   depois.

---

## Seção 6 — Operação (Postgres + HA)

> Termina quando: dois nós no mesmo Postgres, um morre, o trabalho continua.

O maior chunk de infraestrutura pura. SQLite é decisão deliberada para
dev/single-node; Postgres é o que permite produção multi-nó.

Trabalho:

1. **Segunda implementação de `Store`** sobre Postgres, mesma interface —
   `@ebb/store` já separa contrato de implementação (`SqliteStore` de hoje é
   uma das duas). `node:sqlite`'s `BEGIN IMMEDIATE` + busy_timeout vira
   `SELECT ... FOR UPDATE SKIP LOCKED` ou equivalente para `lockJobs`.
2. **Migração de schema versionada** já existe (`SCHEMA_VERSION`); replicar o
   padrão para Postgres, mas com migração de verdade (não `CREATE TABLE IF
NOT EXISTS` ingênuo — Postgres em produção precisa de `pg-migrate` ou
   similar, decisão a tomar).
3. **Multi-nó**: mais de um processo `ebb worker`/`@ebb/api` apontando pro
   mesmo Postgres, sem coordenação além do que o banco já dá (locks). Testar
   matando um nó no meio de um `lockJobs` e confirmando que o outro segue.
4. **Scheduler de timer em background** — hoje `tick` é manual em todo o
   projeto; isto é o chunk certo para introduzir um loop que dispara timers
   vencidos sem comando explícito, porque só faz sentido com HA de verdade
   por trás (senão é um processo único de novo, sem ganho sobre `cron + ebb
tick`).

---

## Seção 7 — O que separa "roadmap cumprido" de "produto"

As 8 seções acima fecham o design original. Isto aqui é o que falta além
dele — sem isto, o ebb é um MVP tecnicamente impressionante que ninguém de
fora consegue avaliar ou adotar.

### 7.1 — `@ebb/sdk`

Está no design (`defineWorker`, `startInstance`, `correlate`, tipos gerados
do diagrama) e nunca foi mencionado em nenhum chunk. Sem SDK, "worker" hoje é
"escreva um script que lê JSON do stdin" — funciona, mas ninguém compara isso
com o SDK do Temporal e sai satisfeito. Prioridade: depois da seção 3 (HTTP),
porque o SDK provavelmente fala com `@ebb/api`, não com o store direto.
Gerar tipos TypeScript a partir do BPMN (variáveis declaradas, nomes de nó)
é o gancho técnico mais forte para "dev-first" do design.

### 7.2 — Documentação pública e site

Hoje a documentação é o README + specs internas. Falta: um site com os
mesmos três argumentos do design (rebobinar, testar como código, sem
Elasticsearch) em forma de landing page, um "getting started" de 5 minutos
independente do README, e exemplos de diagrama reais (não só fixtures de
teste) — um processo de pedido de compra, um onboarding, algo que alguém
reconheça da própria vida.

### 7.3 — Observabilidade

Nada disso existe ainda: métricas (quantas instâncias rodando, jobs
pendentes por tipo, incidentes abertos — dado que já está no store, falta só
expor), logs estruturados (hoje é `console.log`/`console.error` cru no CLI),
tracing distribuído quando `@ebb/connectors` chamar serviço externo. Prioridade
baixa até ter usuário real reclamando de não enxergar o que acontece.

### 7.4 — Segurança além de auth básica

Rate limiting em `@ebb/api`, isolamento de tenant de verdade (hoje nem existe
o conceito), auditoria de quem completou qual tarefa/resolveu qual incidente
(o journal já tem "o quê" e "quando"; falta "quem" — campo de ator no
comando, provavelmente entra em qualquer seção que toque `InstanceCommand`).

### 7.5 — Deploy e distribuição

`npm install && npm run build` funciona para dev. Falta: imagem Docker
oficial, um `docker-compose.yml` de exemplo com Postgres (pós seção 6), e
decidir se existe oferta hospedada (mantendo Apache-2.0 sem edição paga —
decisão já fixada no design; hospedagem é modelo de negócio ortogonal à
licença, tipo GitLab).

### 7.6 — Posicionamento competitivo

Documento (não código) comparando ebb com Camunda 8, Zeebe standalone,
Temporal e n8n nos eixos que o design já usa (licença, infraestrutura,
BPMN completo vs. parcial, time-travel, teste como código). Isto é o que
convence alguém a experimentar em vez de continuar com o que já usa — vale
mais como página do site (7.2) do que como doc interna.

### 7.7 — Comunidade / OSS

`CONTRIBUTING.md`, template de issue/PR, um roadmap público (pode ser este
próprio arquivo, limpo de jargão interno), e decidir cedo se aceita PR
externo antes do chunk 8 fechar (superfície ainda muda rápido demais para
isso ser produtivo agora).

---

## Ordem sugerida

Dívida do chunk 2 → Seção 1 (time-travel) → Seção 2 (teste de processo) —
essas duas são o diferencial, valem mais que qualquer chunk de infra. Depois
Seção 3 (HTTP/console) libera 7.1 (SDK) e 7.7 parcialmente. Seções 4-6
(mensagem, conectores, operação) na ordem do design original. 7.2-7.6 correm
em paralelo a qualquer seção técnica, sempre que sobrar sessão — não bloqueiam
nada e não são bloqueadas por nada.

## Como trabalhar neste repo

- Brainstorming antes de código; TDD; um commit por unidade lógica,
  Conventional Commits **em inglês**; `npm run verify` verde em cada commit.
- Defeito em `@bpmn-flow/core` se corrige **lá**, com teste lá, por PR — foi
  assim com `restore()` (PR #55) e com o estado de espera de job (PR #58).
- Linha do SQLite não vira tipo por `as`: passa por `packages/store/src/rows.ts`.
- Antes de `npm`/`npx` no Bash não-interativo: `unset -f node npm npx
2>/dev/null; export PATH=/usr/bin:$PATH`. No zsh, `$VAR` com espaço não faz
  split — use função.
