import { describe, expect, it } from 'vitest';

describe('main tests discovery (QYP2-001)', () => {
  it('runs in the node environment', () => {
    expect(typeof process.versions.node).toBe('string');
  });
});
