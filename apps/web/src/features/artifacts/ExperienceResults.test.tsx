import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from './ArtifactDetailPage';
import { ExperienceResults } from './ExperienceResults';

// The results screen describes what the server measured (#759): its `version` and the analysis
// config of that version, never the artifact row's draft version or the draft's alpha/threshold.

const h = vi.hoisted(() => ({ results: null as unknown }));

vi.mock('../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'experiences.results') return h.results;
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

/** The published version is v2; a draft v3 with its own, different analysis config is open. */
const artifact = {
  id: `exp_${'a'.repeat(32)}`,
  name: 'Gold hero',
  type: 'experience',
  publishedVersion: 2,
  latestVersion: 3,
  version: {
    number: 3,
    state: 'draft',
    content: {
      placement: 'home_hero',
      variants: [{ id: 'a', name: 'Plain', weight: 100, content: { html: '<h1>Plain</h1>' } }],
      analysis: { method: 'sequential', alpha: 0.01, threshold: 0.99 },
    },
  },
} as unknown as Artifact;

const results = {
  version: 2,
  goal: 'Order Completed',
  control: 'a',
  k: 5,
  suppressed: false,
  variants: [
    {
      variant: 'a',
      suppressed: false,
      exposed: 100,
      converted: 10,
      rate: 0.1,
      lift: null,
      pValue: null,
      ci95: null,
      sequentialP: null,
      probBeatControl: null,
      probBest: 0.4,
      expectedLoss: 0,
    },
    {
      variant: 'b',
      suppressed: false,
      exposed: 100,
      converted: 15,
      rate: 0.15,
      lift: 0.5,
      pValue: 0.2,
      ci95: [0.01, 0.09],
      sequentialP: 0.2,
      probBeatControl: 0.6,
      probBest: 0.6,
      expectedLoss: 0.01,
    },
  ],
  method: 'sequential',
  analysis: { method: 'sequential', alpha: 0.05, threshold: 0.95 },
  recommendation: 'Keep the experiment running.',
  note: 'Sequential p-values may be checked at any time.',
};

const text = () => document.body.textContent ?? '';

describe('experience results view (#759)', () => {
  beforeEach(() => {
    h.results = results;
  });

  it('shows the version the server measured and the analysis config of that version', async () => {
    render(<ExperienceResults artifact={artifact} />);
    await waitFor(() => expect(text()).toContain('Keep the experiment running.'));

    // v2 is what the numbers describe, even though the open draft is v3.
    expect(text()).toContain('results use v2');
    expect(text()).not.toContain('results use v3');

    // The caption quotes the analysis of v2 (alpha 0.05), not the draft's 0.01.
    expect(text()).toContain('falls below 0.05');
    expect(text()).not.toContain('falls below 0.01');
  });

  it('says plainly when the server has no ties to the open draft', async () => {
    h.results = { ...results, version: 3, analysis: { method: 'sequential', alpha: 0.01, threshold: 0.99 } };
    render(<ExperienceResults artifact={artifact} />);
    await waitFor(() => expect(text()).toContain('Keep the experiment running.'));

    expect(text()).toContain('results use v3');
    expect(text()).toContain('falls below 0.01');
    expect(screen.getByRole('table', { name: 'Experiment results' })).toBeTruthy();
  });

  it('shows a suppressed variant and withholds its comparisons and P(best) (#828)', async () => {
    h.results = {
      ...results,
      k: 5,
      suppressed: true,
      variants: [
        { ...results.variants[0], probBest: null, expectedLoss: null },
        {
          ...results.variants[1],
          suppressed: true,
          exposed: null,
          converted: null,
          rate: null,
          lift: null,
          pValue: null,
          ci95: null,
          sequentialP: null,
          probBeatControl: null,
          probBest: null,
          expectedLoss: null,
        },
      ],
      recommendation:
        'Not enough data to compare: a variant has fewer than k=5 exposed visitors, so its counts and every comparison that needs it are withheld.',
      note: 'Sequential p-values may be checked at any time. A variant has fewer than k=5 exposed visitors, so its counts, rates and every comparison that needs it are withheld.',
    };
    render(<ExperienceResults artifact={artifact} />);
    await waitFor(() => expect(text()).toContain('Some results are suppressed'));

    // The tag and the caption both name the floor; the small arm's row says Suppressed instead of
    // printing its counts, and no comparison or P(best) figure survives.
    expect(text()).toContain('k=5 suppressed');
    expect(text()).toContain('Fewer than k=5 visitors were exposed');
    expect(screen.getAllByText('Suppressed').length).toBeGreaterThanOrEqual(3);
    expect(text()).toContain('fewer than k=5 exposed visitors');
    expect(text()).toContain('P(best)');
    expect(text()).toContain('—');
  });
});
