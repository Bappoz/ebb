export type ClockInstant = number | string | Date;

export interface TestClock {
  /** Instante atual em epoch milliseconds. */
  readonly time: number;
  /** Relógio compatível com `EbbRuntime` e `SqliteStore`. */
  now: () => Date;
  /** Avança para um instante absoluto. Relógio de processo nunca volta. */
  advanceTo: (instant: ClockInstant) => Date;
  /** Avança uma duração não negativa em milissegundos. */
  advanceBy: (milliseconds: number) => Date;
}

function millisecondsOf(instant: ClockInstant): number {
  const value =
    instant instanceof Date
      ? instant.getTime()
      : typeof instant === 'string'
        ? Date.parse(instant)
        : instant;
  if (!Number.isFinite(value)) throw new Error(`Instante inválido: ${String(instant)}.`);
  return value;
}

/** Cria um relógio determinístico, independente do relógio de parede. */
export function withClock(initial: ClockInstant = 0): TestClock {
  let current = millisecondsOf(initial);
  return {
    get time() {
      return current;
    },
    now: () => new Date(current),
    advanceTo: (instant) => {
      const next = millisecondsOf(instant);
      if (next < current) {
        throw new Error(
          `O relógio não pode voltar de ${new Date(current).toISOString()} para ${new Date(next).toISOString()}.`,
        );
      }
      current = next;
      return new Date(current);
    },
    advanceBy: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error(`Duração inválida: ${milliseconds}.`);
      }
      current += milliseconds;
      return new Date(current);
    },
  };
}
