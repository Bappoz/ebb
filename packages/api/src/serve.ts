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
 * real — `port: 0` pede uma livre ao sistema, que é o que o teste e quem tem
 * a 4321 ocupada precisam. Sem opção de host: expor fora de loopback espera
 * auth (seção 3).
 */
export function serveApp(app: Hono, options: { port: number }): Promise<RunningApp> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: options.port, hostname: '127.0.0.1' },
      (info: AddressInfo) => {
        resolve({
          port: info.port,
          url: `http://127.0.0.1:${info.port}`,
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
