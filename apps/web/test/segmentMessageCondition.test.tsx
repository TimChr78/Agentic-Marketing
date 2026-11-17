import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import { resetPickerIndexes } from '../src/features/artifacts/pickerIndex';
import { SegmentEditor } from '../src/features/artifacts/SegmentEditor';
import { ConditionView } from '../src/features/previews/ConditionView';
import { ToastProvider } from '../src/ui';

// #441: the segment builder offers the platform's own engagement (open, click, delivered…) as a
// condition, with the window, channel, purpose and the send it is narrowed to, and the preview
// reads it as a sentence.

const ws = '11111111-1111-4111-8111-111111111111';
const SEG = `seg_${'a'.repeat(32)}`;
const BCT = `bct_${'b'.repeat(32)}`;
const JRN = `jrn_${'c'.repeat(32)}`;

const h = vi.hoisted(() => ({ changed: [] as unknown[] }));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        if (name === 'purposes.list')
          return {
            source: 'published',
            purposes: [
              { key: 'marketing_email', name: 'Marketing e-mail' },
              { key: 'onboarding', name: 'Service messages' },
            ],
          };
        if (name === 'artifacts.list') {
          const artifacts =
            input.type === 'journey'
              ? [{ id: JRN, type: 'journey', name: 'Welcome series', publishedVersion: 3 }]
              : input.type === 'broadcast'
                ? [{ id: BCT, type: 'broadcast', name: 'Weekly Signal #40', publishedVersion: 2 }]
                : [];
          return { artifacts, total: artifacts.length, nextCursor: null };
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({
    can: () => true,
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  }),
  useWorkspace: () => ({
    can: () => true,
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  }),
}));

const renderEditor = (condition: unknown) =>
  render(
    <ToastProvider>
      <Harness initial={condition} />
    </ToastProvider>,
  );

/** The editor is controlled: feed each change back so a test can walk through the options. */
function Harness({ initial }: { initial: unknown }) {
  const [content, setContent] = useState({ mode: 'dynamic', condition: initial });
  return (
    <SegmentEditor
      artifact={{ id: SEG, type: 'segment', name: 'Engaged readers' } as never}
      content={content as never}
      onChange={(next) => {
        h.changed.push(next);
        setContent(next as never);
      }}
      readOnly={false}
      errors={{}}
      warnings={[]}
    />
  );
}

const lastCondition = () => (h.changed.at(-1) as { condition: unknown }).condition;

beforeEach(() => {
  h.changed.length = 0;
  resetPickerIndexes();
  setWorkspaceId(ws, { persist: false });
});
afterEach(() => cleanup());

