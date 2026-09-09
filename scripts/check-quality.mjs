#!/usr/bin/env node
/**
 * Quality floor guard (QYP2-001).
 *
 * Scans source and test files for forbidden patterns:
 * TypeScript suppressions, disabled lint rules, skipped/only tests,
 * empty catches, unimplemented stubs and permanent TODOs.
 *
 * Exit codes: 0 = floor held, 1 = violations found, 2 = usage error.
 *
 * Sanctioned self-test data is excluded via DEFAULT_IGNORES; removing an
 * entry there requires human approval (plan.md 16.7).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * scope meanings:
 * - 'prod':  only flagged inside src/ (production logic)
 * - 'tests': only flagged inside tests/
 * - 'all':   flagged everywhere (src/, tests/, scripts/)
 */
export const RULES = [
  {
    id: 'ts-ignore',
    scope: 'all',
    pattern: /@ts-ignore\b/,
    message: 'TypeScript suppression is forbidden (@ts-ignore)',
  },
  {
    id: 'ts-expect-error',
    scope: 'all',
    pattern: /@ts-expect-error\b/,
    message: 'TypeScript suppression is forbidden (@ts-expect-error)',
  },
  {
    id: 'eslint-disable',
    scope: 'all',
    pattern: /eslint-disable/,
    message: 'Disabling lint rules is forbidden (eslint-disable)',
  },
  {
    id: 'test-skip-only',
    scope: 'tests',
    pattern: /\.(skip|only|todo|fails)\s*\(/,
    message: 'Skipped/only/todo tests are forbidden (.skip/.only/.todo/.fails)',
  },
  {
    id: 'empty-catch',
    scope: 'all',
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    message: 'Empty catch blocks are forbidden',
  },
  {
    id: 'stub-not-implemented',
    scope: 'prod',
    pattern: /not\s+implemented|尚未实现|未实现/,
    message: 'Unimplemented stubs are forbidden in production code',
  },
  {
    id: 'permanent-todo',
    scope: 'prod',
    pattern: /\b(TODO|FIXME|XXX)\b/,
    message: 'Permanent TODO/FIXME markers are forbidden in production code',
  },
];

/**
 * Paths that legitimately contain violation-shaped text because they ARE the
 * guard or its test data. Anything added here is an audited exception.
 */
export const DEFAULT_IGNORES = [
  /scripts[\\/]check-quality\.mjs$/,
  /tests[\\/]quality[\\/]floor-guard\.test\.ts$/,
  /tests[\\/]fixtures[\\/]/,
];

function classify(absPath) {
  const parts = absPath.split(sep);
  if (parts.includes('tests')) return 'tests';
  if (parts.includes('src')) return 'prod';
  return 'other';
}

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return; // optional path (e.g. no scripts dir in a fixture tree)
    throw error;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (entry.isFile() && SCANNABLE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      files.push(fullPath);
    }
  }
}

function ruleAppliesTo(rule, absPath) {
  if (rule.scope === 'all') return true;
  return classify(absPath) === rule.scope;
}

/**
 * Scan the given roots and return { violations, filesScanned }.
 * Violations: { ruleId, file, line, message, snippet }.
 */
export function scanFiles(roots, options = {}) {
  const ignore = options.ignore ?? DEFAULT_IGNORES;
  const collected = [];
  for (const root of roots) walk(root, collected);

  const violations = [];
  let filesScanned = 0;
  for (const file of collected) {
    if (ignore.some((re) => re.test(file))) continue;
    filesScanned += 1;
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (const rule of RULES) {
      if (!ruleAppliesTo(rule, file)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (rule.pattern.test(lines[i])) {
          violations.push({
            ruleId: rule.id,
            file,
            line: i + 1,
            message: rule.message,
            snippet: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  }
  return { violations, filesScanned };
}

function printReport(violations) {
  for (const v of violations) {
    console.error(
      `[quality-floor] ${v.ruleId} :: ${v.file}:${v.line} :: ${v.message}\n` +
        `    ${v.snippet}`
    );
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).pop());
if (isMain) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) roots.push('src', 'tests', 'scripts');
  for (const root of roots) {
    if (!statSync(root, { throwIfNoEntry: false })) {
      console.error(`[quality-floor] path does not exist: ${root}`);
      process.exit(2);
    }
  }
  const { violations, filesScanned } = scanFiles(roots);
  if (violations.length > 0) {
    printReport(violations);
    console.error(`[quality-floor] FAILED: ${violations.length} violation(s) in ${filesScanned} files`);
    process.exit(1);
  }
  console.log(`[quality-floor] OK: ${filesScanned} files checked, quality floor held`);
}
