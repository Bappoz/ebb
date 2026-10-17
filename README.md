# ebb

Orquestração de processos **BPMN 2.0** que você pode rebobinar.

Livre de verdade (Apache-2.0), nativo em TypeScript, e sobe com um comando —
sem JVM, sem Elasticsearch, sem build nativo.

> **Estado: chunks 0–5 de 8.** O MVP técnico está fechado: publica definições,
> roda instâncias com journal durável, entrega jobs a workers, rebobina e
> bifurca execuções no navegador e testa caminhos BPMN com cobertura de
> `sequenceFlow`. A operação local já inclui tarefas humanas e incidentes.
> Desenho completo em [`docs/superpowers/specs/2026-09-14-ebb-design.md`](docs/superpowers/specs/2026-09-14-ebb-design.md).

## Por que existe

| Alternativa              | Por que não serve                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Camunda 8                | Exige licença de produção desde a 8.6; sobe com Zeebe + Elasticsearch + Operate + Tasklist + Identity |
| Camunda 7                | Community chegou ao fim da vida em outubro de 2025                                                    |
| Operaton, Flowable, jBPM | BPMN livre, mas JVM e operação pesada                                                                 |
| Temporal                 | Execução durável excelente — mas não é BPMN, não há diagrama que o negócio leia                       |
| n8n, Windmill            | Integração, não processo: sem compensação, boundary event, multi-instância                            |

