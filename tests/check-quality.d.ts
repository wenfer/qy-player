// Ambient types for the quality-floor checker, imported dynamically by
// tests/quality/floor-guard.test.ts. The implementation is plain .mjs; this
// declaration gives the import an explicit, typechecked contract.
declare module '*check-quality.mjs' {
  export interface QualityRule {
    id: string;
    scope: 'prod' | 'tests' | 'all';
    pattern: RegExp;
    message: string;
  }
  export interface QualityViolation {
    ruleId: string;
    file: string;
    line: number;
    message: string;
    snippet: string;
  }
  export interface ScanResult {
    violations: QualityViolation[];
    filesScanned: number;
  }
  export const RULES: QualityRule[];
  export const DEFAULT_IGNORES: RegExp[];
  export function scanFiles(
    roots: string[],
    options?: { ignore?: RegExp[] }
  ): ScanResult;
}
