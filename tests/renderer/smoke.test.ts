// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

describe('renderer tests discovery (QYP2-001)', () => {
  it('has a DOM environment available', () => {
    expect(document.body).toBeTruthy();
  });
});
