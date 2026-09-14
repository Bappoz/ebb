# ebb — desenho

> Decidido em 2026-09-14. Substitui conversa, não código: quando o código
> divergir daqui, este documento é que está errado.

## O problema

Não existe plataforma de orquestração BPMN 2.0 livre e nativa em TypeScript.

| Alternativa              | O que tem                  | Por que não serve                                                                                                |
| ------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Camunda 8                | BPMN completo, maturidade  | Exige licença de produção desde a 8.6 (out/2024); sobe com Zeebe + Elasticsearch + Operate + Tasklist + Identity |
| Camunda 7                | Era a opção livre          | Community EOL em out/2025                                                                                        |
| Operaton, Flowable, jBPM | BPMN livre de verdade      | JVM, operação pesada                                                                                             |
| Temporal                 | Execução durável excelente | Não é BPMN: não há diagrama que a área de negócio leia                                                           |
| n8n, Windmill            | Integrações                | Não são motor de processo: sem compensação, boundary event, multi-instância, correlação                          |

O `bpmn-flow` já resolve a parte difícil — parser, motor de tokens com a
semântica da especificação, estado serializável, viewer com replay. Falta o que
transforma biblioteca em plataforma.

## O diferencial

O motor é **determinístico dado (estado, sequência de comandos)** e aceita
`now` injetável, handlers plugáveis e expressões avaliadas sem compilar código.
Então o histórico não precisa ser uma sequência de fotografias:

```
journal  = [comando, resultado dos handlers que ele disparou]*
replay(n) = motor novo + journal[0..n], handlers servindo do journal
```

Disso saem três coisas que nenhum concorrente tem juntas:

1. **Rebobinar** uma instância de produção e andar passo a passo no diagrama.
2. **Explicar** por que um gateway foi por ali: a condição e as variáveis
   daquele instante.
3. **Bifurcar**: replay até o passo N e seguir ao vivo com outras variáveis.

O não-determinismo fica onde sempre fica — dentro do handler — e é neutralizado
journalando o resultado, como o Temporal faz com activity. Isso é **contrato**:
handler que lê relógio, sorteia ou chama serviço externo tem o resultado
gravado, e o replay serve o gravado em vez de executar de novo.

## Decisões

| Decisão                | Escolha                              | Porquê                                                                  |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Diferencial que lidera | Time-travel + teste de processo      | É o único que o core já sustenta sem trabalho novo de motor             |
| Público                | Dev-first                            | SDK, CLI, processo versionado em git; a UI opera e atende tarefa humana |
| Persistência           | SQLite primeiro, Postgres no chunk 8 | `node:sqlite`: zero dependência nativa, zero build de instalação        |
| Node mínimo            | 24                                   | `node:sqlite` estável sem flag                                          |
| Licença                | Apache-2.0, sem edição paga          | É o argumento inteiro: o Camunda que continuou de graça                 |

## Arquitetura

```
@ebb/store        SQLite (padrão) · Postgres (chunk 8) — deployments, journal, snapshots
@ebb/runtime      ciclo de vida da instância sobre WorkflowEngine/CollaborationEngine
@ebb/api          HTTP + WebSocket (Hono), auth, tenant
@ebb/sdk          defineWorker, startInstance, correlate, tipos gerados do diagrama
@ebb/testing      integração Vitest: relógio determinístico, dublês, asserção de caminho
@ebb/connectors   HTTP, Postgres, SMTP, Slack, S3, LLM
@ebb/cli          ebb dev · deploy · test · rewind
apps/console      instâncias, inbox de tarefa e incidente, depurador de time-travel
```

Consome `@bpmn-flow/core` e `@bpmn-flow/viewer`. **Não** consome
`@bpmn-flow/server` — aquilo é demonstração; o runtime aqui é outro bicho, e o
`bpmn-flow` continua utilizável sozinho como biblioteca.

## Os chunks

| #     | Chunk                     | Termina quando                                                                 |
| ----- | ------------------------- | ------------------------------------------------------------------------------ |
| **0** | **Fundação**              | `ebb deploy pedido.bpmn` versiona e `ebb ls` lista                             |
| 1     | Runtime durável + journal | Mata o processo no meio da execução, sobe de novo, continua de onde parou      |
| 2     | Workers e jobs            | Worker em outro processo executa a service task, com retry e incidente         |
| 3     | **Time-travel**           | Rebobinar uma instância no navegador e andar passo a passo no diagrama         |
| 4     | **Teste de processo**     | `npm test` falha porque um caminho do diagrama nunca foi exercitado            |
| 5     | Tarefa humana + console   | Uma pessoa conclui uma tarefa no navegador, com formulário vindo das variáveis |
| 6     | Mensagem e correlação     | "pedido 42 pago" chega na instância certa, vindo de fora                       |
| 7     | Conectores                | Processo chama API e posta no Slack sem uma linha de código                    |
| 8     | Operação                  | Dois nós no mesmo Postgres, um morre, o trabalho continua                      |

Chunks 0–4 são o MVP: é o que prova o diferencial. Parar ali ainda deixa algo
único e usável. 5–8 é o que faz virar substituto de Camunda.

## Chunk 0 — o que ele é

Fundação e o primeiro ciclo fechado: publicar e listar definição de processo.

- Esqueleto do monorepo com os mesmos portões do `bpmn-flow`
  (format → lint → typecheck → coverage), Apache-2.0, CI nos Node 24 e 26.
- `@ebb/store`: contrato de persistência + implementação SQLite, com migração
  de esquema versionada desde a primeira tabela.
- `@ebb/cli`: `deploy`, `ls`, `versions`.

Regras que o chunk 0 fixa e os seguintes herdam:

- **Versão é por conteúdo.** `deploy` do mesmo arquivo não cria versão nova;
  qualquer byte diferente cria. Deduplica só contra a última versão — voltar a
  um conteúdo antigo é uma mudança, e merece número próprio.
- **A validação do core é levada a sério.** Erro barra a publicação. Aviso
  barra também, e `--force` é como se diz "eu sei" — porque em produção o custo
  de um diagrama pela metade é uma instância que trava, não uma mensagem no log.
- **`.ebb/` é do projeto**, como `node_modules/`: trocar de projeto não leva
  junto o que foi publicado no outro.

## Riscos

| Risco                                          | Mitigação                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Replay depende de handler determinístico       | Journal do resultado; contrato documentado no SDK                              |
| `ENGINE_STATE_VERSION` sobe e invalida journal | Journal guarda comandos, não estado do motor; snapshot é cache descartável     |
| `@bpmn-flow/core` não está no npm              | Dependência de caminho, com os dois repos lado a lado no CI; sai na publicação |
| Escopo de produto, não de biblioteca           | Chunks fecham em algo demonstrável; MVP é 0–4                                  |

## O que isto cobra do `bpmn-flow`

Os pontos de extensão já existem (`registerHandler`, `options.now`,
`getState`/`restore`, `on`). Duas coisas ficam em aberto:

1. Evento de "condição avaliada" — hoje o _porquê_ de um gateway é
   reconstruído a partir de `flow.take`, não gravado.
2. História de migração quando `ENGINE_STATE_VERSION` sobe: hoje `restore()`
   recusa e pronto.

Já corrigido no caminho do chunk 0: `validate()` exigia evento de início de
pool caixa-preta, o que impediria publicar qualquer colaboração.
