import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Deferred, deferred, settle } from './keyedReadsSupport';

// #618: changing the AI-usage period or kind is a different question. The previous period's
// totals and the previous kind's calls must not stay under the new label while the read runs.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_ai' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'usr_ai' }, workspace: { id: 'ws_1' } }),
}));

import AiUsagePage from '../src/pages/insights/AiUsagePage';

const call = (id: string, kind: string, rationale: string) => ({
  id,
  kind,
  status: 'done',
  model: `model-${kind}`,
  promptId: null,
  promptVersion: null,
  journeyId: null,
  node: null,
  profileId: null,
  input: {},
  output: null,
  rationale,
  error: null,
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 12,
  cached: false,
  review: null,
  createdAt: '2026-11-05T10:00:00.000Z',
});

let usage7: Deferred<unknown>;
let generateCalls: Deferred<unknown>;

beforeEach(() => {
  h.calls.length = 0;
  usage7 = deferred();
  generateCalls = deferred();
  h.impl = (name, input) => {
    if (name === 'ai.usage') {
      if (input.days === 7) return usage7.promise;
      return Promise.resolve({
        days: [
          {
            day: '2026-11-05',
            kind: 'decide',
            model: 'model-a',
            calls: 31_234,
            fallbacks: 2,
            inputTokens: 10,
            outputTokens: 20,
            cost: null,
          },
        ],
      });
    }
    if (name === 'ai.calls') {
      if (input.kind === 'generate') return generateCalls.promise;
      return Promise.resolve({ calls: [call('call_a', 'decide', 'alpha-outcome-only')] });
    }
    if (name === 'ai.reviews') return Promise.resolve({ reviews: [], quality: [] });
    throw new Error(`unexpected command ${name}`);
  };
});

afterEach(cleanup);

describe('AI usage belongs to the selected period and kind (#618)', () => {
  it('clears the previous period totals and shows the usage skeleton while the new period loads', async () => {
    render(<AiUsagePage />);

    expect((await screen.findAllByText('31,234')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Last 30 days/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Period'), { target: { value: '7' } });

    await waitFor(() => expect(screen.queryAllByText('31,234')).toHaveLength(0));
    expect(screen.getByRole('status', { name: 'AI calls' })).toBeTruthy();

    await settle(usage7, {
      days: [
        { day: '2026-11-05', kind: 'decide', model: 'model-a', calls: 7_123, fallbacks: 0, inputTokens: 3, outputTokens: 4, cost: null },
      ],
    });

    expect((await screen.findAllByText('7,123')).length).toBeGreaterThan(0);
    expect(screen.queryAllByText('31,234')).toHaveLength(0);
    expect(screen.getAllByText(/Last 7 days/).length).toBeGreaterThan(0);
  });

  it('clears the previous kind rows and shows the list skeleton while the new filter loads', async () => {
    render(<AiUsagePage />);

    expect(await screen.findByText('alpha-outcome-only')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter by kind'), { target: { value: 'generate' } });

    await waitFor(() => expect(screen.queryByText('alpha-outcome-only')).toBeNull());
    expect(screen.getByRole('status', { name: 'Loading list' })).toBeTruthy();

    await settle(generateCalls, { calls: [call('call_b', 'generate', 'beta-outcome-only')] });

    expect(await screen.findByText('beta-outcome-only')).toBeTruthy();
    expect(screen.queryByText('alpha-outcome-only')).toBeNull();
  });
});
