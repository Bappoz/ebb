import { basename } from 'node:path';
import { executableProcess, parseBpmn, validateBpmn } from '@bpmn-flow/core';
import type { ValidationIssue } from '@bpmn-flow/core';
import { checksumOf, type Store } from '@ebb/store';
import { CHECK, CROSS, table, WARN } from './output.js';

/**
 * As implementações dos comandos, sem `process`, `argv` nem IO — cada uma
 * devolve o texto a imprimir e o código de saída, e por isso dá para testar
 * direto.
 */
export interface CommandResult {
  output: string;
  exitCode: number;
}

export interface DeployOptions {
  /** De onde o XML veio, só para o relatório. */
  source?: string;
  /** Publica mesmo com aviso de validação. Erro nunca passa. */
  force?: boolean;
}

/**
 * `ebb deploy <arquivo.bpmn>` — valida e publica uma definição.
 *
 * A validação é do `@bpmn-flow/core` e é levada a sério: erro barra a
 * publicação, porque um diagrama com referência pendurada não é um processo
 * que alguém vá querer instanciar em produção. Aviso barra também, e aí
 * `--force` é a maneira de dizer "eu sei".
 */
export async function deploy(
  store: Store,
  xml: string,
  options: DeployOptions = {},
): Promise<CommandResult> {
  const validation = await validateBpmn(xml);
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  const warnings = validation.issues.filter((issue) => issue.severity === 'warning');

  if (errors.length > 0) {
    return {
      output: [`${CROSS} ${errors.length} erro(s) — nada publicado`, ...issueLines(errors)].join(
        '\n',
      ),
      exitCode: 1,
    };
  }

  if (warnings.length > 0 && !options.force) {
    return {
      output: [
        `${CROSS} ${warnings.length} aviso(s) — nada publicado`,
        ...issueLines(warnings),
        '',
        'Publique mesmo assim com --force.',
      ].join('\n'),
      exitCode: 1,
    };
  }

  const model = await parseBpmn(xml);
  const executable = model.processes.filter((candidate) => candidate.isExecutable);
  if (executable.length > 1) {
    // Publicar um pool arbitrário e chamar de "o arquivo" é pior do que não
    // publicar: a instância rodaria metade do que está desenhado.
    const pools = executable.map((candidate) => candidate.name ?? candidate.id).join(', ');
    return {
      output: [
        `${CROSS} colaboração com ${executable.length} pools executáveis (${pools}) — nada publicado`,
        '',
        'Publicar colaboração ainda não existe: seria publicar um pool e ignorar o resto.',
        'Por enquanto, publique um pool por arquivo.',
      ].join('\n'),
      exitCode: 1,
    };
  }
  const process = executableProcess(model);
  const result = await store.deploy({
    processKey: process.id,
    xml,
    checksum: checksumOf(xml),
    ...(process.name ? { name: process.name } : {}),
    ...(options.source ? { source: basename(options.source) } : {}),
  });

  const { processKey, version, name } = result.deployment;
  const what = `${name ?? processKey} (${processKey}) v${version}`;
  const lines = result.created
    ? [`${CHECK} publicado: ${what}`]
    : [`${CHECK} sem mudança: ${what} já tem este conteúdo`];
  if (warnings.length > 0) {
    lines.push(`${WARN} publicado com ${warnings.length} aviso(s):`, ...issueLines(warnings));
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

/** `ebb ls` — o que está publicado, uma linha por processo. */
export async function list(store: Store): Promise<CommandResult> {
  const processes = await store.listProcesses();
  if (processes.length === 0) {
    return { output: 'Nada publicado. Comece com: ebb deploy <arquivo.bpmn>', exitCode: 0 };
  }

  const rows = processes.map((entry) => [
    entry.name ?? entry.processKey,
    entry.processKey,
    `v${entry.latestVersion}`,
    entry.versions === 1 ? '1 versão' : `${entry.versions} versões`,
    entry.deployedAt,
    entry.source ?? '',
  ]);
  return {
    output: table(['PROCESSO', 'CHAVE', 'ATUAL', 'HISTÓRICO', 'PUBLICADO', 'ORIGEM'], rows),
    exitCode: 0,
  };
}

/** `ebb versions <chave>` — o histórico de uma definição. */
export async function versions(store: Store, processKey: string): Promise<CommandResult> {
  const history = await store.versions(processKey);
  if (history.length === 0) {
    return { output: `${CROSS} nada publicado com a chave "${processKey}"`, exitCode: 1 };
  }
  const rows = history.map((entry) => [
    `v${entry.version}`,
    entry.deployedAt,
    entry.checksum.slice(0, 12),
    entry.source ?? '',
  ]);
  return { output: table(['VERSÃO', 'PUBLICADO', 'CONTEÚDO', 'ORIGEM'], rows), exitCode: 0 };
}

function issueLines(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => `  ${issue.severity === 'error' ? CROSS : WARN} ${issue.message}`);
}
