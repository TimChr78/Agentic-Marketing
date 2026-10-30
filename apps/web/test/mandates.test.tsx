import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Autonomy } from '../src/features/agents/labels';
import { formatHoldCountdown, holdCountdownText } from '../src/features/approvals/holds';
import { type MandateContent, MandateEditor, percentToFraction } from '../src/features/artifacts/MandateEditor';

const autonomy: Autonomy = {
  switch: 'on',
  maxLevel: { 'send.broadcast': 2, 'content.publish': 0 },
  allowLoops: false,
  audienceThreshold: 1000,
  limits: { changesPerDay: 500, messagesPerDay: 1000 },
};

vi.mock('../src/app/api', () => ({
  api: {
    call: vi.fn(async (name: string) => {
      switch (name) {
        case 'agents.list':
          return { agents: [] };
        case 'artifacts.list':
          return { artifacts: [] };
        case 'purposes.list':
          return { source: 'default', purposes: [] };
        case 'members.list':
          return { members: [] };
        case 'workspace.autonomy':
          return {
            switch: 'on',
            maxLevel: {},
            allowLoops: false,
            audienceThreshold: 1000,
            limits: { changesPerDay: 500, messagesPerDay: 1000 },
          };
        default:
          return {};
      }
    }),
  },
  errText: (e: unknown) => String(e),
}));

afterEach(cleanup);

const content: MandateContent = {
  agent: `agt_${'0'.repeat(32)}`,
  purpose: 'Send the weekly newsletter.',
  scope: {
    segments: [],
    purposes: [],
    topics: [],
    channels: ['email'],
    artifactTypes: [],
    artifacts: [],
    brand: null,
  },
  levels: {},
  limits: {},
  guardrails: { window: 'P7D', minSent: 100 },
  validUntil: '2027-01-01T00:00:00.000Z',
  blackoutDates: [],
  holdWindow: 'PT2H',
  escalation: { userIds: [] },
  independentCheck: false,
};

describe('mandate editor (#228)', () => {
  it('caps each action class at the workspace ceiling and keeps level 4 for a later release', () => {
    render(
      <MandateEditor
        artifact={{} as never}
        content={content}
        onChange={vi.fn()}
        readOnly={false}
        errors={{}}
        warnings={[]}
        autonomy={autonomy}
      />,
    );

    expect(screen.getByRole('radio', { name: /^Broadcast sends: Act with veto/ })).toHaveProperty('disabled', false);
    expect(screen.getByRole('radio', { name: /^Broadcast sends: Act within limits/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('radio', { name: /^Broadcast sends: Run the loop/ })).toHaveProperty('disabled', true);

    expect(screen.getByRole('radio', { name: /^Content publishing: Observe/ })).toHaveProperty('disabled', false);
    expect(screen.getByRole('radio', { name: /^Content publishing: Propose/ })).toHaveProperty('disabled', true);

    expect(screen.getAllByText(/Ceiling: Act with veto \(2\)/).length).toBe(1);
    expect(screen.getByRole('radiogroup', { name: 'Broadcast sends level' })).toBeTruthy();
  });

  it('shows guardrail rates as percentages and stores them as fractions', async () => {
    const onChange = vi.fn();
    render(
      <MandateEditor
        artifact={{} as never}
        content={content}
        onChange={onChange}
        readOnly={false}
        errors={{}}
        warnings={[]}
        autonomy={autonomy}
      />,
    );

    const rate = screen.getByLabelText('Unsubscribe rate');
    await userEvent.clear(rate);
    await userEvent.type(rate, '0.5');

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ guardrails: expect.objectContaining({ unsubscribeRate: 0.005 }) }));
    expect(percentToFraction('0.5')).toBe(0.005);
    expect(percentToFraction('')).toBeUndefined();
  });
});

describe('hold countdowns (#228)', () => {
  const now = Date.parse('2026-10-30T09:00:00Z');

  it('reads as hours and minutes until the hold runs', () => {
    expect(formatHoldCountdown('2026-10-30T10:12:00Z', now)).toBe('1 h 12 min');
    expect(formatHoldCountdown('2026-10-30T09:12:00Z', now)).toBe('12 min');
    expect(formatHoldCountdown('2026-10-30T09:00:30Z', now)).toBe('1 min');
    expect(formatHoldCountdown('2026-11-01T12:00:00Z', now)).toBe('2 d 3 h');
    expect(formatHoldCountdown('2026-10-30T08:00:00Z', now)).toBe('any moment now');
  });

  it('names the veto window in the inbox sentence', () => {
    expect(holdCountdownText('2026-10-30T10:12:00Z', now)).toBe('Runs in 1 h 12 min unless rejected');
  });
});
