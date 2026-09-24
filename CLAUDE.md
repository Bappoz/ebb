# ebb

Orquestração de processos BPMN 2.0 que dá para rebobinar. Monorepo npm
workspaces, TypeScript, Apache-2.0. Consome `@bpmn-flow/core` (motor) e
`@bpmn-flow/viewer` (diagrama) — o motor mora em `../bpmn-flow` e **não** se
mexe nele daqui sem dizer.

## A ideia

O motor do `bpmn-flow` é determinístico dado (estado, sequência de comandos) e
aceita relógio e handlers injetados. Então o ebb grava um **journal** de
`[comando, resultado dos handlers]` e reconstrói qualquer passo de qualquer
instância: rebobinar produção, explicar por que um gateway foi por ali, e
bifurcar a partir do passo N com outras variáveis. É o diferencial e é o que
decide as escolhas de arquitetura — nada pode quebrar a reprodutibilidade.

## Pacotes

| Pacote         | O que é                                                            |
| -------------- | ------------------------------------------------------------------ |
| `@ebb/store`   | Persistência. SQLite via `node:sqlite`; Postgres quando houver HA. |
| `@ebb/runtime` | Ciclo de vida de instância: aplica, journala, persiste, replaya.   |
| `@ebb/cli`     | `ebb deploy`, `ebb ls`, `ebb versions`, e o ciclo de instância.    |

Os demais (`api`, `sdk`, `testing`, `connectors`, `console`) entram nos chunks
seguintes — ver `docs/superpowers/specs/`.

## Comandos

```bash
npm install          # instala e builda (script `prepare`)
npm run verify       # build → format → lint → typecheck → coverage
npm test
node packages/cli/dist/bin.js ls
```

`verify` é o que o CI roda, na mesma ordem. Vermelho = não está pronto.

## Regras desta base

- **Node >= 24** por causa do `node:sqlite`: persistência sem dependência
  nativa é o que sustenta "sobe com um comando e nenhuma infraestrutura".
- Sem dependência nova sem justificar. A conta a bater é sempre a mesma:
  subir o ebb não pode exigir Elasticsearch, JVM nem build nativo.
- Linha do SQLite não vira tipo por `as`: passa por `rows.ts`, que falha
  dizendo qual coluna veio errada.
- Nada que quebre determinismo do replay entra sem estar journalado.
- Defeito encontrado no motor vira correção em `../bpmn-flow`, com teste lá —
  não contorno aqui.
- Comentário explica o **porquê**. Docstring e identificador em inglês;
  conversa, README e docs em PT-BR.
