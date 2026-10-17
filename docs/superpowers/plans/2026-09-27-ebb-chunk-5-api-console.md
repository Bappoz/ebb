# Plano — chunk 5 (API e console operacional)

1. Expandir `@ebb/api` com tipos públicos e rotas de processos, start/inspect,
   tarefas humanas e incidentes.
2. Cobrir validação de corpo, mídia, token incorreto, instância ausente e estado
   terminal com testes HTTP.
3. Estender os guardas e o cliente do console para todas as novas respostas.
4. Evoluir as rotas por hash para dashboard, tarefas, incidentes e debugger.
5. Construir o shell visual, dashboard, master-detail, formulários inferidos e
   modal de início sem framework e sem assets externos.
6. Verificar o fluxo real no navegador, inclusive viewport compacto.
7. Atualizar README, handoff e rodar a verificação completa do workspace.

## Critério de término

Com um BPMN publicado, o navegador inicia uma instância, mostra a tarefa na
fila, aceita valores, continua o processo e permite tratar incidentes. Testes,
lint, tipos, build e cobertura permanecem verdes.
