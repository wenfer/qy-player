import { afterAll, describe, expect, it } from 'vitest';
import { CLEAN_SAMPLES, VIOLATION_SAMPLES, createSampleTree, removeSampleTree } from '../fixtures';
import type { SampleFile } from '../fixtures';

// The checker is plain .mjs; import dynamically so TS needs no module declaration.
const { DEFAULT_IGNORES, RULES, scanFiles } = await import('../../scripts/check-quality.mjs');
type ScanResult = { violations: Array<{ ruleId: string; file: string; line: number }>; filesScanned: number };

const trees: string[] = [];
afterAll(() => {
  for (const root of trees) removeSampleTree(root);
});

function scanSamples(samples: SampleFile[]): ScanResult {
  const root = createSampleTree(samples);
  trees.push(root);
  return scanFiles([root]) as unknown as ScanResult;
}

describe('quality floor guard (check-quality.mjs)', () => {
  it('declares rules for every forbidden category', () => {
    const ids = RULES.map((r: { id: string }) => r.id);
    for (const required of [
      'ts-ignore',
      'ts-expect-error',
      'eslint-disable',
      'test-skip-only',
      'empty-catch',
      'stub-not-implemented',
      'permanent-todo',
    ]) {
      expect(ids).toContain(required);
    }
  });

  it('passes on clean code', () => {
    const { violations, filesScanned } = scanSamples(CLEAN_SAMPLES);
    expect(violations).toEqual([]);
    expect(filesScanned).toBe(CLEAN_SAMPLES.length);
  });

  for (const sample of VIOLATION_SAMPLES) {
    it(`detects ${sample.ruleId} (${sample.path})`, () => {
      const { violations } = scanSamples([sample]);
      const hit = violations.find((v) => v.ruleId === sample.ruleId);
      expect(hit, `expected rule ${sample.ruleId} to fire`).toBeTruthy();
      expect(hit?.line).toBeGreaterThan(0);
    });
  }

  it('reports the violating line, not just the file', () => {
    const { violations } = scanSamples([VIOLATION_SAMPLES[0]]);
    expect(violations[0].line).toBe(1);
  });

  it('honors the ignore list', () => {
    const root = createSampleTree(VIOLATION_SAMPLES);
    trees.push(root);
    const all = scanFiles([root], { ignore: [] }) as unknown as ScanResult;
    const ignored = scanFiles([root], {
      ignore: [...DEFAULT_IGNORES, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)],
    }) as unknown as ScanResult;
    expect(all.violations.length).toBeGreaterThan(0);
    expect(ignored.violations).toEqual([]);
  });

  it('scope: prod rules do not fire inside tests/ and vice versa', () => {
    const { violations } = scanSamples([
      VIOLATION_SAMPLES.find((s) => s.ruleId === 'permanent-todo')!, // src only
      {
        path: 'tests/todo-marker.ts',
        content: '// TODO: allowed in tests, e.g. pending fixtures\nexport {};\n',
        ruleId: '',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toContain('src');
  });

  it('scope: skip rules only apply to tests', () => {
    const { violations } = scanSamples([
      {
        path: 'src/only.ts',
        content: 'export const only = (x: number) => x + 1;\n',
        ruleId: '',
      },
    ]);
    expect(violations).toEqual([]);
  });
});
