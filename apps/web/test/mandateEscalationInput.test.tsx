import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Autonomy } from '../src/features/agents/labels';
import { type MandateContent, MandateEditor } from '../src/features/artifacts/MandateEditor';

// #1170: with no workspace-admin member list, escalation user ids are typed by hand. The raw text
// has to survive the comma at the end of a new id instead of snapping back to the parsed array.

const h = vi.hoisted(() => ({ membersError: new Error('The member list needs workspace admin.') }));

vi.mock('../src/app/api', () => ({
  api: {
    call: vi.fn(async (name: string) => {
      switch (name) {
        case 'agents.list':
          return { agents: [] };
        case 'artifacts.list':
          return { artifacts: [], total: 0, nextCursor: null };
        case 'purposes.list':
          return { source: 'default', purposes: [] };
        case 'members.list':
          throw h.membersError;
        default:
          return {};
      }
    }),
  },
  errText: (error: unknown) => String(error),
}));

afterEach(cleanup);

const autonomy: Autonomy = {
  switch: 'on',
  maxLevel: {},
  allowLoops: false,
  audienceThreshold: 1000,
  limits: { changesPerDay: 500, messagesPerDay: 1000 },
  contactPressure: [],
};

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
  escalation: { userIds: ['usr_a'] },
  independentCheck: false,
};

function MandateHarness() {
  const [value, setValue] = useState(content);
  return (
    <MandateEditor
      artifact={{} as never}
      content={value}
      onChange={(next) => setValue(next)}
      readOnly={false}
      errors={{}}
      warnings={[]}
      autonomy={autonomy}
    />
  );
}

describe('mandate escalation ids (#1170)', () => {
  it('keeps a trailing comma in the hand-typed user ids', async () => {
    render(<MandateHarness />);
    const ids = (await screen.findByLabelText('Escalation members')) as HTMLInputElement;
    fireEvent.change(ids, { target: { value: 'usr_a, ' } });
    expect(ids.value).toBe('usr_a, ');
  });
});
