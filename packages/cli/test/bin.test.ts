import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('tick --at aplica um instante explícito e o journal ganha a entrada', async () => {
    await ebb('deploy', 'pedido.bpmn');
    const started = await ebb('start', 'Pedido');
    const id = started.stdout.match(/instância (\S+)/)?.[1];
    if (!id) throw new Error(`sem id na saída: ${started.stdout}`);

    const future = new Date(Date.now() + 60_000).toISOString();
    const ticked = await ebb('tick', id.slice(0, 8), '--at', future);
    expect(ticked.code).toBe(0);

    const journal = await ebb('journal', id.slice(0, 8));
    expect(journal.stdout).toContain('tick');
  });

  it('fork e show --at recusam passo que não é inteiro positivo', async () => {
    await ebb('deploy', 'pedido.bpmn');
    const started = await ebb('start', 'Pedido');
    const id = started.stdout.match(/instância (\S+)/)?.[1] ?? '';
    expect(id).not.toBe('');

    for (const bad of ['0', '1.5', '-1', 'x']) {
      const fork = await ebb('fork', id, '--at', bad);
      expect(fork.code).toBe(2);
      expect(fork.stdout).toContain('--at');
      expect((await ebb('show', id, '--at', bad)).code).toBe(2);
    }
    expect((await ebb('fork', id)).code).toBe(2);
    expect((await ebb('fork')).code).toBe(2);

    const forked = await ebb('fork', id, '--at', '1');
    expect(forked.code).toBe(0);
    expect(forked.stdout).toContain('bifurcada');
  });

  it('show --at sem valor é erro de uso, não o estado atual em silêncio', async () => {
    await ebb('deploy', 'pedido.bpmn');
    const started = await ebb('start', 'Pedido');
    const id = started.stdout.match(/instância (\S+)/)?.[1] ?? '';

    const show = await ebb('show', id, '--at');
    expect(show.code).toBe(2);
    expect(show.stdout).toContain('--at');
  });

  it('sai com 2 quando --at é malformado', async () => {
    await ebb('deploy', 'pedido.bpmn');
    const started = await ebb('start', 'Pedido');
    const id = started.stdout.match(/instância (\S+)/)?.[1];
    if (!id) throw new Error(`sem id na saída: ${started.stdout}`);

    const bad = await ebb('tick', id.slice(0, 8), '--at', 'não-é-uma-data');
    expect(bad.code).toBe(2);
  });
});

// Job externo, processado por um worker que é o próprio binário construído.
const JOB = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  targetNamespace="http://ebb.test" id="Defs">
  <bpmn:process id="Job" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Charge" name="Charge card">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="charge" />
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start" targetRef="Charge" />
    <bpmn:sequenceFlow id="f2" sourceRef="Charge" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const OK_SCRIPT = '#!/bin/sh\nread input\necho \'{"authorized":true}\'\n';

describe('ebb worker (argumentos)', () => {
  it('sai com 2 quando falta o -- com o comando', async () => {
    const result = await ebb('worker', 'charge');
    expect(result.code).toBe(2);
  });

  it('sai com 2 quando --lease não é um inteiro', async () => {
    const result = await ebb('worker', 'charge', '--lease', 'abc', '--', 'true');
    expect(result.code).toBe(2);
  });

  it('--store depois do -- é argumento do comando filho, não hijacka o banco do ebb', async () => {
    // Se `--store` fosse lido do argv inteiro (antes da correção), o `ebb`
    // tentaria abrir o banco num caminho que não existe e falharia antes de
    // sequer chegar no worker — em vez de usar o padrão `.ebb/ebb.db`.
    const result = await ebb(
      'worker',
      'charge',
      '--once',
      '--',
      'true',
      '--store',
      '/não/existe/nem/vai/existir.db',
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Nenhum job');
  });
});

/**
 * A segurança de cross-process do lease não tem como ser provada com dois
 * `SqliteStore` no mesmo processo: `node:sqlite` é síncrono e cada chamada
 * resolve antes da próxima começar, então nunca haveria disputa de verdade —
 * só ordem de execução. Aqui são dois processos do SO de verdade, apontando
 * pro mesmo arquivo `.ebb/ebb.db`, disparados sem esperar um pelo outro para
 * maximizar a chance de os dois baterem no `lockJobs` ao mesmo tempo.
 *
 * A asserção não depende de qual processo venceu a corrida — só de que o
 * resultado é seguro: o job não pode ser completado duas vezes. Forçar uma
 * sobreposição exata de instante entre dois processos do SO não é algo que dê
 * para garantir de fora sem inventar um ponto de sincronização artificial
 * (que mudaria o que está sendo testado); o que fica garantido de verdade,
 * sempre, é a invariante — e é ela que a asserção cobra.
 */
describe('ebb worker (cross-process)', () => {
  it('dois workers no mesmo banco nunca completam o mesmo job duas vezes', async () => {
    await writeFile(join(dir, 'job.bpmn'), JOB, 'utf8');
    const script = join(dir, 'ok.sh');
    await writeFile(script, OK_SCRIPT, 'utf8');
    await chmod(script, 0o755);

    await ebb('deploy', 'job.bpmn');
    const started = await ebb('start', 'Job');
    const id = started.stdout.match(/instância (\S+)/)?.[1];
    if (!id) throw new Error(`sem id na saída: ${started.stdout}`);

    // Sem `await` entre os dois: os processos nascem em paralelo de verdade.
    const [a, b] = await Promise.all([
      ebb('worker', 'charge', '--once', '--', script),
      ebb('worker', 'charge', '--once', '--', script),
    ]);

    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    // Independente de ordem: exatamente um dos dois viu o job (✓) e o outro
    // não viu nenhum — nunca os dois com ✓, nunca os dois vazios. Isto pina
    // "só um worker reivindicou o job" no nível do worker, não só no journal.
    const claimed = [a.stdout, b.stdout].filter((out) => out.includes('✓'));
    const empty = [a.stdout, b.stdout].filter((out) => out.includes('Nenhum job pendente.'));
    expect(claimed).toHaveLength(1);
    expect(empty).toHaveLength(1);

    expect((await ebb('jobs')).stdout).toContain('Nenhum job');

    const shown = await ebb('show', id.slice(0, 8));
    expect(shown.stdout).toContain('completed');

    const journal = await ebb('journal', id.slice(0, 8));
    const completions = journal.stdout.split('\n').filter((line) => line.includes('completeJob'));
    expect(completions).toHaveLength(1);
  });
});
