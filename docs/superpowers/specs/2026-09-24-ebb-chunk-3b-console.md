# ebb chunk 3b — console de time-travel

> Decidido em 2026-09-24, sobre o desenho geral em
> [`2026-09-14-ebb-design.md`](2026-09-14-ebb-design.md) e o chunk 3a em
> [`2026-09-24-ebb-chunk-3a-replay-fork.md`](2026-09-24-ebb-chunk-3a-replay-fork.md).
> Substitui conversa, não código: quando o código divergir daqui, este
> documento é que está errado.

Segunda metade da Seção 1 do `handoff.md`. O 3a provou o replay e a
bifurcação no terminal; o 3b os leva ao navegador.

## O que o chunk termina

Rebobinar uma instância **no navegador** e andar passo a passo no diagrama,
vendo variáveis e o porquê de cada gateway, e bifurcar a partir de um passo.

Em concreto: `ebb console` imprime `http://127.0.0.1:4321`. Na lista, abrir
uma instância que passou pelo `Gateway_Valor`. O slider anda do passo 1 ao
último; em cada passo o diagrama pinta o que concluiu, o que está ativo e os
fluxos tomados até ali, e o painel mostra o comando, as variáveis e, no passo
do gateway, as opções com a condição e a tomada marcada. "Bifurcar daqui" no
passo 1 abre a instância nova, parada no passo 1. Voltar o slider despinta o
que o passo desfez.

Verificado de verdade num navegador (o CI não roda um), com `npm run verify`
verde.

## Decisões

| Decisão       | Escolha                            | Porquê                                                                                |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Transporte    | Embrião do `@ebb/api` com Hono     | O design já escolheu Hono; a seção 3 cresce as rotas em vez de reescrever um servidor |
| Escopo        | Leitura + "bifurcar daqui"         | Rebobinar, explicar e bifurcar — o diferencial inteiro no navegador                   |
| Front         | Vite + TypeScript sem framework    | Mesma stack do playground do `bpmn-flow`, já provada com o viewer                     |
| Granularidade | Passo = comando do journal (`seq`) | A mesma do `ebb show --at` e do `fork`; bifurcar no meio de um comando não existe     |
| Exposição     | Só `127.0.0.1`, sem auth           | Auth é da seção 3; até lá, o console é ferramenta local de quem roda o ebb            |

O que o projeto perde em aprendizado com Hono: o roteamento HTTP escrito à
mão. O que ganha: o `@ebb/api` da seção 3 começa agora e com testes, sem
servidor descartável no meio.

## `@ebb/api`

Pacote novo, `packages/api`. Dependências novas: `hono` e `@hono/node-server`
(as mesmas versões do `@bpmn-flow/server`: 4.13.x e 2.1.x). Nenhuma das duas
tem dependência própria nem build nativo — a conta do CLAUDE.md fecha.

```ts
function createApp(options: { store: Store; runtime: EbbRuntime; assets?: string }): Hono;
```

