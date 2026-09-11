import type { MetadataCandidate } from '../../../shared/types/plugins';

/**
 * Candidate matching/scoring (QYP2-028, plan §11.2).
 *
 * Movies score on title + original title + year proximity; series resolve
 * the series first, then map season/episode numbers (the caller passes the
 * series query and applies season/episode mapping downstream).
 *
 * Thresholds (§11.2): a UNIQUE candidate ≥0.92 auto-applies; 0.75–0.92
 * goes to the manual confirmation queue; <0.75 is rejected outright.
 */

export const AUTO_APPLY_THRESHOLD = 0.92;
export const CONFIRM_THRESHOLD = 0.75;

/** Normalize for comparison: lowercase, NFKC, strip punctuation/whitespace. */
function normalizeTitle(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

/** Length-normalized Levenshtein similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  // Classic DP with two rows; fine for title-length strings.
  let prev = new Array<number>(nb.length + 1);
  let curr = new Array<number>(nb.length + 1);
  for (let j = 0; j <= nb.length; j += 1) prev[j] = j;
  for (let i = 1; i <= na.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= nb.length; j += 1) {
      const cost = na[i - 1] === nb[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return 1 - prev[nb.length] / Math.max(na.length, nb.length);
}

/** Year proximity in [0, 1]: exact = 1, ±1 = 0.9, ≥3 away = 0. */
function yearScore(queryYear: number | undefined, candidateYear: number | undefined): number {
  if (queryYear === undefined || candidateYear === undefined) return 0.5; // neutral
  const diff = Math.abs(queryYear - candidateYear);
  if (diff === 0) return 1;
  if (diff === 1) return 0.9;
  if (diff === 2) return 0.6;
  return 0;
}

export interface QueryInfo {
  title: string;
  originalTitle?: string;
  year?: number;
}

/**
 * Score one candidate: best of (query.title, query.originalTitle) against
 * both candidate titles. When both sides carry a year, the score is
 * 70% title + 30% year proximity; an unverifiable year (only one side
 * known) caps the score below the auto-apply threshold so confidence
 * always reflects actual evidence.
 */
export function scoreCandidate(query: QueryInfo, candidate: MetadataCandidate): number {
  const titleSimilarity = Math.max(
    similarity(query.title, candidate.title),
    query.originalTitle ? similarity(query.originalTitle, candidate.title) : 0,
    similarity(query.title, candidate.originalTitle ?? candidate.title),
    query.originalTitle && candidate.originalTitle
      ? similarity(query.originalTitle, candidate.originalTitle)
      : 0
  );
  const queryHasYear = query.year !== undefined;
  const candidateHasYear = candidate.year !== undefined;
  if (queryHasYear !== candidateHasYear) {
    // The year cross-check is impossible: cap below auto-apply.
    return Math.min(titleSimilarity, 0.9);
  }
  if (!queryHasYear) return titleSimilarity;
  return titleSimilarity * 0.7 + yearScore(query.year, candidate.year) * 0.3;
}

export type MatchVerdict = 'auto' | 'confirm' | 'rejected';

export interface MatchResult {
  verdict: MatchVerdict;
  /** The auto-apply candidate when verdict === 'auto' (unique ≥0.92). */
  autoCandidate?: MetadataCandidate;
  /** All candidates in the confirmation band when verdict === 'confirm'. */
  confirmCandidates: MetadataCandidate[];
  scored: Array<{ candidate: MetadataCandidate; score: number }>;
}

/**
 * Verdict per §11.2. Exactly one candidate at ≥0.92 → auto; zero → the
 * confirm band (if any candidates ≥0.75); multiple ≥0.92 → ambiguous, the
 * user must pick (confirm) — auto-applying an ambiguous match is exactly
 * the mistake this rule exists to prevent.
 */
export function matchCandidates(query: QueryInfo, candidates: MetadataCandidate[]): MatchResult {
  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(query, candidate) }))
    .sort((a, b) => b.score - a.score);
  const strong = scored.filter((entry) => entry.score >= AUTO_APPLY_THRESHOLD);
  if (strong.length === 1) {
    return { verdict: 'auto', autoCandidate: strong[0].candidate, confirmCandidates: [], scored };
  }
  const confirmBand = scored.filter((entry) => entry.score >= CONFIRM_THRESHOLD);
  if (confirmBand.length > 0) {
    return { verdict: 'confirm', confirmCandidates: confirmBand.map((entry) => entry.candidate), scored };
  }
  return { verdict: 'rejected', confirmCandidates: [], scored };
}
