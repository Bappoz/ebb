# Chunk 4 — teste de processo

> Decidido em 2026-09-27. Este chunk fecha o MVP do desenho original: um
> processo BPMN passa a ser testado como código, inclusive os caminhos que a
> suíte ainda não percorreu.

## Resultado de produto

Um teste cria uma fixture a partir do XML, inicia quantas instâncias precisar,
controla o relógio, conclui tarefas por `nodeId` e substitui workers por funções.
No fim, o Vitest consegue falhar tanto por comportamento errado quanto por um
`sequenceFlow` nunca exercitado.

```ts
const pedido = await testProcess(PEDIDO, {
  workers: { charge: async ({ variables }) => ({ charged: variables.total }) },
});

const run = await pedido.start({ variables: { total: 150 } });
await run.complete('Avaliar', { aprovado: true });

expect(run).toHaveVisited('Diretoria');
expect(run).toHaveTaken('Flow_Alto');
expect(pedido.coverage()).toHaveFullFlowCoverage();
```

## Decisões

- A fixture usa `SqliteStore(':memory:')` e `EbbRuntime`; não existe um motor
  alternativo de teste.
- Um dublê de worker é ativado, concluído ou falhado pelas mesmas APIs da
  produção. Sua saída e suas falhas entram no journal como `completeJob` e
  `failJob`.
- Um `BpmnError` lançado pelo dublê representa erro de negócio; outro erro é
  técnico e percorre retry/incidente normalmente.
- Workers registrados rodam automaticamente até a instância estabilizar. Job
  sem dublê continua pendente, permitindo testá-lo explicitamente.
- O relógio é monotônico e compartilhado por store e runtime. `advanceTo` e
  `advanceBy` também aplicam `tick` à execução.
- “Visitado” significa que há um evento `enter` no histórico. “Fluxo tomado”
  vem do replay do journal, não é inferido pela vizinhança dos nós.
- A cobertura agrega todas as execuções criadas pela mesma fixture e inclui
  fluxos de subprocessos. A falha no CI é explícita pelo matcher
  `toHaveFullFlowCoverage`; não há efeito global escondido ao importar o pacote.

## Superfície pública

- `withClock(initial?)` → relógio controlável.
- `testProcess(xml, options?)` → `ProcessTest`.
- `ProcessTest.start`, `worker`, `coverage`, `close`.
- `ProcessRun.complete`, `signal`, `tick`, `advanceTo`, `advanceBy`,
  `runWorkers`, `apply`.
- `ebbMatchers` e `installEbbMatchers(expect)` para Vitest.
- Matchers: `toHaveVisited`, `toHaveTaken`, `toHaveFullFlowCoverage`.

## Fora do chunk

- Um reporter automático do Vitest. O matcher já entrega o portão de CI sem
  estado global ou arquivos intermediários; um reporter pode ser acrescentado
  quando houver uma convenção de configuração pública.
- Persistência em arquivo, processos filhos e concorrência de workers. Esses
  comportamentos continuam cobertos nos pacotes de runtime/store/CLI.

## Termina quando

Dois cenários do mesmo gateway cobrem 100% dos fluxos; remover um deles faz o
matcher de cobertura falhar e listar exatamente o fluxo ausente. O mesmo teste
prova relógio determinístico e um worker dublê journalado como produção.
