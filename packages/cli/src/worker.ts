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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tenta ler `{"error":{"code","message"}}` de um JSON já parseado; `undefined` quando não tem essa forma. */
function businessError(parsed: unknown): { message?: string; code?: string } | undefined {
  return isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
}

/**
 * O que o processo filho disse, traduzido para desfecho de job.
 *
 * A ordem importa: saída != 0 é sempre falha técnica ou de negócio, nunca
 * erro de contrato — mesmo quando o stdout não é JSON válido, porque nesse
 * caso o stdout não é o canal de diagnóstico, o stderr é. Só uma saída ZERO
 * com stdout ilegível é erro de contrato: um worker que diz "deu certo" mas
 * não sabe dizer o quê não deu certo de verdade, e concluir a atividade aí é
 * perder o único momento em que dá para perceber.
 */
function readOutcome(code: number, stdout: string, stderr: string): Outcome {
  const text = stdout.trim();

  if (code !== 0) {
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined; // stdout não é JSON: pista descartada, stderr é a mensagem.
    }
    const business = businessError(parsed);
    const businessCode = typeof business?.code === 'string' ? business.code : undefined;
    const message =
      (typeof business?.message === 'string' ? business.message : undefined) ??
      (stderr.trim() || `o worker saiu com código ${code}`);
    return { error: { message, ...(businessCode ? { code: businessCode } : {}) } };
  }

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
  if (!isRecord(parsed)) {
    return { error: { message: 'o worker respondeu um JSON que não é objeto.' } };
  }
  // Stdout vazio (ou "{}") conclui sem variável nova — não registra um output vazio no journal.
  return { output: Object.keys(parsed).length > 0 ? parsed : undefined };
}

/**
 * Decodifica a saída de um filho. Juntar os bytes antes de decodificar é o
 * ponto: um pipe corta onde quer, inclusive no meio de um caractere
 * multibyte, e decodificar pedaço a pedaço viraria `�`.
 */
export function decodeUtf8(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8');
}

/** Roda o comando para um job, com o job no stdin. */
function runOnce(command: string[], job: JobRecord): Promise<Outcome> {
  const [bin, ...args] = command;
  return new Promise((resolve) => {
    const child = spawn(bin!, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error) => resolve({ error: { message: error.message } }));
    child.on('close', (code) => {
      const stdout = decodeUtf8(stdoutChunks);
      const stderr = decodeUtf8(stderrChunks);
      resolve(readOutcome(code ?? 0, stdout, stderr));
    });
    // Um filho que sai sem drenar o stdin (o `BOOM` do teste, ou qualquer
    // processo que não lê a entrada) faz `end()` estourar EPIPE — o próprio
    // `close` já é o sinal autoritativo do que aconteceu, então não há nada
    // para aprender de um erro de escrita: só evita que ele suba como
    // exceção não tratada e derrube o worker inteiro.
    child.stdin.on('error', () => {});
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
  const onSigint = (): void => {
    stop = true;
  };
  process.once('SIGINT', onSigint);

  try {
    do {
      // `activateJobs`/`completeJob`/`failJob` podem lançar (SQLITE_BUSY além
      // do timeout, banco fechado, ...). Em `--once` isso já voltaria como
      // rejeição da promessa de qualquer forma; em modo laço — a única razão
      // do laço existir — uma falha transitória do store não pode derrubar o
      // worker inteiro, só o que estava em andamento.
      let jobs: JobRecord[] = [];
      try {
        jobs = await runtime.activateJobs({
          type: options.type,
          worker,
          ...(options.count === undefined ? {} : { count: options.count }),
          ...(options.lease === undefined ? {} : { lease: options.lease }),
        });
      } catch (error) {
        lines.push(`${CROSS} ${errorMessage(error)}`);
      }

      for (const job of jobs) {
        try {
          const outcome = await runOnce(options.command, job);
          if (outcome.error) {
            await runtime.failJob(job.instanceId, job.tokenId, outcome.error, { worker });
            lines.push(`${CROSS} ${job.tokenId} — ${outcome.error.message}`);
          } else {
            await runtime.completeJob(job.instanceId, job.tokenId, outcome.output);
            lines.push(`${CHECK} ${job.tokenId} — ${job.nodeId}`);
          }
        } catch (error) {
          lines.push(`${CROSS} ${job.tokenId} — ${errorMessage(error)}`);
        }
      }
      if (options.once) break;
      if (jobs.length === 0) await sleep(options.interval ?? 1_000);
    } while (!stop);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  return {
    output: lines.length > 0 ? lines.join('\n') : 'Nenhum job pendente.',
    exitCode: 0,
  };
}
