/**
 * `--var chave=valor`, repetível.
 *
 * O valor é JSON quando parseia e texto quando não: `--var total=42` é número,
 * `--var nome=ana` é `"ana"`. Sem isso toda variável de processo chegaria como
 * string e toda condição numérica do diagrama ficaria falsa.
 */
export function parseVars(argv: string[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--var') continue;
    const pair = argv[index + 1];
    const split = pair === undefined ? -1 : pair.indexOf('=');
    if (pair === undefined || split <= 0) {
      throw new Error(`--var espera chave=valor e veio "${pair ?? ''}".`);
    }
    vars[pair.slice(0, split)] = parseValue(pair.slice(split + 1));
  }
  return vars;
}

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
