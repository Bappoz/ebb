import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EbbRuntime } from '@ebb/runtime';
import type { JobRecord } from '@ebb/store';
import type { CommandResult } from './commands.js';
import { CHECK, CROSS } from './output.js';

export interface WorkerOptions {
  type: string;
  command: string[];
  once?: boolean;
  lease?: number;
  interval?: number;
  count?: number;
}

interface Outcome {
  output?: Record<string, unknown>;
  error?: { message: string; code?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * O que o processo filho disse, traduzido para desfecho de job.
 *
 * Saída zero com stdout ilegível é falha, não sucesso silencioso: um worker
 * que imprime lixo não sabe o que fez, e concluir a atividade aí é perder o
 * único momento em que dá para perceber.
 */
function readOutcome(code: number, stdout: string, stderr: string): Outcome {
  const text = stdout.trim();
  let parsed: unknown;
  try {
    parsed = text === '' ? {} : JSON.parse(text);
  } catch {
    return {
      error: {
        message: `o worker respondeu algo que não é JSON: ${text.slice(0, 200)}`,
      },
    };
  }
  if (code === 0) {
    if (!isRecord(parsed))
      return { error: { message: 'o worker respondeu um JSON que não é objeto.' } };
    return { output: parsed };
  }
  const business = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  const businessCode = typeof business?.code === 'string' ? business.code : undefined;
  const message =
    (typeof business?.message === 'string' ? business.message : undefined) ??
    (stderr.trim() || `o worker saiu com código ${code}`);
  return { error: { message, ...(businessCode ? { code: businessCode } : {}) } };
}

/** Roda o comando para um job, com o job no stdin. */
function runOnce(command: string[], job: JobRecord): Promise<Outcome> {
  const [bin, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(bin!, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ error: { message: error.message } }));
    child.on('close', (code) => resolve(readOutcome(code ?? 0, stdout, stderr)));
    child.stdin.end(
      JSON.stringify({
        instanceId: job.instanceId,
        tokenId: job.tokenId,
        nodeId: job.nodeId,
        type: job.type,
        variables: job.variables,
      }),
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `ebb worker <tipo> -- <comando>`.
 *
 * Um job por vez, em série: paralelismo é decisão de operação, e não há número
 * medido para justificar um padrão. Sem timeout de processo filho de propósito
 * — o lease já devolve o job de um worker travado, e um segundo mecanismo
 * precisaria de um número que ninguém mediu.
 */
export async function runWorker(
  runtime: EbbRuntime,
  options: WorkerOptions,
): Promise<CommandResult> {
  const worker = `${options.type}-${randomUUID().slice(0, 8)}`;
  const lines: string[] = [];
  let stop = false;
  process.once('SIGINT', () => (stop = true));

  do {
    const jobs = await runtime.activateJobs({
      type: options.type,
      worker,
      ...(options.count === undefined ? {} : { count: options.count }),
      ...(options.lease === undefined ? {} : { lease: options.lease }),
    });
    for (const job of jobs) {
      const outcome = await runOnce(options.command, job);
      if (outcome.error) {
        await runtime.failJob(job.instanceId, job.tokenId, outcome.error, { worker });
        lines.push(`${CROSS} ${job.tokenId} — ${outcome.error.message}`);
      } else {
        await runtime.completeJob(job.instanceId, job.tokenId, outcome.output);
        lines.push(`${CHECK} ${job.tokenId} — ${job.nodeId}`);
      }
    }
    if (options.once) break;
    if (jobs.length === 0) await sleep(options.interval ?? 1_000);
  } while (!stop);

  return {
    output: lines.length > 0 ? lines.join('\n') : 'Nenhum job pendente.',
    exitCode: 0,
  };
}
