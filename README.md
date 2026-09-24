# ebb

Orquestração de processos **BPMN 2.0** que você pode rebobinar.

Livre de verdade (Apache-2.0), nativo em TypeScript, e sobe com um comando —
sem JVM, sem Elasticsearch, sem build nativo.

> **Estado: chunk 2 de 8.** Publica definições, roda instâncias com journal
> durável e entrega service tasks a workers em outro processo, com retry e
> incidente. O time-travel vem no próximo.
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
```

Mate o processo entre um comando e outro: o estado está no `.ebb/ebb.db`, e a
próxima invocação continua de onde a anterior parou.

O banco fica em `.ebb/ebb.db`, relativo ao diretório de trabalho — como
`node_modules/`, é do projeto. Mude com `--store` ou `EBB_STORE`.

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
| `@ebb/cli`     | Definições, instâncias, jobs, incidentes e `ebb worker`.           |

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