| Rota                            | Resposta                                                  | Erros                                                           |
| ------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/instances`            | `200` `InstanceRecord[]`, da mais nova para a mais antiga | —                                                               |
| `GET /api/instances/:id/replay` | `200` `ReplayView` (`{ instance, xml, steps }`)           | `404` instância; `500` com a mensagem, se o journal não replaya |
| `POST /api/instances/:id/fork`  | `201` `{ instance }` da bifurcação                        | `400` body inválido ou `seq` fora; `404` instância; `415`       |
| `GET /*` (com `assets`)         | arquivo do build; rota desconhecida cai no `index.html`   | `404` sem `assets`                                              |

- Erro sempre como `{ error: string }`. Nada de stack no corpo.
- O `id` na rota é o completo, que a própria lista entrega. Mover a resolução
  de prefixo para o runtime continua sendo da seção 3.
- `POST fork` aceita só `{ seq: <inteiro positivo> }`. Qualquer outro campo é
  ignorado; `command` fica fora do HTTP até existir formulário (seção 3).

### Segurança sem auth

O servidor é local, mas o navegador que o acessa não é confiável por
definição: qualquer site aberto nele pode disparar requisição para
`127.0.0.1`. Três travas, todas no `createApp`, todas testadas:

1. **Escuta só em loopback.** `ebb console` passa `hostname: '127.0.0.1'` ao
   `serve`. Não há flag para mudar isso neste chunk.
2. **`Host` precisa ser loopback** (`127.0.0.1`, `localhost` ou `[::1]`, com
   qualquer porta). Fecha DNS rebinding: um domínio de fora resolvendo para
   127.0.0.1 chega com o `Host` dele e leva `403`.
3. **Escrita exige `Content-Type: application/json`** (senão `415`). Um
   formulário ou `fetch` "simples" de outra origem não consegue mandar esse
   cabeçalho sem preflight, e o preflight não é respondido. Fecha CSRF.

## `ebb console`

`ebb console [--port <n>] [--store <arquivo>]`, porta padrão `4321`. Sobe o
app com `serve`, imprime a URL e fica rodando até `Ctrl+C`, quando fecha o
servidor e o store.

O build do console é achado por
`import.meta.resolve('@ebb/console/package.json')` → `dist/`. Sem `dist/`, o
comando sai com `1` dizendo para rodar `npm run build`. O CLI é a raiz de
composição: passa a depender de `@ebb/api` e `@ebb/console`.

`--port 0` pede porta livre ao sistema; a URL impressa traz a porta real. É o
que o teste usa.

## `apps/console`

Pacote `@ebb/console`, privado, Vite + TypeScript. Dependência de runtime:
`@bpmn-flow/viewer` por caminho (`file:../../../bpmn-flow/packages/viewer`),
como o core já é. `vite` entra só como dependência de desenvolvimento.

### Telas

- `#/` — lista de instâncias: id curto, processo, versão, estado, comandos,
  origem (`<id>@<seq>` quando é bifurcação). Clicar abre o depurador.
- `#/i/<id>?step=<n>` — depurador. Sem `step`, abre no último. O passo vive
  na URL: recarregar ou compartilhar o link volta ao mesmo lugar.

### Depurador

- **Diagrama** num chunk próprio (o `bpmn-visualization` é a maior parte do
  bundle), carregado ao abrir a primeira instância.
- **Navegação**: slider de 1 a N, botões ◀ ▶ e as setas ← → do teclado.
- **Pintura do passo n**, sempre do zero para que voltar funcione:
  `viewer.clear()` → `markFlowTaken` de cada fluxo dos passos 1..n →
  `applySnapshot(steps[n].snapshot)`. `applySnapshot` preserva os fluxos já
  marcados, por isso a ordem.
- **Painel**:
  - cabeçalho `passo n de N — <tipo> em <ISO>` e o payload do comando;
  - estado da instância naquele passo;
  - variáveis;
  - nós entrados no passo;
  - por gateway decidido: nome, cada opção com condição (ou "default") e a
    tomada destacada, e as variáveis daquele instante. Com espaço na tela, a
    heurística de "variáveis citadas" do CLI não é necessária e continua só
    lá;
  - tarefas pendentes;
  - botão **"bifurcar daqui"**, que faz `POST fork { seq: n }` e navega para
    `#/i/<nova>` (último passo dela, que é o `n`).

### Módulos

| Módulo            | Papel                                                                | Teste             |
| ----------------- | -------------------------------------------------------------------- | ----------------- |
| `timeline.ts`     | Puro: `(ReplayView, n)` → o que pintar e o que listar; parse de rota | Sim, em Node      |
| `api.ts`          | `fetch` das três rotas, erro como `Error` com a mensagem do servidor | Fora da cobertura |
| `diagram-view.ts` | Ponto de entrada do chunk do viewer                                  | Fora da cobertura |
| `main.ts`         | DOM, eventos, roteamento por hash                                    | Fora da cobertura |

Fora da cobertura por nome, como o `bpmn-flow` faz com o playground: o que
vale testar mora em `timeline.ts`.

## Build e testes

- `build` da raiz passa a buildar `@ebb/api` (tsup) e `@ebb/console`
  (`vite build`), nessa ordem, depois do runtime e antes do CLI.
- Vitest: `projects` ganha `apps/*`; cobertura inclui `apps/*/src/**/*.ts` e
  exclui a fiação de browser do console.
- CI: nada muda. O `npm ci` do `bpmn-flow` já roda o `prepare`, que builda o
  viewer.

Testes:

- **api** com `app.request()`, sem abrir porta: cada rota e cada erro da
  tabela; `Host` de fora → `403`; `POST` sem `Content-Type` JSON → `415`;
  `seq` inválido (`0`, `1.5`, `"1"`, ausente) → `400`; estático servido de um
  diretório temporário, com fallback para `index.html` e `404` sem `assets`.
- **console** (`timeline.ts`): fluxos acumulados até n; voltar de n para n-1
  tira os fluxos do passo n; `step` ausente, zero, maior que N ou não
  numérico cai no último passo; opções do gateway com a tomada marcada; rota
  `#/`, `#/i/<id>` e `#/i/<id>?step=2`.
- **cli**: processo real com `ebb console --port 0`, lê a URL impressa, faz
  `GET /api/instances` e encerra com `SIGINT`, conferindo que saiu com `0`.
- **Navegador**: roteiro do "termina quando" executado no Chrome, com
  captura, relatado no PR.

## Fora de escopo

- Auth, tenant e bind fora de loopback (seção 3).
- Bifurcar aplicando um comando com valores novos pela UI: exige formulário
  de variáveis, que é assunto da tarefa humana (seção 3).
- WebSocket / atualização ao vivo: a lista e o replay são lidos ao abrir.
- Animação dentro de um passo (nó a nó pela `history`): o `ExecutionReplay`
  do viewer faria isso, mas passo = comando é a unidade que o resto do ebb usa.
- Os menores deixados pelo 3a (M1, M3-M5) — o M1 (fork com comando que falha)
  só importa quando o HTTP aceitar `command`, e aqui não aceita.
