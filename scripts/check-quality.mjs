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
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * scope meanings:
 * - 'prod':  only flagged in production trees (files under a src/ root)
 * - 'tests': only flagged in test trees (files under a tests/ root)
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
    // Scoped to vitest/jest receivers so unrelated `.skip(1)`-style calls
    // (e.g. queue.skip(1)) do not produce false positives.
    pattern: /\b(?:describe|it|test|suite|beforeEach|afterEach|beforeAll|afterAll)\.(?:skip|only|todo|fails)\b|\b(?:xit|fit|xdescribe|fdescribe)\b/,
    message: 'Skipped/only/todo tests are forbidden (describe/it/test .skip/.only/.todo/.fails)',
  },
  {
    id: 'empty-catch',
    scope: 'all',
    // \s spans newlines, so multi-line empty catches are detected.
    pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    message: 'Empty catch blocks are forbidden',
  },
  {
    id: 'stub-not-implemented',
    scope: 'prod',
    // Only flagged in throw statements to avoid false positives on
    // descriptive string content elsewhere.
    pattern: /throw\b[^\n]*\bnot\s+implemented\b|throw\b[^\n]*(?:尚未实现|未实现)/i,
    message: 'Unimplemented stubs are forbidden in production code',
  },
  {
    id: 'permanent-todo',
    scope: 'prod',
    // Only TODO markers inside comments (// /* or JSDoc * continuation);
    // identifiers like TODO_LIST do not trigger.
    pattern: /(?:\/\/|\/\*|\*)\s*[^\n]*?\b(?:TODO|FIXME|XXX)\b/,
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

/**
 * Classify by the FIRST path segment relative to the scanned root, so nested
 * directories cannot flip the domain (src/tests/x.ts stays prod, and
 * tests/fixtures/src/x.ts stays tests).
 */
function classify(root, file) {
  const rel = relative(root, file);
  const firstSegment = rel.split(sep)[0];
  if (firstSegment === 'tests') return 'tests';
  if (firstSegment === 'src') return 'prod';
  return 'other';
}

function walk(dir, files, root) {
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
      walk(fullPath, files, root);
    } else if (entry.isFile() && SCANNABLE_EXTENSIONS.has(extname(entry.name))) {
      files.push({ file: fullPath, root });
    }
  }
}

function lineAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

function ruleAppliesTo(rule, domain) {
  if (rule.scope === 'all') return true;
  return domain === rule.scope;
}

/**
 * Scan the given roots and return { violations, filesScanned }.
 * Violations: { ruleId, file, line, message, snippet }.
 */
export function scanFiles(roots, options = {}) {
  const ignore = options.ignore ?? DEFAULT_IGNORES;
  const collected = [];
  for (const root of roots) walk(root, collected, resolve(root));

  const violations = [];
  const seenFiles = new Set();
  for (const { file, root } of collected) {
    if (ignore.some((re) => re.test(file))) continue;
    seenFiles.add(file);
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const domain = classify(root, file);
    for (const rule of RULES) {
      if (!ruleAppliesTo(rule, domain)) continue;
      // Preserve original flags (e.g. i) in addition to global matching.
      const global = new RegExp(rule.pattern.source, 'g' + rule.pattern.flags.replace(/g/g, ''));
      let match;
      while ((match = global.exec(content)) !== null) {
        const line = lineAt(content, match.index);
        violations.push({
          ruleId: rule.id,
          file,
          line,
          message: rule.message,
          snippet: (lines[line - 1] ?? '').trim().slice(0, 120),
        });
        if (match.index === global.lastIndex) global.lastIndex += 1; // guard against zero-length loops
      }
    }
  }
  return { violations, filesScanned: seenFiles.size };
}

function printReport(violations) {
  for (const v of violations) {
    console.error(
      `[quality-floor] ${v.ruleId} :: ${v.file}:${v.line} :: ${v.message}\n` +
        `    ${v.snippet}`
    );
  }
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (thisFile === invokedFile) {
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
