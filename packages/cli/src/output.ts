export const CHECK = '✓';
export const CROSS = '✗';
export const WARN = '!';

/** Tabela de largura fixa, alinhada pela coluna mais larga. */
export function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
