# Chunk 5 — operação local por API e console

## Resultado

Uma pessoa abre `ebb console`, entende o estado da operação, inicia um processo,
conclui uma tarefa humana e trata um incidente sem usar a CLI. A mesma superfície
fica disponível como JSON local para integrações na máquina.

## Escopo

- Listar processos e iniciar/inspecionar instâncias.
- Listar tarefas humanas e concluí-las com saída opcional.
- Listar incidentes com variáveis de contexto, tentar novamente ou resolver.
- Manter replay e bifurcação existentes.
- Dashboard, inbox de tarefas, central de incidentes e modal de nova instância.
- Layout responsivo, sem fonte ou asset externo.

Workers HTTP, autenticação, exposição de rede, multi-tenant e formulários BPMN
com schema ficam fora deste recorte. A API continua exclusivamente em loopback;
auth e exposição precisam ser projetadas juntas.

## Contrato HTTP

Leituras respondem JSON. Toda escrita exige `Content-Type: application/json` e
um objeto JSON, inclusive retry sem parâmetros (`{}`). Erros de entrada usam
`400`, mídia incompatível `415`, instância ausente `404` e instância terminal
`409`.

O endpoint de tarefa só aceita token cuja razão seja `userTask`; jobs externos
não podem ser concluídos por ele. Retry e resolve validam que o token ainda tem
incidente aberto.

## Formulário e visual

O formulário é schema-less por decisão deliberada: string vira texto, number
vira número, boolean vira seleção, objeto/array vira JSON. A saída adicional
permite acrescentar chaves ainda inexistentes.

A navegação usa uma barra lateral escura e um workspace claro. Roxo indica ação
e seleção, verde sucesso, âmbar espera e vermelho fica reservado a falhas. Em
janelas compactas a barra lateral vira ícones e o master-detail empilha lista e
formulário, sem rolagem horizontal da página.

## Segurança

Dados do processo entram no DOM por `textContent`/`value`. O servidor mantém a
checagem de `Host` em loopback e a exigência de JSON nas escritas. Nenhum dado
do processo é interpolado em `innerHTML`.
