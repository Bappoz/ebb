import type { EbbRuntime, GatewayTrace } from '@ebb/runtime';
import type { Store } from '@ebb/store';
import type { CommandResult } from './commands.js';
import { pendingLines, withInstance } from './instances.js';
import { table } from './output.js';

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Uma linha por gateway: a condição de cada fluxo tomado e as variáveis que
 * decidiram. "Que decidiram" é heurística de exibição: identificadores que
 * aparecem nas condições e existem entre as variáveis. Quando nenhum casa,
 * mostra todas — errar para o lado de mostrar demais. Fica no CLI, nunca no
 * runtime, porque não é semântica do motor.
 */
export function gatewayLine(trace: GatewayTrace): string {
  const taken = trace.taken.map((flowId) => {
    const option = trace.options.find((candidate) => candidate.flowId === flowId);
    const why = option?.condition ? `"${option.condition}"` : 'default';
    return `${why} → ${flowId}`;
  });
  const cited = new Set(
    trace.options.flatMap((option) => option.condition?.match(IDENTIFIER) ?? []),
  );
  const relevant = Object.entries(trace.variables).filter(([key]) => cited.has(key));
  const shown = relevant.length > 0 ? relevant : Object.entries(trace.variables);
  const values = shown.map(([key, value]) => `${key}=${JSON.stringify(value) ?? 'undefined'}`);
  return `${trace.nodeId}: ${taken.join(', ')} (${values.join(', ')})`;
}

/** `ebb show <id> --at <seq>` — a instância como estava depois do passo `seq`. */
export async function showStep(
  store: Store,
  runtime: EbbRuntime,
  prefix: string,
  seq: number,
): Promise<CommandResult> {
  return withInstance(store, prefix, async (instance) => {
    const total = (await store.journal(instance.id)).length;
    // Um seq fora do intervalo vira ReplayRangeError, com o intervalo certo
    // na mensagem que o withInstance imprime.
    const { steps } = await runtime.replay(instance.id, seq);
    const step = steps.at(-1);
    if (!step) return { output: `nenhum passo ${seq}`, exitCode: 1 };

    const { type, ...payload } = step.command;
    const lines = [
      `passo ${step.seq} de ${total} — ${type} em ${new Date(step.at).toISOString()}`,
      JSON.stringify(payload),
      '',
      `${instance.id} — ${step.snapshot.status}`,
    ];

    const variables = Object.entries(step.snapshot.variables);
    if (variables.length > 0) {
      lines.push(
        '',
        table(
          ['VARIÁVEL', 'VALOR'],
          variables.map(([key, value]) => [key, JSON.stringify(value) ?? 'undefined']),
        ),
      );
    }

    const entered = step.entered.filter((entry) => entry.event === 'enter');
    if (entered.length > 0) {
      lines.push('', `entrou em: ${entered.map((entry) => entry.nodeId).join(', ')}`);
    }

    if (step.decisions.length > 0) {
      lines.push('', 'GATEWAY', ...step.decisions.map(gatewayLine));
    }

    const pending = pendingLines(step.tasks);
    if (pending.length > 0) lines.push('', ...pending);
    return { output: lines.join('\n'), exitCode: 0 };
  });
}
