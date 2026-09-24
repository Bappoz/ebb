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
