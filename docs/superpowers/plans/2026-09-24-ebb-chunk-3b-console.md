# ebb chunk 3b — console de time-travel: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ebb console` abre no navegador um depurador que anda pelos passos de uma instância no diagrama, mostra variáveis e o porquê de cada gateway, e bifurca a partir de um passo.

**Architecture:** Pacote novo `@ebb/api` (Hono) com três rotas sobre `EbbRuntime`/`Store`, travas de loopback/`Host`/`Content-Type`, e o build estático do console. App novo `apps/console` (Vite + TS sem framework) com a lógica em `timeline.ts`/`wire.ts` (puros, testados) e a fiação de DOM em `main.ts`. O CLI ganha `ebb console`, que compõe store + runtime + api + assets.

**Tech Stack:** TypeScript 5.9, Node >= 24, Hono 4.13, `@hono/node-server` 2.1, Vite 8.3, Vitest 4, `@bpmn-flow/viewer` por caminho.

**Spec:** `docs/superpowers/specs/2026-09-24-ebb-chunk-3b-console.md`

## Global Constraints

- Node >= 24. Dependências novas **só** `hono@^4.13.8` e `@hono/node-server@^2.1.1` (em `@ebb/api`) e `vite@^8.3.0` (dev, em `@ebb/console`). Mais nada.
- Nada de `as` sobre JSON: resposta HTTP e body passam por guarda (`wire.ts` no console, `seqFrom` na api) — mesmo espírito do `rows.ts`.
- Nada de `innerHTML` com dado: todo texto vindo de instância (ids, variáveis, payload, nomes) entra por `textContent`. Variável de processo é dado de usuário.
- Servidor escuta só em `127.0.0.1`; `Host` fora de loopback → `403`; escrita sem `Content-Type: application/json` → `415`. Erro sempre `{ error: string }`, sem stack.
- Docstring/comentário em PT-BR, identificador em inglês, comentário explica o porquê.
- Conventional Commits em inglês, um commit por tarefa (ou unidade lógica), todo commit termina com `Claude-Session: https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb`.
- `npm run verify` verde em cada commit (limiares 90/85/90/90).
- Antes de `npm`/`npx` no Bash: `unset -f node npm npx 2>/dev/null; export PATH=/usr/bin:$PATH`.

## Review Focus

1. **Variável com HTML** (`"<b>x</b>"`, `"<img src=x>"`): aparece literal no painel e na lista, nunca interpretada. Coberto pela regra de `textContent` e verificado no navegador na Tarefa 7 (com `<b>`, não com `onerror` — um `alert` travaria a automação do Chrome).
2. **Instância com um passo só**: slider com `min = max = 1`, ◀ ▶ desabilitados, bifurcar no passo 1 funciona. Teste de `timeline.ts` na Tarefa 4 e verificação no navegador na Tarefa 7.
3. **Trocar de instância antes de a anterior carregar** (clique rápido na lista, ou voltar/avançar do navegador): a tela nunca pinta o replay da instância velha por cima da nova. Guarda de carga em `main.ts` (Tarefa 5), verificada no navegador na Tarefa 7.
4. **Id desconhecido ou journal que não replaya na URL**: o console mostra a mensagem do servidor (`404`/`500`) com link de volta à lista, não uma tela em branco. Testes da api na Tarefa 1; tela verificada na Tarefa 7.
5. **Path traversal no estático** (`/%2e%2e/…`): nunca serve arquivo fora de `assets`. Teste na Tarefa 3.

---

## Mapa de arquivos

| Arquivo                                                                                           | Responsabilidade                                           |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `packages/api/package.json`, `tsconfig*.json`, `tsup.config.ts`, `vitest.config.ts`               | Pacote novo, no molde de `packages/runtime`                |
| `packages/api/src/app.ts`                                                                         | `createApp`: travas, rotas, erros, estático                |
| `packages/api/src/serve.ts`                                                                       | `serveApp`: sobe em loopback, devolve porta real e `close` |
| `packages/api/src/index.ts`                                                                       | API pública                                                |
| `packages/api/test/app.test.ts`, `serve.test.ts`                                                  | Rotas via `app.request()`; servidor real com porta 0       |
| `apps/console/package.json`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `tsconfig*.json` | App novo                                                   |
| `apps/console/src/wire.ts`                                                                        | Guardas das respostas HTTP                                 |
| `apps/console/src/timeline.ts`                                                                    | Rotas por hash, passo válido, o que pintar e listar        |
| `apps/console/src/api.ts`                                                                         | `fetch` das três rotas                                     |
| `apps/console/src/diagram-view.ts`                                                                | Chunk do viewer                                            |
| `apps/console/src/main.ts`, `style.css`                                                           | DOM, eventos, estilo                                       |
| `apps/console/test/*.test.ts`                                                                     | `wire` e `timeline`                                        |
| `packages/cli/src/console.ts`                                                                     | `consoleAssets`, `runConsole`                              |
| `packages/cli/src/bin.ts`                                                                         | `case 'console'`, USAGE                                    |
| `package.json` (raiz), `vitest.config.ts`, `eslint.config.js`                                     | build, projetos de teste, cobertura, lint                  |
| `README.md`, `handoff.md`, `CLAUDE.md`                                                            | vitrine e roteiro                                          |

---

### Task 1: `@ebb/api` — pacote, travas e rotas de leitura

**Files:**

- Create: `packages/api/package.json`, `packages/api/tsconfig.json`, `packages/api/tsconfig.lint.json`, `packages/api/tsup.config.ts`, `packages/api/vitest.config.ts`, `packages/api/src/app.ts`, `packages/api/src/index.ts`
- Modify: `package.json` (raiz, script `build`), `eslint.config.js` (nada: `./packages/*/tsconfig.lint.json` já cobre)
- Test: `packages/api/test/app.test.ts`

**Interfaces:**

- Consumes: `EbbRuntime.replay(id)` → `ReplayView`; `Store.listInstances()`; `InstanceNotFoundError`, `ReplayRangeError` de `@ebb/runtime`
- Produces:
  - `interface AppOptions { store: Store; runtime: EbbRuntime; assets?: string }`
  - `createApp(options: AppOptions): Hono`
  - `class BadRequestError extends Error`

- [ ] **Step 1: Esqueleto do pacote**

`packages/api/package.json`:

```json
{
  "name": "@ebb/api",
  "version": "0.0.0",
  "description": "ebb over HTTP: the routes the console and, later, workers and the SDK talk to.",
  "type": "module",
  "license": "Apache-2.0",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.lint.json"
  },
  "dependencies": {
    "@ebb/runtime": "^0.0.0",
    "@ebb/store": "^0.0.0",
    "@hono/node-server": "^2.1.1",
    "hono": "^4.13.8"
  }
}
```

`tsconfig.json`, `tsconfig.lint.json`, `tsup.config.ts`, `vitest.config.ts`: cópias exatas dos de `packages/runtime/` (o `tsconfig.lint.json` já com `"rootDir": "../.."`).

Raiz `package.json`, script `build`:

```json
"build": "npm run build -w @ebb/store && npm run build -w @ebb/runtime && npm run build -w @ebb/api && npm run build -w @ebb/cli",
```

Run: `npm install` (liga o workspace e baixa `hono`/`@hono/node-server`). Confira no `package-lock.json` que entraram só esses dois pacotes novos em `node_modules/` (`git diff --stat package-lock.json` e `rg '"node_modules/(hono|@hono/node-server)"' package-lock.json`).

- [ ] **Step 2: Testes que falham**

`packages/api/test/app.test.ts`:

```ts
import { EbbRuntime } from '@ebb/runtime';
import { checksumOf, SqliteStore } from '@ebb/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Aprovacao" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Avaliar" name="Avaliar pedido" />
    <bpmn:exclusiveGateway id="Gateway_Valor" name="Valor alto?" default="Flow_Baixo" />
    <bpmn:userTask id="Diretoria" name="Aprovar na diretoria" />
    <bpmn:endEvent id="EndAlto" />
    <bpmn:endEvent id="EndBaixo" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Avaliar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Avaliar" targetRef="Gateway_Valor" />
    <bpmn:sequenceFlow id="Flow_Alto" sourceRef="Gateway_Valor" targetRef="Diretoria">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">valor &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="Flow_Baixo" sourceRef="Gateway_Valor" targetRef="EndBaixo" />
    <bpmn:sequenceFlow id="f4" sourceRef="Diretoria" targetRef="EndAlto" />
  </bpmn:process>
</bpmn:definitions>`;

