import { describe, expect, it } from 'vitest';
import { CONTENT_POLICY_VERSION, scoreItem } from '../src/score';

const now = new Date('2026-10-31T12:00:00Z');
const base = {
  title: 'Agentic marketing platforms raise a funding round',
  excerpt: 'The martech vendor closed a series a and hired a new team.',
  publishedAt: new Date('2026-10-31T06:00:00Z'),
  authority: 3,
  category: 'publication' as const,
  now,
};

describe('content scoring', () => {
  it('is deterministic for the same input and policy version', () => {
    expect(scoreItem(base)).toEqual(scoreItem(base));
    expect(scoreItem(base).explanation.policyVersion).toBe(CONTENT_POLICY_VERSION);
  });

  it('explains every part of the score', () => {
    const result = scoreItem(base);
    const kinds = result.explanation.components.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(['keyword', 'authority', 'recency', 'category', 'section']));
    expect(result.explanation.total).toBe(result.score);
    expect(result.explanation.components.reduce((sum, c) => sum + c.points, 0)).toBe(result.score);
    expect(result.explanation.summary).toContain(`score ${result.score}`);
    expect(result.explanation.matchedKeywords).toEqual(expect.arrayContaining(['agentic', 'funding round', 'series a', 'martech']));
  });

  it('ranks a more authoritative source and a fresher item higher', () => {
    const low = scoreItem({ ...base, authority: 1 });
    const high = scoreItem({ ...base, authority: 5 });
    expect(high.score).toBeGreaterThan(low.score);
    expect(high.explanation.components.find((c) => c.kind === 'authority')?.detail).toBe('5 of 5');
    const stale = scoreItem({ ...base, publishedAt: new Date('2026-09-01T00:00:00Z') });
    expect(stale.score).toBeLessThan(scoreItem(base).score);
    expect(stale.explanation.components.find((c) => c.kind === 'recency')?.detail).toBe('older than 7 days');
  });

  it('assigns a section from the matching rules', () => {
    expect(scoreItem(base).section).toBe('Big moves');
    expect(
      scoreItem({ ...base, title: 'Open source martech tools to watch', excerpt: 'A github repository with a new license' }).section,
    ).toBe('Open source');
    expect(scoreItem({ ...base, title: 'A new AI agent launches in beta', excerpt: 'The assistant is now available' }).section).toBe(
      'Tools & launches',
    );
  });

  it('keeps a score without a date bounded and without a recency component', () => {
    const result = scoreItem({ ...base, publishedAt: null });
    expect(result.explanation.components.some((c) => c.kind === 'recency')).toBe(false);
    expect(result.score).toBeLessThan(scoreItem(base).score);
  });
});
