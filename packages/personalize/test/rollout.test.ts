import { artifactTypes } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { decideAll, type PublishedExperience } from '../src/core';
import { initialRollout, nextRolloutStep } from '../src/rollout';
import { type DecideContext, rampAdmits } from '../src/targeting';

// Progressive rollout (#427): a ramp admits a deterministic share of subjects, and widening it keeps
// everyone already admitted. The decision function is the same one the server and the edge worker run.

const EXPERIENCE = `exp_${'a'.repeat(32)}`;
const ctx: DecideContext = {
  personalized: true,
  snapshot: null,
  session: null,
  page: { url: 'https://shop.example.com/', path: '/', referrer: '' },
  utmSource: null,
  device: 'desktop',
};

const published = (share: number): PublishedExperience => ({
  id: EXPERIENCE,
  version: 1,
  share,
  def: artifactTypes.experience.content.parse({
    placement: 'hero',
    variants: [{ id: 'a', name: 'A', weight: 100, content: { html: '<h1>A</h1>' } }],
  }),
});

const admits = (share: number, id: string) => decideAll([published(share)], ['hero'], ctx, id).length === 1;

describe('experience ramp admission (#427)', () => {
  it('admits about 5% then 25% of subjects, and everyone at 100%', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `subject-${i}`);
    const at5 = ids.filter((id) => admits(5, id));
    const at25 = ids.filter((id) => admits(25, id));
    expect(at5.length / ids.length).toBeGreaterThan(0.035);
    expect(at5.length / ids.length).toBeLessThan(0.065);
    expect(at25.length / ids.length).toBeGreaterThan(0.23);
    expect(at25.length / ids.length).toBeLessThan(0.27);
    expect(ids.filter((id) => admits(100, id))).toHaveLength(ids.length);
    expect(ids.filter((id) => admits(0, id))).toHaveLength(0);
  });

  it('is sticky: a subject admitted at 5% stays admitted at 25%', () => {
    const ids = Array.from({ length: 5_000 }, (_, i) => `sticky-${i}`);
    const at5 = new Set(ids.filter((id) => admits(5, id)));
    for (const id of at5) expect(admits(25, id)).toBe(true);
    // The same subject always gets the same answer, on the server and at the edge.
    for (const id of ids.slice(0, 200)) expect(rampAdmits(EXPERIENCE, id, 25)).toBe(rampAdmits(EXPERIENCE, id, 25));
  });

  it('a ramp of 0 serves nobody and an empty subject is not admitted', () => {
    expect(rampAdmits(EXPERIENCE, 'someone', 0)).toBe(false);
    expect(rampAdmits(EXPERIENCE, '', 50)).toBe(false);
    expect(rampAdmits(EXPERIENCE, 'someone', 100)).toBe(true);
  });

  it('starts at the first step and advances to a complete 100% step', () => {
    const start = initialRollout({ steps: [5, 25, 100], stepHours: 2 }, new Date('2026-01-01T00:00:00Z'));
    expect(start).toMatchObject({ stepIndex: 0, share: 5, status: 'running' });
    expect(start.nextStepAt?.toISOString()).toBe('2026-01-01T02:00:00.000Z');
    const second = nextRolloutStep({ steps: [5, 25, 100], stepIndex: 0, stepHours: 2 }, new Date('2026-01-01T02:00:00Z'));
    expect(second).toMatchObject({ stepIndex: 1, share: 25, status: 'running' });
    const last = nextRolloutStep({ steps: [5, 25, 100], stepIndex: 1, stepHours: 2 }, new Date('2026-01-01T04:00:00Z'));
    expect(last).toMatchObject({ stepIndex: 2, share: 100, status: 'complete', nextStepAt: null });
    expect(nextRolloutStep({ steps: [5, 25, 100], stepIndex: 2, stepHours: 2 }, new Date())).toBeNull();
  });
});