let store: SqliteStore;
let runtime: EbbRuntime;

beforeEach(async () => {
  store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'Aprovacao', xml: GATEWAY, checksum: checksumOf(GATEWAY) });
  let ids = 0;
  runtime = new EbbRuntime({ store, newId: () => `inst-${++ids}` });
});

afterEach(() => store.close());

/** inst-1 passou pelo gateway: dois comandos. */
async function throughGateway(): Promise<void> {
  const started = await runtime.start('Aprovacao');
  await runtime.apply('inst-1', {
    type: 'completeTask',
    tokenId: started.tasks[0]?.tokenId ?? '',
    output: { valor: 150 },
  });
}

describe('leitura', () => {
  it('lista as instâncias', async () => {
    await throughGateway();
    const res = await createApp({ store, runtime }).request('/api/instances');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ id: 'inst-1', processKey: 'Aprovacao', seq: 2 }]);
  });

  it('devolve o replay inteiro: instância, xml e passos com o porquê do gateway', async () => {
    await throughGateway();
    const res = await createApp({ store, runtime }).request('/api/instances/inst-1/replay');

    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      instance: { id: 'inst-1' },
      xml: GATEWAY,
      steps: [
        { seq: 1, command: { type: 'start' } },
        { seq: 2, decisions: [{ nodeId: 'Gateway_Valor', taken: ['Flow_Alto'] }] },
      ],
    });
  });

  it('404 com { error } para instância que não existe', async () => {
    const res = await createApp({ store, runtime }).request('/api/instances/nada/replay');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.stringContaining('nada') });
  });

  it('500 com a mensagem quando o journal não replaya', async () => {
    await store.createInstance({
      id: 'quebrada',
      processKey: 'Aprovacao',
      version: 1,
      status: 'waiting',
      command: { type: 'start', payload: {}, at: 1 },
      state: { engineVersion: 0, json: '{}' },
      jobs: [],
    });
    const res = await createApp({ store, runtime }).request('/api/instances/quebrada/replay');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.stringContaining('engine') });
  });

  it('404 com { error } para rota de api desconhecida', async () => {
    const res = await createApp({ store, runtime }).request('/api/nada');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

describe('Host', () => {
  it.each([
    'http://localhost/api/instances',
    'http://127.0.0.1:4321/api/instances',
    'http://[::1]:4321/api/instances',
  ])('aceita loopback (%s)', async (url) => {
    expect((await createApp({ store, runtime }).request(url)).status).toBe(200);
  });

  it.each(['http://evil.example/api/instances', 'http://127.0.0.1.evil.example/api/instances'])(
    'recusa com 403 o que não é loopback (%s)',
    async (url) => {
      const res = await createApp({ store, runtime }).request(url);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: expect.any(String) });
    },
  );
});
```

Run: `npx vitest run packages/api`
Expected: FAIL — `../src/app.js` não existe.

- [ ] **Step 3: Implementar `app.ts` (leitura)**

```ts
import { InstanceNotFoundError, ReplayRangeError, type EbbRuntime } from '@ebb/runtime';
import type { Store } from '@ebb/store';
import { Hono } from 'hono';

export interface AppOptions {
  store: Store;
  runtime: EbbRuntime;
  /** Diretório do build do console. Sem ele, só a api responde. */
  assets?: string;
}

/** O pedido não dá para atender como veio: vira 400 com esta mensagem. */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Os nomes com que um navegador chega a um servidor local. `hostname` de
 * `URL` já vem sem porta e, para IPv6, entre colchetes.
 */
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * O app HTTP do ebb.
 *
 * Sem auth neste chunk, então a proteção vem de onde ele roda: só atende
 * quem chega por loopback. A checagem de `Host` fecha DNS rebinding — um
 * domínio de fora que resolve para 127.0.0.1 chega com o nome dele.
 */
