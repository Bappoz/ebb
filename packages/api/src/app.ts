import { InstanceNotFoundError, ReplayRangeError, type EbbRuntime } from '@ebb/runtime';
import type { Store } from '@ebb/store';
import { serveStatic } from '@hono/node-server/serve-static';
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