Não existe plataforma BPMN livre e nativa em TypeScript. O motor
([`bpmn-flow`](https://github.com/Bappoz/bpmn-flow)) já resolve a parte difícil.

## O diferencial

O motor é determinístico dado (estado, sequência de comandos) e aceita relógio e
handlers injetados. Então o ebb grava um **journal** de
`[comando, resultado dos handlers]` — e com ele reconstrói qualquer passo de
qualquer instância:

- **rebobinar** uma instância de produção e andar passo a passo no diagrama;
- **explicar** por que um gateway foi por ali — a condição e as variáveis
  daquele instante;
- **bifurcar**: replay até o passo N e seguir ao vivo com outras variáveis.

Camunda, Flowable e Temporal não têm isso.

## Começando

Precisa de Node 24 ou mais novo (`node:sqlite` sem flag).

```bash
git clone https://github.com/Bappoz/ebb.git
cd ebb
npm install                       # instala e builda
node packages/cli/dist/bin.js --help
```

```bash
ebb deploy processo.bpmn          # valida e publica
ebb ls                            # o que está publicado
ebb versions Process_Compras      # o histórico de uma definição
```

```
✓ publicado: Processo de Compras (Process_Compras) v1

PROCESSO             CHAVE            ATUAL  HISTÓRICO  PUBLICADO                 ORIGEM
Processo de Compras  Process_Compras  v1     1 versão   2026-09-14T11:55:23.453Z  processo-compras.bpmn
```

```bash
ebb start Pedido --var total=42     # instancia; imprime o id
ebb ps                              # o que está rodando
ebb show <id>                       # estado, variáveis, pendências
ebb complete <id> <token>           # conclui a tarefa parada
ebb journal <id>                    # os comandos aplicados, em ordem
ebb show <id> --at 2                # a instância depois do passo 2, e o porquê de cada gateway
ebb fork <id> --at 1                # instância nova a partir do passo 1; a original não muda
```

Mate o processo entre um comando e outro: o estado está no `.ebb/ebb.db`, e a
próxima invocação continua de onde a anterior parou.

O banco fica em `.ebb/ebb.db`, relativo ao diretório de trabalho — como
`node_modules/`, é do projeto. Mude com `--store` ou `EBB_STORE`.

### Rebobinar e bifurcar

O snapshot no banco é só um atalho: qualquer passo de qualquer instância se
reconstrói a partir do journal. `show --at` mostra a instância como estava
depois daquele comando e, para cada gateway, a condição que decidiu e as
variáveis daquele instante:

```
passo 2 de 2 — completeTask em 2026-09-24T16:09:12.663Z
{"tokenId":"t1","output":{"valor":150}}

entrou em: Gateway_Valor, Diretoria

GATEWAY
Gateway_Valor: "valor > 100" → Flow_Alto (valor=150)
```

`fork --at` cria uma instância nova parada naquele passo, com o journal
copiado até ali, e a original fica intacta. O valor diferente entra pelo
comando de sempre (`ebb complete <novo> t1 --var valor=50`). A bifurcação é
viva: um job pendente no passo do corte volta para a fila, e um worker o
executa.

### No navegador

```bash
ebb console                         # http://127.0.0.1:4321
```

O console abre em uma visão operacional: instâncias em andamento, tarefas
humanas, incidentes e processos publicados. **Minha fila** transforma as
variáveis visíveis da tarefa em controles editáveis e continua o processo sem
sair do navegador. **Incidentes** permite tentar a atividade de novo ou
resolvê-la com valores corrigidos. **Nova instância** escolhe uma definição
publicada e recebe as variáveis iniciais em JSON.

Ao abrir uma execução, o depurador pinta no BPMN o que concluiu, o que espera e
os fluxos tomados. O slider anda comando a comando — voltar despinta o que o
passo fez — e mostra payload, variáveis e a razão de cada gateway. "Bifurcar
daqui" cria uma instância nova a partir do passo e a abre. O passo fica na URL
(`#/i/<id>?step=2`), então o link leva ao mesmo lugar.

**Modelagem** abre o BPMN Studio: importe um `.bpmn`, edite no canvas, valide e
navegue dos diagnósticos aos elementos do diagrama. Em navegadores com acesso
seguro a arquivos, ele salva no arquivo escolhido e detecta alterações externas;
nos demais, oferece download da cópia editada. Publicar a versão pelo Studio e
selecionar arquivos por uma árvore do projeto seguem no roadmap.

Ele só atende em `127.0.0.1` e recusa `Host` de fora: ainda não há auth.

### API local

O mesmo servidor oferece JSON para automação local. Escritas exigem
`Content-Type: application/json`.

| Método e rota                                      | Operação                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/processes`                               | Lista definições publicadas.                                               |
| `POST /api/instances`                              | Inicia por `processKey`, com `version`, `variables` e `retries` opcionais. |
| `GET /api/instances/:id`                           | Inspeciona o estado atual.                                                 |
| `GET /api/instances/:id/replay`                    | Reconstrói todos os passos do time-travel.                                 |
| `POST /api/instances/:id/fork`                     | Bifurca no `seq` informado.                                                |
| `GET /api/tasks`                                   | Lista tarefas humanas pendentes.                                           |
| `POST /api/tasks/:instanceId/:tokenId/complete`    | Conclui uma tarefa com `output` opcional.                                  |
| `GET /api/incidents`                               | Lista incidentes abertos com contexto.                                     |
| `POST /api/incidents/:instanceId/:tokenId/retry`   | Tenta a atividade novamente.                                               |
| `POST /api/incidents/:instanceId/:tokenId/resolve` | Resolve o incidente com `output` opcional.                                 |

### Workers: a service task fora do processo

Uma atividade marcada no diagrama como job externo **espera** por um worker em
vez de passar direto. Vale a convenção do Camunda 8 ou a do Camunda 7:

```xml
<bpmn:serviceTask id="Charge" name="Cobrar">
  <bpmn:extensionElements>
    <zeebe:taskDefinition type="charge" />
  </bpmn:extensionElements>
</bpmn:serviceTask>
<!-- ou: <bpmn:serviceTask camunda:type="external" camunda:topic="charge" /> -->
```

```bash
ebb start Pedido --var total=42 --retries 2   # tentativas automáticas antes do incidente
ebb jobs                                      # o trabalho esperando worker
ebb worker charge -- ./charge.sh              # noutro terminal: executa os jobs "charge"
ebb incidents                                 # o que parou por falha
ebb retry <id> <token>                        # roda a atividade de novo
ebb resolve <id> <token> --var cobrado=false  # desiste e segue como se tivesse dado certo
```

O `ebb worker` roda **um processo filho por job**. O contrato com o seu script:

| Entrada / saída                                        | O que acontece                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| stdin                                                  | JSON: `{ instanceId, tokenId, nodeId, type, variables }`            |
| saída 0, stdout um objeto                              | o objeto vira variáveis do processo                                 |
| saída 0, stdout vazio                                  | conclui sem variável nova                                           |
| saída 0, stdout ilegível                               | **falha** — um worker que imprime lixo não sabe o que fez           |
| saída ≠ 0                                              | falha técnica: retry e depois incidente, com o stderr como mensagem |
| saída ≠ 0 com `{"error":{"code","message"}}` no stdout | erro de negócio: dispara o boundary de erro do diagrama             |

> **Cuidado com o erro de negócio.** Sem um boundary event de erro casando com o
> `code`, ele **derruba a instância inteira** — não abre incidente, não faz
> retry, não há o que resolver. Use `code` só quando o diagrama o captura.

Opções: `--once` (uma rodada e sai), `--lease <ms>` (padrão 60000), `--interval
<ms>` entre sondagens vazias, `--count <n>` jobs por rodada. Um worker que
morre segurando um job o devolve **quando o lease vence** — não por heartbeat.
Não há timeout de processo filho: um script que trava mantém o worker parado,
embora o job volte para a fila no fim do lease.

### Testar o processo como código

`@ebb/testing` roda cada cenário em SQLite na memória, com relógio controlado e
dublês de worker que passam pelo mesmo journal da produção. A fixture acumula os
fluxos tomados entre cenários; o matcher final faz o CI falhar e lista cada
`sequenceFlow` que ficou sem teste.

```ts
import { afterAll, expect, test } from 'vitest';
import { testProcess } from '@ebb/testing';
import { installEbbMatchers } from '@ebb/testing/vitest';
import { PEDIDO } from './pedido.js';

installEbbMatchers(expect);
const pedido = await testProcess(PEDIDO, {
  workers: {
    charge: async ({ variables }) => ({ cobrado: variables.total }),
  },
});

test('valor alto passa pela diretoria', async () => {
  const run = await pedido.start();
  await run.complete('Avaliar', { valor: 150 });

  expect(run).toHaveVisited('Diretoria');
  expect(run).toHaveTaken('Flow_Alto');
});

test('valor baixo segue direto', async () => {
  const run = await pedido.start();
  await run.complete('Avaliar', { valor: 50 });

  expect(run).toHaveTaken('Flow_Baixo');
});

afterAll(() => {
  expect(pedido.coverage()).toHaveFullFlowCoverage();
  pedido.close();
});
```

Timers não dormem no teste: `await run.advanceBy(60_000)` avança o relógio e
aplica `tick`. Um dublê que lança `BpmnError` percorre o boundary de negócio;
outro erro usa o retry e o incidente configurados na instância.

### Publicar é um portão, não um upload

`deploy` roda a validação do `@bpmn-flow/core` e **recusa** um diagrama com
erro. Aviso também barra, e `--force` é como se diz "eu sei": em produção, o
custo de um diagrama pela metade é uma instância travada, não uma linha de log.

Versão é por conteúdo: republicar o mesmo arquivo não cria versão nova, e
qualquer byte diferente cria.

## Como está dividido

| Pacote         | O que é                                                            |
| -------------- | ------------------------------------------------------------------ |
| `@ebb/store`   | Persistência. SQLite via `node:sqlite`; Postgres quando houver HA. |
| `@ebb/runtime` | Ciclo de vida de instância: aplica comando, journala, persiste.    |
| `@ebb/testing` | Fixture Vitest, relógio, workers dublês e cobertura BPMN.          |
| `@ebb/api`     | HTTP local para o console e integrações.                           |
| `@ebb/cli`     | Definições, instâncias, jobs, incidentes e `ebb worker`.           |
| `apps/console` | Operação, tarefas, incidentes e depurador visual de time-travel.   |

## Desenvolvimento

```bash
npm run verify   # build → format → lint → typecheck → coverage
npm test
```

`verify` é exatamente o que o CI roda, na mesma ordem.

`@bpmn-flow/core` ainda não está no npm, então entra como dependência de
caminho e os dois repositórios ficam lado a lado — no seu disco e no CI. Isso
sai quando o pacote for publicado.

## Licença

[Apache-2.0](LICENSE). Sem edição paga, sem funcionalidade atrás de muro — é o
argumento inteiro.