export function createApp(options: AppOptions): Hono {
  const { store, runtime } = options;
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!LOOPBACK.has(new URL(c.req.url).hostname)) {
      return c.json({ error: 'Este servidor só atende em loopback.' }, 403);
    }
    await next();
  });

  app.get('/api/instances', async (c) => c.json(await store.listInstances()));

  app.get('/api/instances/:id/replay', async (c) =>
    c.json(await runtime.replay(c.req.param('id'))),
  );

  app.all('/api/*', (c) => c.json({ error: 'Rota desconhecida.' }, 404));

  app.notFound((c) => c.json({ error: 'Não encontrado.' }, 404));

  app.onError((error, c) => {
    if (error instanceof BadRequestError || error instanceof ReplayRangeError) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof InstanceNotFoundError) return c.json({ error: error.message }, 404);
    // Mensagem sim, stack não: quem chama precisa saber o que houve, não
    // onde no nosso código.
    return c.json({ error: error.message }, 500);
  });

  return app;
}
```

`packages/api/src/index.ts`:

```ts
export { BadRequestError, createApp } from './app.js';
export type { AppOptions } from './app.js';
```

No teste do `500`: o `start` sem `engine` no payload faz o replay lançar `JournalShapeError` ("Entrada 1 do journal: \"engine\" …"), e o snapshot `engineVersion: 0` força o caminho do replay. Se a mensagem não contiver `engine`, ajuste o `stringContaining` para o trecho real da mensagem e registre.

- [ ] **Step 4: Rodar, gate e commit**

Run: `npx vitest run packages/api` → PASS. `npm run verify` → PASS.

```bash
git add package.json package-lock.json packages/api
git commit -m "feat(api): serve instances and their replay over loopback-only HTTP"
```

---

### Task 2: `@ebb/api` — bifurcar por HTTP

**Files:**

- Modify: `packages/api/src/app.ts`
- Test: `packages/api/test/app.test.ts`

**Interfaces:**

- Consumes: `EbbRuntime.fork(id, seq)` → `CommandResult`
- Produces: `POST /api/instances/:id/fork` → `201 { instance: InstanceRecord }`

- [ ] **Step 1: Testes que falham**

Acrescente a `app.test.ts`:

```ts
function fork(id: string, body: string, contentType = 'application/json') {
  return createApp({ store, runtime }).request(`/api/instances/${id}/fork`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
}

describe('bifurcar', () => {
  it('201 com a instância nova, parada no passo pedido', async () => {
    await throughGateway();
    const res = await fork('inst-1', JSON.stringify({ seq: 1 }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      instance: { id: 'inst-2', seq: 1, forkedFrom: 'inst-1', forkedAt: 1 },
    });
  });

  it('aceita charset no Content-Type', async () => {
    await throughGateway();
    const res = await fork('inst-1', JSON.stringify({ seq: 1 }), 'application/json; charset=utf-8');
    expect(res.status).toBe(201);
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
    '415 sem Content-Type JSON (%s) e nada é criado',
    async (contentType) => {
      await throughGateway();
      const res = await fork('inst-1', JSON.stringify({ seq: 1 }), contentType);

      expect(res.status).toBe(415);
      expect(await store.readInstance('inst-2')).toBeUndefined();
    },
  );

  it.each([
    ['seq zero', '{"seq":0}'],
    ['seq fracionário', '{"seq":1.5}'],
    ['seq como texto', '{"seq":"1"}'],
    ['sem seq', '{}'],
    ['JSON inválido', '{seq:'],
    ['não é objeto', '[1]'],
    ['corpo vazio', ''],
  ])('400 para %s', async (_, body) => {
    await throughGateway();
    const res = await fork('inst-1', body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('400 com o intervalo quando o passo não existe', async () => {
    await throughGateway();
    const res = await fork('inst-1', JSON.stringify({ seq: 9 }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: expect.stringContaining('[1, 2]') });
  });

  it('404 para instância que não existe', async () => {
    const res = await fork('nada', JSON.stringify({ seq: 1 }));
    expect(res.status).toBe(404);
  });

  it('GET na rota de bifurcar não bifurca', async () => {
    await throughGateway();
    const res = await createApp({ store, runtime }).request('/api/instances/inst-1/fork');

    expect(res.status).toBe(404);
    expect(await store.readInstance('inst-2')).toBeUndefined();
  });
});
```

Run: `npx vitest run packages/api` → FAIL (404 no POST).

- [ ] **Step 2: Implementar**

Em `app.ts`, antes do `app.all('/api/*', …)`:

```ts
app.post('/api/instances/:id/fork', async (c) => {
  // Um formulário ou fetch "simples" de outra origem não consegue mandar
  // este cabeçalho sem preflight, e preflight não é respondido aqui: é o
  // que fecha CSRF sem auth.
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return c.json({ error: 'Envie o corpo como application/json.' }, 415);
  }
  const seq = seqFrom(await c.req.text());
  const forked = await runtime.fork(c.req.param('id'), seq);
  return c.json({ instance: forked.instance }, 201);
});
```

E, fora de `createApp`:

```ts
/**
 * `{ seq }` do corpo, sem `as`: o corpo é texto de fora, e um `seq` que não é
 * inteiro positivo não pode chegar ao runtime como se fosse.
 */
function seqFrom(raw: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError('O corpo tem de ser JSON válido.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestError('O corpo tem de ser um objeto JSON.');
  }
  const seq: unknown = 'seq' in parsed ? parsed.seq : undefined;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    throw new BadRequestError('"seq" tem de ser um inteiro positivo.');
  }
  return seq;
}
```

- [ ] **Step 3: Rodar, gate e commit**

Run: `npx vitest run packages/api` → PASS. `npm run verify` → PASS.

```bash
git add packages/api
git commit -m "feat(api): fork an instance over HTTP behind a JSON-only guard"
```

---

### Task 3: `@ebb/api` — estático e servidor real

**Files:**

- Create: `packages/api/src/serve.ts`
- Modify: `packages/api/src/app.ts`, `packages/api/src/index.ts`
- Test: `packages/api/test/app.test.ts`, `packages/api/test/serve.test.ts`

**Interfaces:**

- Produces:
  - `interface RunningApp { port: number; url: string; close(): Promise<void> }`
  - `serveApp(app: Hono, options: { port: number }): Promise<RunningApp>` (sempre em `127.0.0.1`)

- [ ] **Step 1: Testes que falham — estático**

Em `app.test.ts` (acrescente `mkdtemp`, `rm`, `writeFile`, `mkdir` de `node:fs/promises`, `tmpdir` de `node:os`, `join` de `node:path`):

```ts
describe('estático', () => {
  let assets: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ebb-assets-'));
    assets = join(root, 'dist');
    await mkdir(join(assets, 'assets'), { recursive: true });
    await writeFile(join(assets, 'index.html'), '<!doctype html><title>console</title>');
    await writeFile(join(assets, 'assets', 'app.js'), 'console.log(1)');
    // Fora de `assets`, ao lado: o que traversal tentaria ler.
    await writeFile(join(root, 'segredo.txt'), 'não deveria sair');
  });

  afterEach(async () => {
    await rm(join(assets, '..'), { recursive: true, force: true });
  });

  it('serve o index na raiz e os arquivos do build', async () => {
    const app = createApp({ store, runtime, assets });

    const index = await app.request('/');
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>console</title>');

    const script = await app.request('/assets/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');
  });

  it('rota desconhecida fora da api cai no index', async () => {
    const res = await createApp({ store, runtime, assets }).request('/i/qualquer');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>console</title>');
  });

  it.each(['/%2e%2e/segredo.txt', '/..%2fsegredo.txt', '/assets/%2e%2e/%2e%2e/segredo.txt'])(
    'nunca serve arquivo fora de assets (%s)',
    async (path) => {
      const res = await createApp({ store, runtime, assets }).request(path);
      expect(await res.text()).not.toContain('não deveria sair');
    },
  );

  it('a api continua respondendo JSON com assets ligado', async () => {
    const res = await createApp({ store, runtime, assets }).request('/api/nada');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('sem assets, a raiz é 404', async () => {
    expect((await createApp({ store, runtime }).request('/')).status).toBe(404);
  });
});
```

Run → FAIL (a raiz é 404 com `assets`).

- [ ] **Step 2: Implementar o estático**

Em `app.ts` (`import { serveStatic } from '@hono/node-server/serve-static';`), depois do `app.all('/api/*', …)`:

```ts
if (options.assets) {
  // `serveStatic` recusa caminho com `..` (getFilePath do Hono), e o
  // fallback abaixo sempre entrega o mesmo arquivo: nada fora de `assets`
  // sai por aqui.
  app.use('*', serveStatic({ root: options.assets }));
  // O console roteia por hash, mas um link colado com caminho não pode dar
  // tela em branco: qualquer outra rota recebe o index.
  app.get('*', serveStatic({ root: options.assets, path: 'index.html' }));
}
```

Run → PASS. Se o `content-type` do `.js` vier diferente de `…javascript…`, registre o valor real e ajuste só o teste se for um MIME válido de JavaScript.

- [ ] **Step 3: Teste que falha — servidor real**

`packages/api/test/serve.test.ts`:

```ts
import { EbbRuntime } from '@ebb/runtime';
import { SqliteStore } from '@ebb/store';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { serveApp } from '../src/serve.js';

it('sobe em loopback numa porta livre, responde e fecha', async () => {
  const store = new SqliteStore({ path: ':memory:' });
  const app = createApp({ store, runtime: new EbbRuntime({ store }) });

  const running = await serveApp(app, { port: 0 });
  try {
    expect(running.port).toBeGreaterThan(0);
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
    const res = await fetch(`${running.url}/api/instances`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  } finally {
    await running.close();
    store.close();
  }
  await expect(fetch(`${running.url}/api/instances`)).rejects.toThrow();
});
```

Run → FAIL (`serve.js` não existe).

- [ ] **Step 4: Implementar `serve.ts`**

```ts
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

export interface RunningApp {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Sobe o app em 127.0.0.1 e só resolve quando está ouvindo, com a porta
 * real — `port: 0` pede uma livre ao sistema, que é o que teste e usuário
 * com a 4321 ocupada precisam. Sem opção de host: expor fora de loopback
 * espera auth (seção 3).
 */
export function serveApp(app: Hono, options: { port: number }): Promise<RunningApp> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: options.port, hostname: '127.0.0.1' },
      (info: AddressInfo) => {
        const url = `http://127.0.0.1:${info.port}`;
        resolve({
          port: info.port,
          url,
          close: () =>
            new Promise<void>((done, fail) => {
              server.close((error) => (error ? fail(error) : done()));
            }),
        });
      },
    );
    server.once('error', reject);
  });
}
```

Confira a assinatura do callback de `serve` em `node_modules/@hono/node-server/dist/index.d.mts` (ou `.d.ts`); se o tipo do `info` for outro nome, use-o. `index.ts` ganha:

```ts
export { serveApp } from './serve.js';
export type { RunningApp } from './serve.js';
```

- [ ] **Step 5: Rodar, gate e commit**

Run: `npx vitest run packages/api` → PASS. `npm run verify` → PASS.

```bash
git add packages/api
git commit -m "feat(api): serve the console build and listen on loopback"
```

---

### Task 4: `apps/console` — esqueleto, guardas e linha do tempo

**Files:**

- Create: `apps/console/package.json`, `apps/console/tsconfig.json`, `apps/console/tsconfig.lint.json`, `apps/console/vite.config.ts`, `apps/console/vitest.config.ts`, `apps/console/index.html` (mínimo, completado na Tarefa 5), `apps/console/src/wire.ts`, `apps/console/src/timeline.ts`
- Modify: `vitest.config.ts` (raiz), `eslint.config.js`, `package.json` (raiz, `build`)
- Test: `apps/console/test/wire.test.ts`, `apps/console/test/timeline.test.ts`

**Interfaces:**

- Consumes (tipos): `ReplayView`, `ReplayStep`, `GatewayTrace` de `@ebb/runtime`; `InstanceRecord` de `@ebb/store`
- Produces:
  - `wire.ts`: `isInstanceList(v: unknown): v is InstanceRecord[]`, `isReplayView(v: unknown): v is ReplayView`, `isForkResponse(v: unknown): v is { instance: InstanceRecord }`, `errorMessage(v: unknown): string | undefined`
  - `timeline.ts`:
    - `type Route = { view: 'list' } | { view: 'instance'; id: string; step?: number }`
    - `parseRoute(hash: string): Route`, `routeTo(route: Route): string`
    - `clampStep(step: number | undefined, total: number): number`
    - `interface ListRow { id: string; short: string; process: string; version: string; status: string; commands: string; origin: string }`, `listRows(instances: InstanceRecord[]): ListRow[]`
    - `interface Frame { step; total; title; payload; status; snapshot; flows: string[]; variables: [string, string][]; entered: string[]; gateways: GatewayView[]; tasks: TaskView[] }`, `frameAt(view: ReplayView, step: number): Frame`

- [ ] **Step 1: Esqueleto**

`apps/console/package.json`:

```json
{
  "name": "@ebb/console",
  "version": "0.0.0",
  "private": true,
  "description": "The ebb console: rewind an instance step by step on its diagram, and fork it.",
  "type": "module",
  "license": "Apache-2.0",
  "exports": {
    "./package.json": "./package.json"
  },
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.lint.json"
  },
  "dependencies": {
    "@bpmn-flow/viewer": "file:../../../bpmn-flow/packages/viewer"
  },
  "devDependencies": {
    "@ebb/runtime": "^0.0.0",
    "@ebb/store": "^0.0.0",
    "vite": "^8.3.0"
  }
}
```

(`exports` só com `./package.json`: é por ele que o CLI acha o `dist/` via `import.meta.resolve`. `@ebb/runtime`/`@ebb/store` são dev: o console só importa tipos deles, e os testes constroem um replay de verdade.)

`apps/console/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false
  },
  "include": ["src"]
}
```

`apps/console/tsconfig.lint.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["vite/client", "node"],
    "rootDir": "../.."
  },
  "include": ["src", "test", "*.ts"]
}
```

(`node` só no programa de lint/teste, que roda em Node; o `src` compila sem ele — `process` no código de navegador vira erro de tipo.)

`apps/console/vite.config.ts`:

```ts
import { defineConfig } from 'vite';

