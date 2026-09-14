import type { SQLOutputValue } from 'node:sqlite';

/**
 * Leitura de coluna com tipo.
 *
 * O `node:sqlite` devolve `Record<string, SQLOutputValue>`: cada célula pode
 * ser texto, número, `bigint`, `null` ou bytes. Converter a linha inteira com
 * `as` esconderia um desencontro de esquema até alguém tropeçar nele em
 * produção; estas funções falham na leitura, dizendo qual coluna veio errada.
 */
export type Row = Record<string, SQLOutputValue>;

function fail(column: string, value: SQLOutputValue, expected: string): never {
  throw new TypeError(`Coluna "${column}" deveria ser ${expected} e veio ${typeof value}.`);
}

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') fail(column, value ?? null, 'texto');
  return value;
}

export function optionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') fail(column, value, 'texto ou nulo');
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return fail(column, value ?? null, 'inteiro');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Coluna de texto que guarda um objeto JSON. O `JSON.parse` devolve `any`, e
 * aceitar isso seria o mesmo `as` que este módulo existe para evitar.
 */
export function jsonObject(row: Row, column: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text(row, column));
  if (!isRecord(parsed)) throw new TypeError(`Coluna "${column}" deveria ser um objeto JSON.`);
  return parsed;
}
