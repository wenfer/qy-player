import { afterAll, describe, expect, it } from 'vitest';
import { CLEAN_SAMPLES, VIOLATION_SAMPLES, createSampleTree, removeSampleTree } from '../fixtures';
import type { SampleFile } from '../fixtures';

// The checker is plain .mjs; import dynamically so TS needs no module declaration.
const { DEFAULT_IGNORES, RULES, scanFiles } = await import('../../scripts/check-quality.mjs');

interface Violation {
  ruleId: string;
  file: string;
  line: number;
  message: string;
  snippet: string;
}
interface ScanResult {
  violations: Violation[];
  filesScanned: number;
}

type ScanOptions = { ignore?: RegExp[] };
const runScan = (roots: string[], options?: ScanOptions): ScanResult =>
  scanFiles(roots, options) as ScanResult;

const trees: string[] = [];
afterAll(() => {
  for (const root of trees) removeSampleTree(root);
});

function scanSamples(samples: SampleFile[]): ScanResult {
  const root = createSampleTree(samples);
  trees.push(root);
  return runScan([root]);
}

function violationFor(samples: SampleFile[]): Violation[] {
  return scanSamples(samples).violations;
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
      const violations = violationFor([sample]);
      const hit = violations.find((v) => v.ruleId === sample.ruleId);
      expect(hit, `expected rule ${sample.ruleId} to fire`).toBeTruthy();
      expect(hit?.line).toBeGreaterThan(0);
    });
  }

  it('reports the violating line, not just the file', () => {
    const violations = violationFor([VIOLATION_SAMPLES[0]]);
    expect(violations[0].line).toBe(1);
  });

  it('detects multi-line empty catches', () => {
    const violations = violationFor([
      {
        path: 'src/empty-catch-multiline.ts',
        content: 'try {\n  JSON.parse("{");\n} catch (error) {\n}\n',
        ruleId: 'empty-catch',
      },
    ]);
    expect(violations.map((v) => v.ruleId)).toContain('empty-catch');
    expect(violations.find((v) => v.ruleId === 'empty-catch')?.line).toBe(3);
  });

  it('classifies by the first segment relative to the scanned root', () => {
    // src/tests/... stays prod: TODO marker must be flagged
    const flagged = violationFor([
      { path: 'src/tests/todo.ts', content: '// TODO: nested in src\nexport const x = 1;\n', ruleId: 'permanent-todo' },
    ]);
    expect(flagged.map((v) => v.ruleId)).toContain('permanent-todo');

    // tests/src/... stays tests: prod-only rules must stay silent
    const silent = violationFor([
      { path: 'tests/src/todo.ts', content: '// TODO: allowed in tests, e.g. pending fixtures\nexport const y = 2;\n', ruleId: '' },
    ]);
    expect(silent).toEqual([]);
  });

  it('does not flag identifier-shaped TODOs or non-test .skip calls', () => {
    const violations = violationFor([
      { path: 'src/negatives.ts', content: 'export const TODO_LIST: string[] = [];\nexport function chunk(items: string[], skip: number) {\n  return items.slice(skip);\n}\n', ruleId: '' },
    ]);
    expect(violations).toEqual([]);
  });

  it('honors the ignore list', () => {
    const root = createSampleTree(VIOLATION_SAMPLES);
    trees.push(root);
    const all = runScan([root], { ignore: [] });
    const anchoredIgnore = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const ignored = runScan([root], { ignore: [...DEFAULT_IGNORES, anchoredIgnore] });
    expect(all.violations.length).toBeGreaterThan(0);
    expect(ignored.violations).toEqual([]);
  });

  it('scope: skip rules only apply to tests', () => {
    const violations = violationFor([
      {
        path: 'src/only.ts',
        content: 'export const only = (x: number) => x + 1;\n',
        ruleId: '',
      },
    ]);
    expect(violations).toEqual([]);
  });
});