/**
 * Em `npm run dev -w @ebb/console`, a api é o `ebb console` rodando ao lado
 * (porta padrão): o proxy mantém o `Host` de loopback, que a api exige.
 */
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:4321' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`apps/console/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

// Só a lógica pura roda aqui (timeline, wire), em Node: o DOM é verificado no
// navegador, não simulado.
export default defineConfig({ test: { environment: 'node' } });
```

`apps/console/index.html` (mínimo por ora):

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ebb console</title>
  </head>
  <body>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

E `apps/console/src/main.ts` provisório com uma linha: `export {};` (substituído na Tarefa 5).

Raiz:

- `vitest.config.ts`: `projects: ['packages/*', 'apps/*']`; `coverage.include` ganha `'apps/*/src/**/*.ts'`; `coverage.exclude` ganha, com comentário "fiação de navegador: DOM, fetch e o viewer; a lógica mora em timeline.ts e wire.ts", `'apps/console/src/main.ts'`, `'apps/console/src/api.ts'`, `'apps/console/src/diagram-view.ts'`.
- `eslint.config.js`: `project` passa a `['./tsconfig.lint.json', './packages/*/tsconfig.lint.json', './apps/*/tsconfig.lint.json']`.
- `package.json` `build`: `… && npm run build -w @ebb/api && npm run build -w @ebb/console && npm run build -w @ebb/cli`.

Run: `npm install`. Confira que `vite` resolveu para 8.3.x (`npm ls vite -w @ebb/console`).

- [ ] **Step 2: Testes que falham — `wire.ts`**

`apps/console/test/wire.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { errorMessage, isForkResponse, isInstanceList, isReplayView } from '../src/wire.js';

const INSTANCE = {
  id: 'inst-1',
  processKey: 'P',
  version: 1,
  status: 'waiting',
  seq: 2,
  createdAt: 'x',
  updatedAt: 'x',
};

describe('guardas das respostas', () => {
  it('lista de instâncias', () => {
    expect(isInstanceList([INSTANCE])).toBe(true);
    expect(isInstanceList([])).toBe(true);
    expect(isInstanceList([{ ...INSTANCE, seq: '2' }])).toBe(false);
    expect(isInstanceList({ instances: [] })).toBe(false);
  });

  it('replay', () => {
    const step = {
      seq: 1,
      at: 1,
      command: { type: 'start' },
      snapshot: {},
      flows: [],
      decisions: [],
      entered: [],
      tasks: [],
      incidents: [],
    };
    expect(isReplayView({ instance: INSTANCE, xml: '<x/>', steps: [step] })).toBe(true);
    expect(
      isReplayView({ instance: INSTANCE, xml: '<x/>', steps: [{ ...step, flows: 'f1' }] }),
    ).toBe(false);
    expect(isReplayView({ instance: INSTANCE, steps: [] })).toBe(false);
    expect(isReplayView(null)).toBe(false);
  });

  it('bifurcação', () => {
    expect(isForkResponse({ instance: INSTANCE })).toBe(true);
    expect(isForkResponse(INSTANCE)).toBe(false);
  });

  it('mensagem de erro', () => {
    expect(errorMessage({ error: 'nope' })).toBe('nope');
    expect(errorMessage({ error: 1 })).toBeUndefined();
    expect(errorMessage(undefined)).toBeUndefined();
  });
});
```

Run: `npx vitest run apps/console` → FAIL.

- [ ] **Step 3: Implementar `wire.ts`**

```ts
import type { ReplayView } from '@ebb/runtime';
import type { InstanceRecord } from '@ebb/store';

/*
 * Guardas estruturais das respostas da api. Mínimas de propósito — conferem o
 * que o console lê para decidir o que desenhar —, mas é por elas, e não por
 * `as`, que o JSON do `fetch` vira tipo.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInstance(value: unknown): value is InstanceRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.processKey === 'string' &&
    typeof value.version === 'number' &&
    typeof value.status === 'string' &&
    typeof value.seq === 'number'
  );
}

export function isInstanceList(value: unknown): value is InstanceRecord[] {
  return Array.isArray(value) && value.every(isInstance);
}

function isStep(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.seq === 'number' &&
    typeof value.at === 'number' &&
    isRecord(value.command) &&
    typeof value.command.type === 'string' &&
    isRecord(value.snapshot) &&
    Array.isArray(value.flows) &&
    Array.isArray(value.decisions) &&
    Array.isArray(value.entered) &&
    Array.isArray(value.tasks)
  );
}

export function isReplayView(value: unknown): value is ReplayView {
  return (
    isRecord(value) &&
    isInstance(value.instance) &&
    typeof value.xml === 'string' &&
    Array.isArray(value.steps) &&
    value.steps.every(isStep)
  );
}

export function isForkResponse(value: unknown): value is { instance: InstanceRecord } {
  return isRecord(value) && isInstance(value.instance);
}

/** O `{ error }` que a api devolve em toda falha. */
export function errorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.error === 'string' ? value.error : undefined;
}
```

Run → PASS.

- [ ] **Step 4: Testes que falham — `timeline.ts`**

`apps/console/test/timeline.test.ts` constrói um replay **real** (mesmo diagrama do gateway):

```ts
import { EbbRuntime } from '@ebb/runtime';
import type { ReplayView } from '@ebb/runtime';
import { checksumOf, SqliteStore } from '@ebb/store';
import type { InstanceRecord } from '@ebb/store';
import { beforeAll, describe, expect, it } from 'vitest';
import { clampStep, frameAt, listRows, parseRoute, routeTo } from '../src/timeline.js';

const GATEWAY = `…mesmo XML do GATEWAY de packages/api/test/app.test.ts…`;

let view: ReplayView;
let single: ReplayView;

beforeAll(async () => {
  const store = new SqliteStore({ path: ':memory:' });
  await store.deploy({ processKey: 'Aprovacao', xml: GATEWAY, checksum: checksumOf(GATEWAY) });
  let ids = 0;
  const runtime = new EbbRuntime({
    store,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    newId: () => `inst-${++ids}`,
  });
  const started = await runtime.start('Aprovacao', { variables: { nota: '<b>x</b>' } });
  const high = await runtime.apply('inst-1', {
    type: 'completeTask',
    tokenId: started.tasks[0]?.tokenId ?? '',
    output: { valor: 150 },
  });
  await runtime.apply('inst-1', { type: 'completeTask', tokenId: high.tasks[0]?.tokenId ?? '' });
  view = await runtime.replay('inst-1');
  await runtime.start('Aprovacao');
  single = await runtime.replay('inst-2');
  store.close();
});

