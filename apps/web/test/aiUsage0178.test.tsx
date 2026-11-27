import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1255: the kind filter lacked `score`, although the server records and filters it.
// #1259: a decision-log row opened on mouse click only; it was not reachable by keyboard.
// #1260: kinds and statuses were printed as raw API keys instead of the words people read.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({ can: () => true, user: { id: 'usr_ai' }, workspace: { id: 'ws_1' } });
  return { useSession: session, useWorkspace: session };
});

import AiUsagePage from '../src/pages/insights/AiUsagePage';

const aiCall = (overrides: Record<string, unknown> = {}) => ({
  id: 'aic_1',
  kind: 'decide',
  status: 'done',
  model: 'model-a',
  promptId: null,
  promptVersion: null,
  journeyId: null,
  node: null,
  profileId: null,
  input: { seen: 'by the model' },
  output: 'took path a',
  rationale: null,
  error: null,
  inputTokens: 1,
  outputTokens: 1,
  latencyMs: 10,
  cached: false,
  review: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  ...overrides,
});

const install = (calls: Record<string, unknown>[]) => {
  h.impl = async (name) => {
    if (name === 'ai.usage')
      return {
        days: [
          {
            day: '2026-11-10',
            kind: 'decide',
            model: 'model-a',
            calls: 3,
            fallbacks: 0,
            inputTokens: 10,
            outputTokens: 20,
            cost: 0.01,
          },
        ],
      };
    if (name === 'ai.calls') return { calls };
    if (name === 'ai.reviews') return { reviews: [], quality: [] };
    throw new Error(`unexpected ${name}`);
  };
};

beforeEach(() => {
  h.impl = null;
});

afterEach(cleanup);

describe('AI usage kind filter (#1255)', () => {
  it('offers the server’s score kind as well', async () => {
    install([]);
    render(<AiUsagePage />);
    const select = await screen.findByLabelText('Filter by kind');
    const values = within(select)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['', 'decide', 'generate', 'copilot', 'test', 'classify', 'check', 'hosted', 'score']);
  });
});

describe('AI usage labels (#1260)', () => {
  it('names kinds and statuses in words instead of printing the API keys', async () => {
    install([aiCall({ kind: 'score', status: 'done' })]);
    render(<AiUsagePage />);

    const table = await screen.findByRole('table', { name: 'AI decision log' });
    await within(table).findByText('Scoring');
    expect(within(table).getByText('Done')).toBeTruthy();
    // The usage-by-kind table and the picker share the labels.
    expect((await screen.findAllByText('Journey decision')).length).toBeGreaterThan(0);

    expect(document.body.textContent).not.toContain('score');
    expect(document.body.textContent).not.toContain('decide');
    expect(document.body.textContent).not.toContain('done');
  });
});

describe('AI usage decision log by keyboard (#1259)', () => {
  it('opens the call detail from a focusable control with Enter', async () => {
    install([aiCall()]);
    render(<AiUsagePage />);

    const table = await screen.findByRole('table', { name: 'AI decision log' });
    const row = within(table).getByText('Done').closest('tr') as HTMLElement;
    const open = within(row).getByRole('button', { name: /view detail/i });

    open.focus();
    expect(document.activeElement).toBe(open);
    await userEvent.keyboard('{Enter}');

    expect(await screen.findByText('Call detail')).toBeTruthy();
    expect(
      within(row)
        .getByRole('button', { name: /hide detail/i })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    await waitFor(() => expect(screen.queryByRole('button', { name: /view detail/i })).toBeNull());
  });
});
