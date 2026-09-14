# ebb

Orquestração de processos **BPMN 2.0** que você pode rebobinar.

Livre de verdade (Apache-2.0), nativo em TypeScript, e sobe com um comando —
sem JVM, sem Elasticsearch, sem build nativo.

> **Estado: chunk 0 de 8.** Publica e versiona definição de processo. O runtime
> durável, os workers e o time-travel vêm nos próximos.
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

O banco fica em `.ebb/ebb.db`, relativo ao diretório de trabalho — como
`node_modules/`, é do projeto. Mude com `--store` ou `EBB_STORE`.

### Publicar é um portão, não um upload

`deploy` roda a validação do `@bpmn-flow/core` e **recusa** um diagrama com
erro. Aviso também barra, e `--force` é como se diz "eu sei": em produção, o
custo de um diagrama pela metade é uma instância travada, não uma linha de log.

Versão é por conteúdo: republicar o mesmo arquivo não cria versão nova, e
qualquer byte diferente cria.

## Como está dividido

| Pacote       | O que é                                                            |
| ------------ | ------------------------------------------------------------------ |
| `@ebb/store` | Persistência. SQLite via `node:sqlite`; Postgres quando houver HA. |
| `@ebb/cli`   | `deploy`, `ls`, `versions`.                                        |

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
