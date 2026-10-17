import {
  InstanceNotFoundError,
  InstanceTerminatedError,
  ReplayRangeError,
  type EbbRuntime,
} from '@ebb/runtime';
import type { Store } from '@ebb/store';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { humanTask, incidentRecord } from './types.js';

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

export class UnsupportedMediaTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaTypeError';
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

  app.get('/api/processes', async (c) => c.json(await store.listProcesses()));

  app.post('/api/instances', async (c) => {
    const body = await jsonObject(c);
    const processKey = requiredText(body, 'processKey');
    const version = optionalInteger(body, 'version', 1);
    const variables = optionalObject(body, 'variables');
    const retries = optionalInteger(body, 'retries', 0);
    const result = await runtime.start(processKey, {
      ...(version === undefined ? {} : { version }),
      ...(variables === undefined ? {} : { variables }),
      ...(retries === undefined ? {} : { engine: { retry: { attempts: retries } } }),
    });
    return c.json(result, 201);
  });

  app.get('/api/instances/:id', async (c) => c.json(await runtime.inspect(c.req.param('id'))));

  app.get('/api/instances/:id/replay', async (c) =>
    c.json(await runtime.replay(c.req.param('id'))),
  );

  app.post('/api/instances/:id/fork', async (c) => {
    const seq = requiredInteger(await jsonObject(c), 'seq', 1);
    const forked = await runtime.fork(c.req.param('id'), seq);
    return c.json({ instance: forked.instance }, 201);
  });

  app.get('/api/tasks', async (c) => {
    const tasks = [];
    for (const instance of await store.listInstances()) {
      if (instance.status !== 'waiting') continue;
      const view = await runtime.inspect(instance.id);
      for (const task of view.tasks) {
        if (task.reason === 'userTask') tasks.push(humanTask(instance, task));
      }
    }
    return c.json(tasks);
  });

  app.post('/api/tasks/:instanceId/:tokenId/complete', async (c) => {
    const body = await jsonObject(c);
    const output = optionalObject(body, 'output');
    const instanceId = c.req.param('instanceId');
    const tokenId = c.req.param('tokenId');
    const view = await runtime.inspect(instanceId);
    const task = view.tasks.find((candidate) => candidate.tokenId === tokenId);
    if (!task || task.reason !== 'userTask') {
      throw new BadRequestError(`O token "${tokenId}" não é uma tarefa humana pendente.`);
    }
    const result = await runtime.apply(instanceId, {
      type: 'completeTask',
      tokenId,
      ...(output === undefined ? {} : { output }),
    });
    return c.json(result);
  });

  app.get('/api/incidents', async (c) => {
    const incidents = [];
    for (const instance of await store.listInstances()) {
      if (instance.status !== 'waiting') continue;
      const view = await runtime.inspect(instance.id);
      for (const incident of view.incidents) {
        const variables =
          view.tasks.find((task) => task.tokenId === incident.tokenId)?.variables ??
          view.snapshot.variables;
        incidents.push(incidentRecord(instance, incident, variables));
      }
    }
    return c.json(incidents);
  });

  app.post('/api/incidents/:instanceId/:tokenId/retry', async (c) => {
    await jsonObject(c);
    const instanceId = c.req.param('instanceId');
    const tokenId = c.req.param('tokenId');
    await requireIncident(runtime, instanceId, tokenId);
    return c.json(await runtime.apply(instanceId, { type: 'retryTask', tokenId }));
  });

  app.post('/api/incidents/:instanceId/:tokenId/resolve', async (c) => {
    const output = optionalObject(await jsonObject(c), 'output');
    const instanceId = c.req.param('instanceId');
    const tokenId = c.req.param('tokenId');
    await requireIncident(runtime, instanceId, tokenId);
    return c.json(
      await runtime.apply(instanceId, {
        type: 'resolveIncident',
        tokenId,
        ...(output === undefined ? {} : { output }),
      }),
    );
  });

  app.all('/api/*', (c) => c.json({ error: 'Rota desconhecida.' }, 404));

  if (options.assets) {
    // `serveStatic` recusa caminho com `..` (getFilePath do Hono), e o
    // fallback abaixo sempre entrega o mesmo arquivo: nada fora de `assets`
    // sai por aqui.
    app.use('*', serveStatic({ root: options.assets }));
    // O console roteia por hash, mas um link colado com caminho não pode dar
    // tela em branco: qualquer outra rota recebe o index.
    app.get('*', serveStatic({ root: options.assets, path: 'index.html' }));
  }

  app.notFound((c) => c.json({ error: 'Não encontrado.' }, 404));

  app.onError((error, c) => {
    if (error instanceof UnsupportedMediaTypeError) {
      return c.json({ error: error.message }, 415);
    }
    if (error instanceof BadRequestError || error instanceof ReplayRangeError) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof InstanceNotFoundError) return c.json({ error: error.message }, 404);
    if (error instanceof InstanceTerminatedError) return c.json({ error: error.message }, 409);
    // Mensagem sim, stack não: quem chama precisa saber o que houve, não
    // onde no nosso código.
    return c.json({ error: error.message }, 500);
  });

  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escritas locais ainda exigem JSON: formulário cross-origin não passa daqui. */
async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new UnsupportedMediaTypeError('Envie o corpo como application/json.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await c.req.text());
  } catch {
    throw new BadRequestError('O corpo tem de ser JSON válido.');
  }
  if (!isRecord(parsed)) {
    throw new BadRequestError('O corpo tem de ser um objeto JSON.');
  }
  return parsed;
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`"${field}" tem de ser texto não vazio.`);
  }
  return value;
}

function optionalObject(
  body: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new BadRequestError(`"${field}" tem de ser um objeto.`);
  return value;
}

function requiredInteger(body: Record<string, unknown>, field: string, minimum: number): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new BadRequestError(`"${field}" tem de ser um inteiro maior ou igual a ${minimum}.`);
  }
  return value;
}

function optionalInteger(
  body: Record<string, unknown>,
  field: string,
  minimum: number,
): number | undefined {
  return body[field] === undefined ? undefined : requiredInteger(body, field, minimum);
}

async function requireIncident(
  runtime: EbbRuntime,
  instanceId: string,
  tokenId: string,
): Promise<void> {
  const view = await runtime.inspect(instanceId);
  if (!view.incidents.some((incident) => incident.tokenId === tokenId)) {
    throw new BadRequestError(`O token "${tokenId}" não é um incidente aberto.`);
  }
}
