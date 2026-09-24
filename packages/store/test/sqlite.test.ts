import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '../src/sqlite.js';
import { checksumOf } from '../src/checksum.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/migrations.js';

const XML_V1 = '<definitions><process id="Pedido" /></definitions>';
const XML_V2 = '<definitions><process id="Pedido" name="Pedido" /></definitions>';

function input(xml: string, overrides: Record<string, unknown> = {}) {
  return { processKey: 'Pedido', xml, checksum: checksumOf(xml), ...overrides };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SqliteStore', () => {
  it('numera a primeira versão como 1', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    const result = await store.deploy(input(XML_V1));

    expect(result.created).toBe(true);
    expect(result.deployment.version).toBe(1);
    expect(result.deployment.processKey).toBe('Pedido');
    store.close();
  });

  it('publicar o mesmo conteúdo não cria versão nova', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    await store.deploy(input(XML_V1));
    const again = await store.deploy(input(XML_V1));

    expect(again.created).toBe(false);
    expect(again.deployment.version).toBe(1);
    expect(await store.versions('Pedido')).toHaveLength(1);
    store.close();
  });

  it('conteúdo diferente vira a próxima versão', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    await store.deploy(input(XML_V1));
    const second = await store.deploy(input(XML_V2, { name: 'Pedido' }));

    expect(second.created).toBe(true);
    expect(second.deployment.version).toBe(2);
    expect((await store.versions('Pedido')).map((d) => d.version)).toEqual([2, 1]);
    store.close();
  });

  it('volta a versionar quando o conteúdo antigo é republicado', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    await store.deploy(input(XML_V1));
    await store.deploy(input(XML_V2));
    // Só a última versão conta para a deduplicação: voltar atrás é uma mudança.
    const back = await store.deploy(input(XML_V1));

    expect(back.created).toBe(true);
    expect(back.deployment.version).toBe(3);
    store.close();
  });

  it('versiona cada processo por conta própria', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    await store.deploy(input(XML_V1));
    await store.deploy(input(XML_V2));
    await store.deploy({ ...input(XML_V1), processKey: 'Cobranca' });

    expect((await store.read('Pedido'))?.version).toBe(2);
    expect((await store.read('Cobranca'))?.version).toBe(1);
    store.close();
  });

  it('lê uma versão específica e a mais recente', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    await store.deploy(input(XML_V1));
    await store.deploy(input(XML_V2));

    expect((await store.read('Pedido'))?.xml).toBe(XML_V2);
    expect((await store.read('Pedido', 1))?.xml).toBe(XML_V1);
    expect(await store.read('Pedido', 99)).toBeUndefined();
    expect(await store.read('NaoExiste')).toBeUndefined();
    store.close();
  });

  it('lista cada processo com a versão atual e o total', async () => {
    const store = new SqliteStore({
      path: ':memory:',
      now: () => new Date('2026-09-14T10:00:00Z'),
    });
    await store.deploy(input(XML_V1, { source: 'pedido.bpmn' }));
    await store.deploy(input(XML_V2, { name: 'Pedido', source: 'pedido.bpmn' }));
    await store.deploy({ ...input(XML_V1), processKey: 'Cobranca' });

    expect(await store.listProcesses()).toEqual([
      {
        processKey: 'Cobranca',
        latestVersion: 1,
        versions: 1,
        deployedAt: '2026-09-14T10:00:00.000Z',
      },
      {
        processKey: 'Pedido',
        name: 'Pedido',
        latestVersion: 2,
        versions: 2,
        deployedAt: '2026-09-14T10:00:00.000Z',
        source: 'pedido.bpmn',
      },
    ]);
    store.close();
  });

  it('nada publicado é uma lista vazia, não um erro', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    expect(await store.listProcesses()).toEqual([]);
    expect(await store.versions('Pedido')).toEqual([]);
    store.close();
  });

  it('sobrevive a um reinício, criando o diretório se faltar', async () => {
    const path = join(dir, 'aninhado', 'ebb.db');
    const first = new SqliteStore({ path });
    await first.deploy(input(XML_V1));
    first.close();

    const second = new SqliteStore({ path });
    expect((await second.read('Pedido'))?.xml).toBe(XML_V1);
    second.close();
  });

  it('aplicar o esquema duas vezes é uma não-operação', async () => {
    const path = join(dir, 'ebb.db');
    const first = new SqliteStore({ path });
    await first.deploy(input(XML_V1));
    first.close();

    // Abrir de novo roda a migração outra vez; nada pode ser perdido.
    const second = new SqliteStore({ path });
    expect(await second.versions('Pedido')).toHaveLength(1);
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
    second.close();
  });

  it('aplica a migração das tabelas de instância', async () => {
    const store = new SqliteStore({ path: join(dir, 'ebb.db') });
    await store.deploy(input(XML_V1));
    store.close();

    const raw = new DatabaseSync(join(dir, 'ebb.db'));
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    raw.close();

    expect(SCHEMA_VERSION).toBe(4);
    expect(tables).toContain('instances');
    expect(tables).toContain('instance_journal');
    expect(tables).toContain('instance_state');
    expect(tables).toContain('jobs');
  });

  it('migra um banco no esquema 3 com instâncias sem perder nada', async () => {
    const path = join(dir, 'v3.db');
    const raw = new DatabaseSync(path);
    // Aplica só até a 3, como um ebb do chunk 2 teria deixado o arquivo.
    raw.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) {
      raw.exec(migration.up);
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, 'x');
    }
    raw.exec(`INSERT INTO deployments VALUES ('Pedido', 1, NULL, '<x/>', 'c', NULL, 'x')`);
    raw.exec(`INSERT INTO instances VALUES ('i1', 'Pedido', 1, 'waiting', 1, 'x', 'x')`);
    raw.close();

    const store = new SqliteStore({ path });
    const instance = await store.readInstance('i1');
    store.close();

    expect(instance).toMatchObject({ id: 'i1', status: 'waiting' });
    expect(instance).not.toHaveProperty('forkedFrom');
  });
});

describe('checksumOf', () => {
  it('é estável e distingue conteúdo', () => {
    expect(checksumOf(XML_V1)).toBe(checksumOf(XML_V1));
    expect(checksumOf(XML_V1)).not.toBe(checksumOf(XML_V2));
    expect(checksumOf(XML_V1)).toMatch(/^[0-9a-f]{64}$/);
  });
});