describe('rotas', () => {
  it.each([
    ['', { view: 'list' }],
    ['#/', { view: 'list' }],
    ['#/qualquer', { view: 'list' }],
    ['#/i/inst-1', { view: 'instance', id: 'inst-1' }],
    ['#/i/inst-1?step=2', { view: 'instance', id: 'inst-1', step: 2 }],
    ['#/i/inst-1?step=abc', { view: 'instance', id: 'inst-1' }],
    ['#/i/a%20b', { view: 'instance', id: 'a b' }],
    ['#/i/%E0%A4%A', { view: 'list' }],
  ])('%s', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
  });

  it('ida e volta', () => {
    expect(routeTo({ view: 'list' })).toBe('#/');
    expect(routeTo({ view: 'instance', id: 'a b', step: 3 })).toBe('#/i/a%20b?step=3');
    expect(parseRoute(routeTo({ view: 'instance', id: 'x/y', step: 1 }))).toEqual({
      view: 'instance',
      id: 'x/y',
      step: 1,
    });
  });
});

describe('passo válido', () => {
  it.each([
    [undefined, 3, 3],
    [2, 3, 2],
    [0, 3, 3],
    [4, 3, 3],
    [1.5, 3, 3],
    [-1, 3, 3],
    [1, 1, 1],
  ])('clampStep(%s, %s) = %s', (step, total, expected) => {
    expect(clampStep(step, total)).toBe(expected);
  });
});

describe('frameAt', () => {
  it('passo do gateway: título, opções com a tomada marcada e as variáveis do instante', () => {
    const frame = frameAt(view, 2);

    expect(frame.title).toBe('passo 2 de 3 — completeTask em 2026-09-24T12:00:00.000Z');
    expect(frame.total).toBe(3);
    expect(frame.entered).toContain('Diretoria');
    expect(frame.gateways).toEqual([
      {
        nodeId: 'Gateway_Valor',
        name: 'Valor alto?',
        options: expect.arrayContaining([
          { flowId: 'Flow_Alto', targetId: 'Diretoria', label: 'valor > 100', taken: true },
          { flowId: 'Flow_Baixo', targetId: 'EndBaixo', label: 'default', taken: false },
        ]),
        variables: expect.arrayContaining([['valor', '150']]),
      },
    ]);
    expect(frame.tasks.map((task) => task.nodeId)).toEqual(['Diretoria']);
  });

  it('acumula os fluxos até o passo, e voltar tira os do passo desfeito', () => {
    const at2 = frameAt(view, 2).flows;
    const at1 = frameAt(view, 1).flows;

    expect(at2).toContain('Flow_Alto');
    expect(at1).not.toContain('Flow_Alto');
    expect(at2).toEqual(expect.arrayContaining(at1));
    expect(new Set(frameAt(view, 3).flows).size).toBe(frameAt(view, 3).flows.length);
  });

  it('variável com HTML chega como texto, sem ser tocada', () => {
    expect(frameAt(view, 1).variables).toContainEqual(['nota', '"<b>x</b>"']);
  });

  it('instância de um passo só', () => {
    const frame = frameAt(single, 1);
    expect(frame.total).toBe(1);
    expect(frame.gateways).toEqual([]);
  });

  it('recusa passo fora do replay', () => {
    expect(() => frameAt(view, 4)).toThrow(RangeError);
  });
});

describe('listRows', () => {
  it('id curto e origem da bifurcação', () => {
    const base: InstanceRecord = {
      id: '64135c65-5b53-4531-9e8c-e97ce0600c3e',
      processKey: 'Aprovacao',
      version: 1,
      status: 'completed',
      seq: 2,
      createdAt: 'x',
      updatedAt: 'x',
    };
    expect(
      listRows([
        { ...base, forkedFrom: '10dbdecb-430a-4fcb-a0a4-e5a63cf81e0a', forkedAt: 1 },
        base,
      ]),
    ).toEqual([
      {
        id: base.id,
        short: '64135c65',
        process: 'Aprovacao',
        version: 'v1',
        status: 'completed',
        commands: '2',
        origin: '10dbdecb@1',
      },
      {
        id: base.id,
        short: '64135c65',
        process: 'Aprovacao',
        version: 'v1',
        status: 'completed',
        commands: '2',
        origin: '',
      },
    ]);
  });
});
```

(Copie o XML literal do `GATEWAY` — sem "…".)

Run → FAIL (`timeline.js` não existe).

- [ ] **Step 5: Implementar `timeline.ts`**

```ts
import type { ReplayView } from '@ebb/runtime';
import type { ExecutionSnapshot } from '@bpmn-flow/core';
import type { InstanceRecord } from '@ebb/store';

/** Quanto de um id aparece na lista — o mesmo corte do CLI. */
const SHORT = 8;

export type Route = { view: 'list' } | { view: 'instance'; id: string; step?: number };

/** A rota que o hash descreve. Qualquer coisa que não seja `#/i/<id>` é a lista. */
export function parseRoute(hash: string): Route {
  const match = /^#\/i\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (!match?.[1]) return { view: 'list' };
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    // Escape malformado colado na barra: melhor a lista que uma exceção.
    return { view: 'list' };
  }
  const raw = new URLSearchParams(match[2] ?? '').get('step');
  const step = raw === null ? Number.NaN : Number(raw);
  return Number.isNaN(step) ? { view: 'instance', id } : { view: 'instance', id, step };
}

export function routeTo(route: Route): string {
  if (route.view === 'list') return '#/';
  const step = route.step === undefined ? '' : `?step=${route.step}`;
  return `#/i/${encodeURIComponent(route.id)}${step}`;
}

/**
 * O passo a mostrar. Qualquer coisa fora de `[1, total]` vira o último: a URL
 * é do próprio console, e cair num estado válido serve mais que uma tela de erro.
 */
export function clampStep(step: number | undefined, total: number): number {
  return step !== undefined && Number.isInteger(step) && step >= 1 && step <= total ? step : total;
}

export interface ListRow {
  id: string;
  short: string;
  process: string;
  version: string;
  status: string;
  commands: string;
  origin: string;
}

export function listRows(instances: InstanceRecord[]): ListRow[] {
  return instances.map((instance) => ({
    id: instance.id,
    short: instance.id.slice(0, SHORT),
    process: instance.processKey,
    version: `v${instance.version}`,
    status: instance.status,
    commands: `${instance.seq}`,
    origin:
      instance.forkedFrom === undefined
        ? ''
        : `${instance.forkedFrom.slice(0, SHORT)}@${instance.forkedAt ?? '?'}`,
  }));
}

export interface GatewayView {
  nodeId: string;
  name: string;
  options: { flowId: string; targetId: string; label: string; taken: boolean }[];
  variables: [string, string][];
}

export interface TaskView {
  tokenId: string;
  nodeId: string;
  name: string;
  reason: string;
}

export interface Frame {
  step: number;
  total: number;
  title: string;
  /** O payload do comando, sem o tipo, indentado. */
  payload: string;
  status: string;
  snapshot: ExecutionSnapshot;
  /** Fluxos tomados do passo 1 até este, sem repetição, na ordem em que aconteceram. */
  flows: string[];
  variables: [string, string][];
  entered: string[];
  gateways: GatewayView[];
  tasks: TaskView[];
}

function rows(variables: Record<string, unknown>): [string, string][] {
  return Object.entries(variables).map(([key, value]) => [
    key,
    JSON.stringify(value) ?? 'undefined',
  ]);
}

/**
 * Tudo que a tela precisa para o passo `step`. Os fluxos são recalculados de
 * 1 até `step` a cada chamada, porque a pintura é sempre do zero — é o que
 * faz voltar um passo desfazer o que ele pintou.
 */
