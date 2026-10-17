# Plano — chunk 4 (`@ebb/testing`)

1. Adicionar o workspace `packages/testing`, build, tipos e integração ao build
   raiz.
2. Implementar relógio monotônico e testá-lo isoladamente.
3. Implementar `ProcessTest`/`ProcessRun` sobre store e runtime reais.
4. Implementar dublês de worker com sucesso, erro técnico e erro BPMN.
5. Extrair fluxos do modelo, acumular os ids observados no replay e produzir o
   relatório de cobertura.
6. Integrar matchers tipados ao Vitest e provar mensagens de falha úteis.
7. Adicionar exemplo ao README, atualizar o estado do roadmap e executar
   `npm run verify`.
