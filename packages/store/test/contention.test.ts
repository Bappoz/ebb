import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checksumOf } from '../src/checksum.js';
import { SqliteStore } from '../src/sqlite.js';

const XML = '<definitions><process id="Pedido" /></definitions>';
const JOBS = 40;
const STORE_URL = new URL('../dist/index.js', import.meta.url).href;

// O filho abre o próprio SqliteStore, avisa que está pronto e só disputa
// depois que a barreira existe: sem isso, um processo terminaria antes de o
// outro abrir o banco, e o teste passaria sem contenção nenhuma.
const CHILD = `
const [storeUrl, path, barrier, worker] = process.argv.slice(1);
const { SqliteStore } = await import(storeUrl);
const { existsSync } = await import('node:fs');
const store = new SqliteStore({ path });
process.stdout.write('ready\\n');
while (!existsSync(barrier)) await new Promise((r) => setTimeout(r, 2));
const got = [];
for (;;) {
  const jobs = await store.lockJobs({ type: 'charge', worker, count: 1, until: 9e12, now: 1000 });
  if (jobs.length === 0) break;
  got.push(jobs[0].tokenId);
}
store.close();
process.stdout.write(JSON.stringify(got) + '\\n');
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-contention-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Contender {
  ready: Promise<void>;
  done: Promise<string[]>;
}

function contender(path: string, barrier: string, worker: string): Contender {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', CHILD, STORE_URL, path, barrier, worker],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let out = '';
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (signalReady = resolve));
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    if (out.startsWith('ready\n')) signalReady();
  });
  const done = new Promise<string[]>((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${worker} saiu com ${code}`));
      const last = out.trim().split('\n').at(-1) ?? '[]';
      const parsed: unknown = JSON.parse(last);
      if (!Array.isArray(parsed)) return reject(new Error(`${worker} não devolveu lista`));
      resolve(parsed.map(String));
    });
  });
  return { ready, done };
}

it('dois processos nunca recebem o mesmo job', async () => {
  const path = join(dir, 'ebb.db');
  const barrier = join(dir, 'go');
  const seed = new SqliteStore({ path });
  await seed.deploy({ processKey: 'Pedido', xml: XML, checksum: checksumOf(XML) });
  const tokens = Array.from({ length: JOBS }, (_, i) => `t${String(i).padStart(2, '0')}`);
  await seed.createInstance({
    id: 'i1',
    processKey: 'Pedido',
    version: 1,
    status: 'waiting',
    command: { type: 'start', payload: {}, at: 1 },
    state: { engineVersion: 10, json: '{}' },
    jobs: tokens.map((tokenId) => ({
      tokenId,
      nodeId: 'Charge',
      type: 'charge',
      variables: {},
      attempts: 0,
    })),
  });
  seed.close();

  const a = contender(path, barrier, 'w1');
  const b = contender(path, barrier, 'w2');
  // Um filho que morre antes do `ready` rejeita o `done`: a corrida faz o
  // teste falhar na hora em vez de esperar o timeout.
  await Promise.race([Promise.all([a.ready, b.ready]), Promise.all([a.done, b.done])]);
  await writeFile(barrier, '');
  const [gotA, gotB] = await Promise.all([a.done, b.done]);

  expect(gotA.filter((token) => gotB.includes(token))).toEqual([]);
  expect([...gotA, ...gotB].sort()).toEqual(tokens);
}, 30_000);
