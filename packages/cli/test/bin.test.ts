import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Exercita o binário **construído**, não os fontes.
 *
 * Os outros testes importam `src/`, então não veriam um build que empacota
 * errado — foi assim que `node:sqlite` virou `sqlite` no `dist` e o CLI parou
 * de subir enquanto a suíte continuava verde.
 */
const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bin.js');

const PEDIDO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Pedido" name="Processo de Pedido" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

let dir: string;

/** Roda o CLI num diretório próprio; devolve saída e código, sem lançar. */
async function ebb(...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [BIN, ...args], { cwd: dir });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, code: failure.code ?? 1 };
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ebb-bin-'));
  await writeFile(join(dir, 'pedido.bpmn'), PEDIDO, 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ebb (binário construído)', () => {
  it('publica, lista e versiona num diretório limpo', async () => {
    const empty = await ebb('ls');
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain('ebb deploy');

    const deployed = await ebb('deploy', 'pedido.bpmn');
    expect(deployed.code).toBe(0);
    expect(deployed.stdout).toContain('publicado: Processo de Pedido (Pedido) v1');

    const listed = await ebb('ls');
    expect(listed.stdout).toContain('Processo de Pedido');
    expect(listed.stdout).toContain('pedido.bpmn');

    const history = await ebb('versions', 'Pedido');
    expect(history.stdout).toContain('v1');
  });

  it('grava em .ebb/ do diretório de trabalho e sobrevive entre execuções', async () => {
    await ebb('deploy', 'pedido.bpmn');
    // Processo novo, banco no disco: tem de enxergar o que o anterior publicou.
    expect((await ebb('ls')).stdout).toContain('Pedido');
    expect((await ebb('deploy', 'pedido.bpmn')).stdout).toContain('sem mudança');
  });

  it('sai com 2 e mostra o uso quando o comando não existe', async () => {
    const unknown = await ebb('inventado');
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain('ebb deploy');
  });

  it('sai com 2 quando falta o arquivo do deploy', async () => {
    expect((await ebb('deploy')).code).toBe(2);
    expect((await ebb('versions')).code).toBe(2);
  });

  it('--help sai com 0', async () => {
    const help = await ebb('--help');
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('rebobinar');
  });

  it('respeita --store', async () => {
    await ebb('deploy', 'pedido.bpmn', '--store', 'outro.db');
    // O padrão continua vazio: o banco foi para o caminho pedido.
    expect((await ebb('ls')).stdout).toContain('Nada publicado');
    expect((await ebb('ls', '--store', 'outro.db')).stdout).toContain('Pedido');
  });

  it('uma instância sobrevive à morte do processo', async () => {
    await ebb('deploy', 'pedido.bpmn');

    // Processo 1: cria.
    const started = await ebb('start', 'Pedido', '--var', 'total=42');
    expect(started.code).toBe(0);
    const id = started.stdout.match(/instância (\S+)/)?.[1];
    if (!id) throw new Error(`sem id na saída: ${started.stdout}`);

    // Processo 2: outro processo do SO, nada em memória do anterior.
    const shown = await ebb('show', id.slice(0, 8));
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('waiting');
    expect(shown.stdout).toContain('Separar itens');
    expect(shown.stdout).toContain('42');

    const token = shown.stdout.match(/^(\S+)\s+Separar\s/m)?.[1];
    if (!token) throw new Error(`sem token na saída: ${shown.stdout}`);

    // Processo 3: continua de onde o processo 1 parou.
    const done = await ebb('complete', id.slice(0, 8), token, '--var', 'separadoPor=ana');
    expect(done.code).toBe(0);
    expect(done.stdout).toContain('completed');

    // Processo 4: o estado final persistiu.
    const after = await ebb('show', id.slice(0, 8));
    expect(after.stdout).toContain('completed');
    expect(after.stdout).toContain('ana');

    // O journal tem os dois comandos, que é o que o chunk 3 vai replayar.
    const journal = await ebb('journal', id.slice(0, 8));
    expect(journal.stdout).toContain('start');
    expect(journal.stdout).toContain('completeTask');
  });

  it('ps lista o que start criou', async () => {
    await ebb('deploy', 'pedido.bpmn');
    await ebb('start', 'Pedido');

    const listed = await ebb('ps');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain('Pedido');
    expect(listed.stdout).toContain('waiting');
  });

  it('sai com 2 quando falta o argumento de um comando de instância', async () => {
    expect((await ebb('start')).code).toBe(2);
    expect((await ebb('show')).code).toBe(2);
    expect((await ebb('complete', 'abc')).code).toBe(2);
  });
});
