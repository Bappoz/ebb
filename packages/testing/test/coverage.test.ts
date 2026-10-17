import { describe, expect, it } from 'vitest';
import { formatCoverage, processCoverage } from '../src/coverage.js';

const FLOWS = [
  { id: 'a', sourceRef: 'A', targetRef: 'B', scopeId: 'P' },
  { id: 'b', sourceRef: 'B', targetRef: 'C', scopeId: 'P' },
  { id: 'c', sourceRef: 'C', targetRef: 'D', scopeId: 'P' },
];

describe('relatório de cobertura', () => {
  it('um processo sem fluxos está integralmente coberto', () => {
    expect(processCoverage([], new Set())).toMatchObject({
      total: 0,
      covered: 0,
      percentage: 100,
      missing: [],
    });
  });

  it('formata percentual fracionário e os fluxos ausentes', () => {
    const report = processCoverage(FLOWS, new Set(['a']));
    expect(formatCoverage(report)).toContain('1/3 fluxos (33.3%)');
    expect(formatCoverage(report)).toContain('b: B → C (P)');
  });

  it('resume cobertura completa em uma linha', () => {
    const report = processCoverage(FLOWS, new Set(['a', 'b', 'c']));
    expect(formatCoverage(report)).toBe('3/3 fluxos (100%)');
  });
});
