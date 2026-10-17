import { describe, expect, it } from 'vitest';
import { withClock } from '../src/clock.js';

describe('withClock', () => {
  it('avança por duração e por instante absoluto', () => {
    const clock = withClock('2026-01-01T00:00:00.000Z');

    clock.advanceBy(1_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');

    clock.advanceTo('2026-01-01T01:00:00.000Z');
    expect(clock.time).toBe(Date.parse('2026-01-01T01:00:00.000Z'));
  });

  it('recusa voltar no tempo ou receber uma duração inválida', () => {
    const clock = withClock(100);
    expect(() => clock.advanceTo(99)).toThrow('não pode voltar');
    expect(() => clock.advanceBy(-1)).toThrow('Duração inválida');
  });

  it('aceita Date e recusa um instante não finito', () => {
    const clock = withClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(() => withClock(Number.NaN)).toThrow('Instante inválido');
    expect(() => clock.advanceBy(Number.POSITIVE_INFINITY)).toThrow('Duração inválida');
  });
});
