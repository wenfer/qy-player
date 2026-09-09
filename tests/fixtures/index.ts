import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Minimal, offline fixtures for phase-2 quality tests (QYP2-001).
 *
 * Contains violation-shaped text BY DESIGN; scripts/check-quality.mjs ignores
 * this directory. Never import this module from production code.
 */

export interface SampleFile {
  /** Path relative to the sample tree root; use src/… or tests/… to steer rule scope. */
  path: string;
  content: string;
  /** Rule id expected to flag this sample. */
  ruleId: string;
}

/** One sample per forbidden pattern; each must fail the floor guard. */
export const VIOLATION_SAMPLES: SampleFile[] = [
  {
    path: 'src/ts-ignore.ts',
    content: 'const value: number = maybe(); // @ts-ignore\nexport { value };\n',
    ruleId: 'ts-ignore',
  },
  {
    path: 'src/ts-expect-error.ts',
    content: '// @ts-expect-error\nconst bad = maybe();\nexport { bad };\n',
    ruleId: 'ts-expect-error',
  },
  {
    path: 'src/eslint-disable.ts',
    content: '// eslint-disable-next-line no-console\nconsole.log("x");\n',
    ruleId: 'eslint-disable',
  },
  {
    path: 'src/stub.ts',
    content: 'export function later(): never {\n  throw new Error("not implemented");\n}\n',
    ruleId: 'stub-not-implemented',
  },
  {
    path: 'src/todo.ts',
    content: '// TODO: remove this\nexport const placeholder = 1;\n',
    ruleId: 'permanent-todo',
  },
  {
    path: 'tests/skipped.test.ts',
    content: 'import { test } from "vitest";\ntest.skip("skipped on purpose", () => {});\n',
    ruleId: 'test-skip-only',
  },
  {
    path: 'tests/only.test.ts',
    content: 'import { test } from "vitest";\ntest.only("focus on purpose", () => {});\n',
    ruleId: 'test-skip-only',
  },
  {
    path: 'src/empty-catch.ts',
    content: 'try {\n  JSON.parse("{");\n} catch (error) {}\n',
    ruleId: 'empty-catch',
  },
];

/** Samples that must NOT trigger any rule. */
export const CLEAN_SAMPLES: SampleFile[] = [
  {
    path: 'src/clean.ts',
    content: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    ruleId: '',
  },
  {
    path: 'src/real-catch.ts',
    content: 'try {\n  JSON.parse("{");\n} catch (error) {\n  console.error("parse failed", error);\n}\n',
    ruleId: '',
  },
  {
    path: 'tests/clean.test.ts',
    content: 'import { expect, test } from "vitest";\ntest("runs", () => {\n  expect(1 + 1).toBe(2);\n});\n',
    ruleId: '',
  },
];

/** Create an isolated temp tree with the given samples; returns its root. */
export function createSampleTree(samples: SampleFile[]): string {
  const root = mkdtempSync(join(tmpdir(), 'qy-quality-'));
  try {
    for (const sample of samples) {
      const abs = join(root, sample.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, sample.content, 'utf-8');
    }
  } catch (error) {
    // Never leak a half-written tree when a sample path is malformed.
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

/** Remove a tree created by createSampleTree (test cleanup). */
export function removeSampleTree(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