export function frameAt(view: ReplayView, step: number): Frame {
  const current = view.steps[step - 1];
  if (!current) throw new RangeError(`Passo ${step} fora do replay [1, ${view.steps.length}].`);
  const { type, ...payload } = current.command;
  return {
    step,
    total: view.steps.length,
    title: `passo ${step} de ${view.steps.length} — ${type} em ${new Date(current.at).toISOString()}`,
    payload: JSON.stringify(payload, null, 2),
    status: current.snapshot.status,
    snapshot: current.snapshot,
    flows: [...new Set(view.steps.slice(0, step).flatMap((each) => each.flows))],
    variables: rows(current.snapshot.variables),
    entered: current.entered
      .filter((entry) => entry.event === 'enter')
      .map((entry) => entry.nodeId),
    gateways: current.decisions.map((decision) => ({
      nodeId: decision.nodeId,
      name: decision.name ?? decision.nodeId,
      options: decision.options.map((option) => ({
        flowId: option.flowId,
        targetId: option.targetId,
        label: option.condition ?? (option.isDefault ? 'default' : '—'),
        taken: decision.taken.includes(option.flowId),
      })),
      variables: rows(decision.variables),
    })),
    tasks: current.tasks.map((task) => ({
      tokenId: task.tokenId,
      nodeId: task.nodeId,
      name: task.name ?? '',
      reason: task.reason,
    })),
  };
}
```

`@bpmn-flow/core` só como tipo: se o typecheck do console não resolver o módulo, acrescente `"@bpmn-flow/core": "file:../../../bpmn-flow/packages/core"` às `devDependencies` e registre.

- [ ] **Step 6: Rodar, gate e commit**

Run: `npx vitest run apps/console` → PASS. `npm run verify` → PASS (o `build` agora roda `vite build` com o `main.ts` provisório).

```bash
git add package.json package-lock.json vitest.config.ts eslint.config.js apps/console
git commit -m "feat(console): scaffold the console with its wire guards and timeline"
```

---

### Task 5: `apps/console` — a tela

Sem teste automatizado de DOM (decisão da spec): o que vale testar já está em `timeline.ts`/`wire.ts`. O critério desta tarefa é `vite build` passando e o `verify` verde; a tela é exercitada no navegador na Tarefa 7.

**Files:**

- Create: `apps/console/src/api.ts`, `apps/console/src/diagram-view.ts`, `apps/console/src/style.css`
- Modify: `apps/console/index.html`, `apps/console/src/main.ts`

**Interfaces:**

- Consumes: `wire.ts`, `timeline.ts` (Tarefa 4); rotas da api (Tarefas 1-2); `BpmnFlowViewer` (`load`, `clear`, `markFlowTaken`, `applySnapshot`, `fit`)
- Produces: `fetchInstances(): Promise<InstanceRecord[]>`, `fetchReplay(id): Promise<ReplayView>`, `forkAt(id, seq): Promise<InstanceRecord>`

- [ ] **Step 1: `api.ts`**

```ts
import type { ReplayView } from '@ebb/runtime';
import type { InstanceRecord } from '@ebb/store';
import { errorMessage, isForkResponse, isInstanceList, isReplayView } from './wire.js';

/** Corpo JSON da resposta, ou erro com a mensagem que a api mandou. */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(errorMessage(body) ?? `HTTP ${response.status}`);
  return body;
}

function unexpected(path: string): Error {
  return new Error(`Resposta inesperada de ${path}.`);
}

export async function fetchInstances(): Promise<InstanceRecord[]> {
  const path = '/api/instances';
  const body = await request(path);
  if (!isInstanceList(body)) throw unexpected(path);
  return body;
}

export async function fetchReplay(id: string): Promise<ReplayView> {
  const path = `/api/instances/${encodeURIComponent(id)}/replay`;
  const body = await request(path);
  if (!isReplayView(body)) throw unexpected(path);
  return body;
}

export async function forkAt(id: string, seq: number): Promise<InstanceRecord> {
  const path = `/api/instances/${encodeURIComponent(id)}/fork`;
  const body = await request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seq }),
  });
  if (!isForkResponse(body)) throw unexpected(path);
  return body.instance;
}
```

- [ ] **Step 2: `diagram-view.ts`**

```ts
/**
 * Ponto de entrada do pedaço pesado do bundle: `bpmn-visualization` (e o
 * `mxgraph` por baixo) é quase todo o console. Importado dinamicamente, vira
 * um chunk baixado só quando a primeira instância abre.
 */
import '@bpmn-flow/viewer/styles.css';

export { BpmnFlowViewer } from '@bpmn-flow/viewer';
```

- [ ] **Step 3: `index.html`**

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ebb console</title>
  </head>
  <body>
    <header class="top">
      <a href="#/" class="brand">ebb</a>
      <span id="crumb"></span>
    </header>

    <p id="error" class="error" hidden></p>

    <main id="list-view" hidden>
      <table class="instances">
        <thead>
          <tr>
            <th>ID</th>
            <th>Processo</th>
            <th>Versão</th>
            <th>Estado</th>
            <th>Comandos</th>
            <th>Origem</th>
          </tr>
        </thead>
        <tbody id="instances"></tbody>
      </table>
      <p id="empty" hidden>Nenhuma instância. Comece com: <code>ebb start &lt;chave&gt;</code></p>
    </main>

    <main id="debugger-view" class="debugger" hidden>
      <div id="diagram" class="diagram"></div>
      <aside class="panel">
        <div class="controls">
          <button id="prev" type="button" aria-label="Passo anterior">◀</button>
          <input id="step" type="range" min="1" max="1" value="1" aria-label="Passo" />
          <button id="next" type="button" aria-label="Próximo passo">▶</button>
        </div>
        <h2 id="step-title"></h2>
        <p id="status" class="status"></p>
        <pre id="payload" class="payload"></pre>
        <section id="gateways"></section>
        <section id="entered"></section>
        <section id="variables"></section>
        <section id="tasks"></section>
        <button id="fork" type="button" class="fork">Bifurcar daqui</button>
      </aside>
    </main>

    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 4: `style.css`**

```css
:root {
  font-family: system-ui, sans-serif;
  color: #1f2328;
  background: #f6f8fa;
}
body {
  margin: 0;
}
.top {
  display: flex;
  gap: 1rem;
  align-items: baseline;
  padding: 0.75rem 1rem;
  background: #fff;
  border-bottom: 1px solid #d0d7de;
}
.brand {
  font-weight: 700;
  color: inherit;
  text-decoration: none;
}
.error {
  margin: 1rem;
  padding: 0.75rem 1rem;
  background: #ffebe9;
  border: 1px solid #ff8182;
}
.instances {
  margin: 1rem;
  border-collapse: collapse;
  background: #fff;
}
.instances th,
.instances td {
  padding: 0.4rem 0.8rem;
  border-bottom: 1px solid #d0d7de;
  text-align: left;
}
.instances tbody tr {
  cursor: pointer;
}
.instances tbody tr:hover {
  background: #f3f4f6;
}
.debugger {
  display: grid;
  grid-template-columns: 1fr 24rem;
  height: calc(100vh - 3rem);
}
.diagram {
  background: #fff;
  min-height: 0;
}
.panel {
  overflow: auto;
  padding: 1rem;
  border-left: 1px solid #d0d7de;
  background: #fff;
}
.controls {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.controls input {
  flex: 1;
}
.panel h2 {
  font-size: 1rem;
}
.panel h3 {
  font-size: 0.85rem;
  margin: 1rem 0 0.25rem;
  text-transform: uppercase;
  color: #57606a;
}
.payload {
  background: #f6f8fa;
  padding: 0.5rem;
  overflow: auto;
}
.option.taken {
  font-weight: 700;
  color: #1a7f37;
}
.kv {
  width: 100%;
  border-collapse: collapse;
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
}
.kv td {
  padding: 0.15rem 0.3rem;
  border-bottom: 1px solid #eaeef2;
  word-break: break-all;
}
.fork {
  margin-top: 1rem;
}
```

- [ ] **Step 5: `main.ts`**

```ts
import type { BpmnFlowViewer } from '@bpmn-flow/viewer';
import type { ReplayView } from '@ebb/runtime';
import { fetchInstances, fetchReplay, forkAt } from './api.js';
import { clampStep, frameAt, listRows, parseRoute, routeTo, type Frame } from './timeline.js';
import './style.css';

/*
 * Fiação de navegador. A lógica (rotas, passo válido, o que pintar) está em
 * timeline.ts; aqui só DOM e eventos. Todo texto de instância entra por
 * `textContent`: variável de processo é dado de usuário, nunca HTML.
 */

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Elemento #${id} ausente do index.html.`);
  return element;
}

function inputById(id: string): HTMLInputElement {
  const element = byId(id);
  if (!(element instanceof HTMLInputElement)) throw new Error(`#${id} deveria ser um <input>.`);
  return element;
}

