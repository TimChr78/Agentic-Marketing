import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Deferred, deferred, settle } from './keyedReadsSupport';

// #596: the alert history drawer belongs to the rule whose name is in its title. Opening rule B
// after rule A must not show A's episodes, or format them with B's units, while B loads.

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
  useSession: () => ({ can: () => false, user: { id: 'usr_ops' } }),
  useWorkspace: () => ({ can: () => false, user: { id: 'usr_ops' }, workspace: { id: 'ws_1' } }),
}));

import AlertsPage from '../src/pages/insights/AlertsPage';
import { ToastProvider } from '../src/ui/toast';

const RULE_A = `alr_${'a'.repeat(32)}`;
const RULE_B = `alr_${'b'.repeat(32)}`;

const rule = (id: string, name: string, kind: string, config: Record<string, unknown>) => ({
  id,
  name,
  kind,
  config,
  channels: [],
  enabled: true,
  createdBy: 'usr_ops',
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  state: 'ok',
  firingSince: null,
});

const event = (id: string, ruleId: string, ruleName: string, target: string, value: number) => ({
  id,
  ruleId,
  ruleName,
  state: 'firing',
  value,
  threshold: 0.05,
  window: 'PT1H',
  firedAt: '2026-11-05T09:00:00.000Z',
  resolvedAt: null,
  notified: [{ channel: 'slack', target, status: 'sent' }],
});

let ruleBHistory: Deferred<unknown>;

beforeEach(() => {
  h.calls.length = 0;
  ruleBHistory = deferred();
  h.impl = (name, input) => {
    if (name === 'alerts.list')
      return Promise.resolve({
        rules: [
          rule(RULE_A, 'Alpha deliverability', 'deliverability', { metric: 'bounce', threshold: 0.05, window: 'PT24H', minSent: 100 }),
          rule(RULE_B, 'Beta journey errors', 'journey_errors', { threshold: 5, window: 'PT1H' }),
        ],
      });
    if (name === 'webhooks.list') return Promise.resolve({ endpoints: [] });
    if (name === 'members.list') return Promise.resolve({ members: [] });
    if (name === 'artifacts.list') return Promise.resolve({ artifacts: [], total: 0, nextCursor: null });
    if (name === 'alerts.history') {
      if (input.ruleId === RULE_A)
        return Promise.resolve({ events: [event('evt_a', RULE_A, 'Alpha deliverability', '#alpha-only', 0.25)] });
      if (input.ruleId === RULE_B) return ruleBHistory.promise;
      return Promise.resolve({ events: [] });
    }
    throw new Error(`unexpected command ${name}`);
  };
});

afterEach(cleanup);

describe('alert history follows the rule in its title (#596)', () => {
  it("does not show the previous rule's episodes while the new rule's history loads", async () => {
    render(
      <ToastProvider>
        <AlertsPage />
      </ToastProvider>,
    );

    expect(await screen.findByText('Alpha deliverability')).toBeTruthy();
    const historyButtons = screen.getAllByRole('button', { name: 'History' });
    fireEvent.click(historyButtons[0]!);

    expect(await screen.findByText(/History · Alpha deliverability/)).toBeTruthy();
    expect(await screen.findByText(/#alpha-only/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getAllByRole('button', { name: 'History' })[1]!);
    expect(await screen.findByText(/History · Beta journey errors/)).toBeTruthy();

    // Beta's history is pending: Alpha's episode and its numbers must not sit under Beta's title.
    expect(screen.queryByText(/#alpha-only/)).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading history' })).toBeTruthy();

    await settle(ruleBHistory, { events: [event('evt_b', RULE_B, 'Beta journey errors', '#beta-only', 9)] });

    expect(await screen.findByText(/#beta-only/)).toBeTruthy();
    expect(screen.queryByText(/#alpha-only/)).toBeNull();
  });
});