describe('the segment builder’s message engagement condition', () => {
  it('shows the event, count, window, channel, purpose and send of a saved condition', async () => {
    renderEditor({ message: 'clicked', within: 'P30D', channel: 'email', purpose: 'marketing_email', broadcast: BCT });
    const event = screen.getByRole('combobox', { name: 'Message event, condition 1' }) as HTMLSelectElement;
    expect(event.value).toBe('clicked');
    expect((screen.getByRole('combobox', { name: 'In the last, condition 1' }) as HTMLSelectElement).value).toBe('P30D');
    expect((screen.getByRole('combobox', { name: 'Channel, condition 1' }) as HTMLSelectElement).value).toBe('email');
    expect((screen.getByRole('combobox', { name: 'Purpose, condition 1' }) as HTMLSelectElement).value).toBe('marketing_email');
    // The broadcast picker lists the workspace's broadcasts and selects the saved one.
    expect(await screen.findByRole('option', { name: /Weekly Signal #40/ })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Broadcast, condition 1' }) as HTMLSelectElement).value).toBe(BCT);
  });

  it('edits each option into the condition the server receives', async () => {
    renderEditor({ all: [{ message: 'opened' }, { trait: 'city', op: 'eq', value: 'Aarhus' }] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Message event, condition 1' }), { target: { value: 'clicked' } });
    expect(lastCondition()).toEqual({ all: [{ message: 'clicked' }, { trait: 'city', op: 'eq', value: 'Aarhus' }] });

    fireEvent.change(screen.getByRole('combobox', { name: 'In the last, condition 1' }), { target: { value: 'P7D' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Channel, condition 1' }), { target: { value: 'email' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Purpose, condition 1' }), {
      target: { value: 'marketing_email' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sent from, condition 1' }), { target: { value: 'broadcast' } });
    // Choosing a kind of send is not a send yet: no empty id reaches the condition, which would
    // fail id validation and read as "any send" anyway (it is falsy).
    expect(lastCondition()).toEqual({
      all: [
        { message: 'clicked', within: 'P7D', channel: 'email', purpose: 'marketing_email' },
        { trait: 'city', op: 'eq', value: 'Aarhus' },
      ],
    });

    // Counting at least twice, then back to the default (at least once).
    const count = screen.getByRole('spinbutton', { name: 'At least how many messages, condition 1' });
    fireEvent.change(count, { target: { value: '2' } });
    expect((lastCondition() as { all: [{ count?: { gte?: number } }] }).all[0].count).toEqual({ gte: 2 });
    fireEvent.change(count, { target: { value: '' } });
    expect((lastCondition() as { all: [{ count?: unknown }] }).all[0].count).toBeUndefined();
  });

  it('picks an actual broadcast, then an actual journey, and clears the send again', async () => {
    renderEditor({ all: [{ message: 'opened' }, { trait: 'city', op: 'eq', value: 'Aarhus' }] });
    const row = () => (lastCondition() as { all: [Record<string, unknown>] }).all[0];
    const source = () => screen.getByRole('combobox', { name: 'Sent from, condition 1' });

    // The kind alone is not a change: it keeps the picker on screen and says what is missing.
    fireEvent.change(source(), { target: { value: 'broadcast' } });
    expect(h.changed).toEqual([]);
    const broadcast = await screen.findByRole('combobox', { name: 'Broadcast, condition 1' });
    expect(broadcast.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByText('Choose a broadcast for condition 1.').length).toBeGreaterThan(0);

    fireEvent.change(broadcast, { target: { value: BCT } });
    expect(row()).toEqual({ message: 'opened', broadcast: BCT });

    // A journey replaces the broadcast, but only once one is picked: while the picker waits, the
    // condition still counts the broadcast and nothing is emitted.
    fireEvent.change(source(), { target: { value: 'journey' } });
    expect(h.changed).toHaveLength(1);
    expect(row()).toEqual({ message: 'opened', broadcast: BCT });
    await screen.findByRole('combobox', { name: 'Journey, condition 1' });
    expect(screen.getAllByText('Choose a journey for condition 1.').length).toBeGreaterThan(0);
    // Going back to the saved kind drops the pending pick without touching the condition.
    fireEvent.change(source(), { target: { value: 'broadcast' } });
    expect(screen.queryByRole('combobox', { name: 'Journey, condition 1' })).toBeNull();
    expect(h.changed).toHaveLength(1);

    fireEvent.change(source(), { target: { value: 'journey' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Journey, condition 1' }), { target: { value: JRN } });
    expect(row()).toEqual({ message: 'opened', journey: JRN });

    // Any send is an explicit choice that removes the send; the picker goes away.
    fireEvent.change(source(), { target: { value: 'any' } });
    expect(row()).toEqual({ message: 'opened' });
    expect(screen.queryByRole('combobox', { name: 'Journey, condition 1' })).toBeNull();
  });

  it('offers the condition as a kind of row', async () => {
    renderEditor({ all: [{ trait: 'city', op: 'eq', value: 'Aarhus' }] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind of condition 1' }), { target: { value: 'message' } });
    // One row under "all" is the condition itself, as everywhere in the builder.
    expect(lastCondition()).toEqual({ message: 'opened' });
    expect(screen.getByRole('combobox', { name: 'Message event, condition 1' })).toBeTruthy();
  });
});

describe('a message condition in the preview', () => {
  it('reads as a sentence', () => {
    render(
      <ConditionView condition={{ message: 'opened', count: { gte: 2 }, within: 'P30D', channel: 'email', purpose: 'marketing_email' }} />,
    );
    expect(document.body.textContent).toContain('Opened a message by e-mail for marketing_email at least 2 times in the last 30 days');
  });

  it('names the send it counts', () => {
    render(<ConditionView condition={{ not: { message: 'clicked', broadcast: BCT } }} />);
    expect(document.body.textContent).toContain('Clicked a link in a message from broadcast');
  });
});