function buttonById(id: string): HTMLButtonElement {
  const element = byId(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`#${id} deveria ser um <button>.`);
  return element;
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const listView = byId('list-view');
const debuggerView = byId('debugger-view');
const errorBox = byId('error');
const crumb = byId('crumb');
const slider = inputById('step');
const prev = buttonById('prev');
const next = buttonById('next');
const forkButton = buttonById('fork');

let viewer: BpmnFlowViewer | undefined;
/** O replay aberto, reaproveitado enquanto só o passo muda. */
let current: ReplayView | undefined;
/** O passo pintado agora. */
let shown = 0;
/**
 * Contador de navegação: cada `render` pega um número, e uma carga que
 * termina depois de outra navegação começar é descartada — senão um clique
 * rápido pintaria o replay velho por cima do novo.
 */
let navigation = 0;

async function ensureViewer(): Promise<BpmnFlowViewer> {
  if (viewer) return viewer;
  const { BpmnFlowViewer } = await import('./diagram-view.js');
  viewer = new BpmnFlowViewer({ container: byId('diagram') });
  return viewer;
}

function showError(error: unknown): void {
  errorBox.replaceChildren(
    el('span', error instanceof Error ? error.message : String(error)),
    document.createTextNode(' '),
  );
  const back = el('a', 'voltar à lista');
  back.setAttribute('href', '#/');
  errorBox.append(back);
  errorBox.hidden = false;
}

function kvTable(rows: [string, string][]): HTMLElement {
  const table = el('table', undefined, 'kv');
  for (const [key, value] of rows) {
    const tr = el('tr');
    tr.append(el('td', key), el('td', value));
    table.append(tr);
  }
  return table;
}

function section(id: string, title: string, content: HTMLElement[]): void {
  const target = byId(id);
  target.replaceChildren();
  if (content.length === 0) return;
  target.append(el('h3', title), ...content);
}

async function showList(): Promise<void> {
  const instances = await fetchInstances();
  const tbody = byId('instances');
  tbody.replaceChildren();
  for (const row of listRows(instances)) {
    const tr = el('tr');
    tr.append(
      el('td', row.short),
      el('td', row.process),
      el('td', row.version),
      el('td', row.status),
      el('td', row.commands),
      el('td', row.origin),
    );
    tr.addEventListener('click', () => {
      location.hash = routeTo({ view: 'instance', id: row.id });
    });
    tbody.append(tr);
  }
  byId('empty').hidden = instances.length > 0;
  crumb.textContent = '';
  debuggerView.hidden = true;
  listView.hidden = false;
}

function paint(target: BpmnFlowViewer, frame: Frame): void {
  // Sempre do zero: `applySnapshot` preserva fluxos já marcados, então voltar
  // um passo só despinta se a marcação recomeçar.
  target.clear();
  for (const flow of frame.flows) target.markFlowTaken(flow);
  target.applySnapshot(frame.snapshot);

  byId('step-title').textContent = frame.title;
  byId('status').textContent = `estado: ${frame.status}`;
  byId('payload').textContent = frame.payload;

  section(
    'gateways',
    'Gateways',
    frame.gateways.map((gateway) => {
      const box = el('div');
      box.append(el('strong', gateway.name));
      const list = el('ul');
      for (const option of gateway.options) {
        list.append(
          el('li', `${option.label} → ${option.flowId}`, option.taken ? 'option taken' : 'option'),
        );
      }
      box.append(list, kvTable(gateway.variables));
      return box;
    }),
  );
  section('entered', 'Entrou em', frame.entered.length ? [el('p', frame.entered.join(', '))] : []);
  section('variables', 'Variáveis', frame.variables.length ? [kvTable(frame.variables)] : []);
  section(
    'tasks',
    'Pendente',
    frame.tasks.length
      ? [
          kvTable(
            frame.tasks.map((task) => [
              task.tokenId,
              `${task.nodeId} ${task.name} (${task.reason})`,
            ]),
          ),
        ]
      : [],
  );

  slider.max = `${frame.total}`;
  slider.value = `${frame.step}`;
  prev.disabled = frame.step <= 1;
  next.disabled = frame.step >= frame.total;
  shown = frame.step;
}

async function showInstance(id: string, step: number | undefined, ticket: number): Promise<void> {
  if (current?.instance.id !== id) {
    const view = await fetchReplay(id);
    const target = await ensureViewer();
    if (ticket !== navigation) return;
    // O diagrama precisa estar visível para o viewer medir o container.
    listView.hidden = true;
    debuggerView.hidden = false;
    await target.load(view.xml);
    if (ticket !== navigation) return;
    current = view;
  }
  const view = current;
  const target = await ensureViewer();
  if (ticket !== navigation || !view) return;

  const n = clampStep(step, view.steps.length);
  if (n !== step) history.replaceState(null, '', routeTo({ view: 'instance', id, step: n }));
  crumb.textContent = `${view.instance.processKey} v${view.instance.version} · ${view.instance.id}`;
  listView.hidden = true;
  debuggerView.hidden = false;
  paint(target, frameAt(view, n));
}

async function render(): Promise<void> {
  const ticket = ++navigation;
  errorBox.hidden = true;
  const route = parseRoute(location.hash);
  try {
    if (route.view === 'list') {
      current = undefined;
      await showList();
    } else {
      await showInstance(route.id, route.step, ticket);
    }
  } catch (error) {
    if (ticket === navigation) showError(error);
  }
}

function go(step: number): void {
  if (!current) return;
  location.hash = routeTo({ view: 'instance', id: current.instance.id, step });
}

slider.addEventListener('input', () => go(Number(slider.value)));
prev.addEventListener('click', () => go(shown - 1));
next.addEventListener('click', () => go(shown + 1));
window.addEventListener('keydown', (event) => {
  // O próprio slider já anda com as setas quando tem foco; tratar de novo
  // aqui pularia dois passos.
  if (debuggerView.hidden || event.target === slider) return;
  if (event.key === 'ArrowLeft' && shown > 1) go(shown - 1);
  if (event.key === 'ArrowRight' && current && shown < current.steps.length) go(shown + 1);
});
forkButton.addEventListener('click', () => {
  if (!current) return;
  const from = current.instance.id;
  forkButton.disabled = true;
  forkAt(from, shown)
    .then((forked) => {
      location.hash = routeTo({ view: 'instance', id: forked.id });
    })
    .catch(showError)
    .finally(() => {
      forkButton.disabled = false;
    });
});
window.addEventListener('hashchange', () => void render());
void render();
```

- [ ] **Step 6: Build, gate e commit**

Run: `npm run build -w @ebb/console` → sucesso; confira em `apps/console/dist/assets/` que o viewer saiu num chunk próprio (dois `.js`, um bem maior). `npm run verify` → PASS.

```bash
git add apps/console
git commit -m "feat(console): step through a replay on the diagram and fork from any step"
```

---

### Task 6: `ebb console` no CLI

**Files:**

- Create: `packages/cli/src/console.ts`
- Modify: `packages/cli/src/bin.ts`, `packages/cli/package.json`
- Test: `packages/cli/test/console.test.ts` (novo), `packages/cli/test/bin.test.ts`

**Interfaces:**

- Consumes: `createApp`, `serveApp`, `RunningApp` (`@ebb/api`)
- Produces:
  - `assetsBeside(packageJson: string): string | undefined` — `dist/` ao lado do `package.json`, se tiver `index.html`
  - `consoleAssets(): string | undefined` — resolve `@ebb/console/package.json` e chama `assetsBeside`
  - `runConsole(options: { store: Store; runtime: EbbRuntime; port: number; assets: string; log?: (line: string) => void }): Promise<number>` — resolve ao receber `SIGINT`/`SIGTERM`

- [ ] **Step 1: Dependências**

`packages/cli/package.json`, em `dependencies`: `"@ebb/api": "^0.0.0"` e `"@ebb/console": "^0.0.0"`. `npm install`.

- [ ] **Step 2: Testes que falham**

`packages/cli/test/console.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assetsBeside, consoleAssets } from '../src/console.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-console-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('assetsBeside', () => {
  it('acha o dist com index.html ao lado do package.json', async () => {
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'index.html'), '<!doctype html>');
    expect(assetsBeside(join(dir, 'package.json'))).toBe(join(dir, 'dist'));
  });

  it('undefined sem build', () => {
    expect(assetsBeside(join(dir, 'package.json'))).toBeUndefined();
  });
});

describe('consoleAssets', () => {
  it('acha o build do @ebb/console do workspace', () => {
    // O `npm test` builda antes, então o dist existe.
    expect(consoleAssets()).toMatch(/apps[/\\]console[/\\]dist$/);
  });
});
```

Em `bin.test.ts`, depois dos testes de instância (`import { spawn } from 'node:child_process'` no topo, se ainda não estiver; `BIN` e `dir` já existem no arquivo):

```ts
describe('ebb console', () => {
  it('sobe em loopback, responde a api e sai com 0 no SIGINT', async () => {
    await ebb('deploy', 'pedido.bpmn');
    await ebb('start', 'Pedido');

    const child = spawn(process.execPath, [BIN, 'console', '--port', '0'], { cwd: dir });
    let out = '';
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(out);
        if (match) resolve(match[0]);
      });
      child.on('exit', (code) => reject(new Error(`saiu com ${code} antes de subir: ${out}`)));
    });

    const res = await fetch(`${url}/api/instances`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([{ processKey: 'Pedido' }]);
    const page = await fetch(`${url}/`);
    expect(await page.text()).toContain('<title>ebb console</title>');

    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', resolve);
      child.kill('SIGINT');
    });
    expect(code).toBe(0);
  }, 20_000);

  it.each(['x', '-1', '1.5', '70000'])('recusa --port %s com erro de uso', async (port) => {
    expect((await ebb('console', '--port', port)).code).toBe(2);
  });
});
```

Run: `npm run build && npx vitest run packages/cli/test/console.test.ts packages/cli/test/bin.test.ts -t "console|assets"` → FAIL.

- [ ] **Step 3: `console.ts`**

```ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, serveApp } from '@ebb/api';
import type { EbbRuntime } from '@ebb/runtime';
import type { Store } from '@ebb/store';

/** O `dist/` ao lado de um `package.json`, se o build já tiver rodado. */
export function assetsBeside(packageJson: string): string | undefined {
  const dist = join(dirname(packageJson), 'dist');
  return existsSync(join(dist, 'index.html')) ? dist : undefined;
}

/**
 * O build do console, achado pelo pacote e não por caminho relativo ao CLI:
 * funciona igual no workspace e num install.
 */
export function consoleAssets(): string | undefined {
  try {
    return assetsBeside(fileURLToPath(import.meta.resolve('@ebb/console/package.json')));
  } catch {
    // Pacote não instalado: mesmo tratamento de build ausente.
    return undefined;
  }
}

/**
 * Sobe a api com o console e fica até `SIGINT`/`SIGTERM`. Resolve com o
 * código de saída depois de fechar o servidor — o store é do chamador.
 */
export async function runConsole(options: {
  store: Store;
  runtime: EbbRuntime;
  port: number;
  assets: string;
  log?: (line: string) => void;
}): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const app = createApp({ store: options.store, runtime: options.runtime, assets: options.assets });
  const running = await serveApp(app, { port: options.port });
  log(`console em ${running.url} — Ctrl+C para sair`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.close();
  return 0;
}
```

- [ ] **Step 4: `bin.ts`**

Imports: `import { consoleAssets, runConsole } from './console.js';`. Novo `case` antes do `default`:

```ts
      case 'console': {
        const portArg = option(argv, 'port');
        let port = 4321;
        if (argv.includes('--port')) {
          const parsed = Number(portArg);
          if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
            return usageError(`--port esperava um inteiro entre 0 e 65535 e veio "${portArg ?? ''}".`);
          }
          port = parsed;
        }
        const assets = consoleAssets();
        if (!assets) {
          console.error('✗ O console não foi construído. Rode: npm run build');
          return 1;
        }
        return await runConsole({ store, runtime, port, assets });
      }
```

USAGE, nova seção antes de "O <id> aceita…":

```
Console:
  ebb console [--port N]                depurador de time-travel no navegador (padrão: 4321)
```

- [ ] **Step 5: Rodar, gate e commit**

Run: `npm run build && npx vitest run packages/cli` → PASS. `npm run verify` → PASS.

Se `import.meta.resolve` do `@ebb/console/package.json` falhar no teste por causa de `exports`, confira que o `package.json` do console tem `"exports": { "./package.json": "./package.json" }` (Tarefa 4) e registre.

```bash
git add packages/cli package-lock.json
git commit -m "feat(cli): open the time-travel console with ebb console"
```

---

### Task 7: Navegador, vitrine e roteiro

**Files:**

- Modify: `README.md`, `handoff.md`, `CLAUDE.md`

- [ ] **Step 1: Montar a demonstração**

No scratchpad, um diretório com o `GATEWAY` como `aprovacao.bpmn`:

```bash
EBB=/home/bappoz/Work/personal_repos/ebb/packages/cli/dist/bin.js
node $EBB deploy aprovacao.bpmn
node $EBB start Aprovacao --var 'nota=<b>x</b>'      # anote <id> e o token t1
node $EBB complete <id> t1 --var valor=150
node $EBB start Aprovacao                            # instância de um passo só
node $EBB console --port 4321                        # em background (run_in_background)
```

- [ ] **Step 2: Roteiro no Chrome** (ferramentas `mcp__claude-in-chrome__*`, gravando com `gif_creator` como `ebb-console-time-travel.gif`)

1. `http://127.0.0.1:4321/` → a lista mostra as duas instâncias.
2. Abrir a do gateway → abre no último passo (2 de 2): `Diretoria` ativa/esperando, `Flow_Alto` pintado; painel com `Valor alto?`, `valor > 100 → Flow_Alto` destacado, `valor = 150`.
3. ◀ → passo 1: `Flow_Alto` **despintado**, `Avaliar` esperando; variável `nota` aparece como o texto literal `"<b>x</b>"`, sem negrito.
4. Seta → do teclado (fora do slider) → volta ao passo 2.
5. No passo 1, "Bifurcar daqui" → URL muda para a instância nova; título `passo 1 de 1`; ◀ ▶ desabilitados.
6. Voltar à lista → a bifurcação aparece com origem `<id>@1`.
7. Abrir a instância de um passo só → slider travado em 1.
8. `#/i/nao-existe` → mensagem de erro com "voltar à lista", sem tela em branco.
9. Clicar numa instância e, antes de carregar, voltar (`history.back()` pelo `javascript_tool`) → a lista fica, sem o depurador aparecer por cima.
10. Pelo `javascript_tool`: `fetch('/api/instances/<id>/fork', { method: 'POST', body: '{"seq":1}' })` sem `Content-Type` → `415`.

Qualquer passo que divergir é defeito da tarefa dona: volte a ela (TDD se a lógica estiver em `timeline.ts`/api). Encerre o `ebb console` ao fim.

- [ ] **Step 3: README, CLAUDE.md, handoff**

- `README.md`: depois de "Rebobinar e bifurcar", subseção **"No navegador"**: `ebb console`, o que a tela mostra, e que ele só atende em `127.0.0.1` (sem auth até a seção 3). Referencie o GIF só se ele for versionado — não versione (é binário); descreva em texto.
- `CLAUDE.md`, tabela de pacotes: `@ebb/api` (HTTP do ebb; hoje o console, amanhã workers e SDK) e `apps/console` (depurador de time-travel). Tire `api` e `console` da frase "Os demais … entram nos chunks seguintes".
- `handoff.md`: Seção 1 inteira feita (3a + 3b); "Onde estamos" aponta para a Seção 2 (teste de processo) como próxima; Seção 3 registra que o `@ebb/api` já existe com três rotas e as travas de loopback/`Host`/`Content-Type`, e que auth vai substituir a trava de loopback, não se somar a ela sem pensar.

- [ ] **Step 4: Gate e commit**

Run: `npm run verify` → PASS.

```bash
git add README.md handoff.md CLAUDE.md
git commit -m "docs: document the console and hand off to section 2"
```

- [ ] **Step 5: PR (com confirmação)**

Push e PR são externos: confirme com o usuário. Corpo no formato dos PRs anteriores ("O que muda", "Verificação" com o roteiro do navegador e o que ele mostrou, "Fica para depois"), terminando com `https://claude.ai/code/session_01DNVsCEFXN3mXPvFCDwbpjb`.
