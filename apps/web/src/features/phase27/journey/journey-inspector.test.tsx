import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../../../app/api';
import { resetPickerIndexes } from '../../artifacts/pickerIndex';
import { DEFAULTS, type JNode, type NodeKind } from '../../journey/model';

const h = vi.hoisted(() => ({ calls: [] as { name: string; input: Record<string, unknown> }[] }));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown> = {}) => {
        h.calls.push({ name, input });
        if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null };
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        if (name === 'webhooks.list') return { endpoints: [] };
        if (name === 'connections.list') return { connections: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'u1' }, workspace: { id: 'ws_1' } }),
  useWorkspace: () => ({ can: () => true, user: { id: 'u1' }, workspace: { id: 'ws_1' } }),
}));

import { Inspector } from '../../journey/Inspector';

const node = (kind: NodeKind, config: Record<string, unknown> = {}): JNode => ({
  id: `n_${kind}`,
  kind,
  label: `A ${kind} step`,
  config: { ...DEFAULTS[kind], ...config },
});

const fields = (kind: NodeKind, config: Record<string, unknown> = {}) => {
  cleanup();
  render(
    <Inspector
      node={node(kind, config)}
      nodes={[node(kind, config)]}
      warnings={[]}
      readOnly={false}
      onChange={() => {}}
      onConnect={() => {}}
      onDelete={() => {}}
      onDuplicate={() => {}}
    />,
  );
  return screen;
};

beforeEach(() => {
  resetPickerIndexes();
  setWorkspaceId('ws_1', { persist: false });
  h.calls.length = 0;
});

afterEach(cleanup);

const expected: { kind: NodeKind; config?: Record<string, unknown>; labels: (string | RegExp)[] }[] = [
  { kind: 'trigger', labels: ['Starts when', 'Event name', 'Entry key', 'Enter again'] },
  {
    kind: 'trigger',
    config: { entryKey: { source: 'event_property', property: 'order_id', onMissing: 'skip' } },
    labels: ['Property', 'When it is missing'],
  },
  { kind: 'trigger', config: { segment: `seg_${'a'.repeat(32)}`, event: undefined }, labels: ['Segment'] },
  { kind: 'email', labels: ['Template'] },
  { kind: 'sms', labels: ['Template'] },
  { kind: 'push', labels: ['Template'] },
  { kind: 'wait', labels: ['Wait for'] },
  { kind: 'waitEvent', labels: ['Event name', 'Give up after'] },
  {
    kind: 'waitUntil',
    labels: [/Until the person matches/, 'Condition', 'Give up after', 'Check at least every'],
  },
  { kind: 'branch', labels: ['Condition'] },
  { kind: 'split', labels: ['Path A', 'Path B', 'Add path'] },
  { kind: 'goal', labels: ['Event name', 'Counts within'] },
  { kind: 'aiDecide', labels: ['Prompt', 'Options', 'Fallback', 'Wait for the model at most'] },
  { kind: 'aiGenerate', labels: ['Prompt', 'Wait for the model at most'] },
  { kind: 'webhook', labels: ['Endpoint', 'Payload (JSONata)'] },
  { kind: 'action', labels: ['Connection', 'Action', 'Input'] },
  { kind: 'updateProfile', labels: ['Trait', 'Value'] },
  { kind: 'transform', labels: ['Store as', 'Expression (JSONata)'] },
  { kind: 'exit', labels: [] },
];

describe('journey inspector keeps every field (#528)', () => {
  for (const row of expected) {
    it(`keeps the ${row.kind}${row.config ? ' variant' : ''} controls`, () => {
      const view = fields(row.kind, row.config);
      expect(view.getByText('Label')).toBeTruthy();
      for (const label of row.labels) expect(view.getAllByText(label).length).toBeGreaterThan(0);
      if (row.kind === 'waitUntil') expect(view.getByRole('radiogroup', { name: 'Wait until the person' })).toBeTruthy();
      if (row.kind === 'branch') expect(view.getByRole('radiogroup', { name: 'Yes when the person' })).toBeTruthy();
    });
  }

  it('keeps duplicate and delete for every editable step, and connects every outcome', () => {
    fields('branch');
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete step' })).toBeTruthy();
    expect(screen.getByText('Continues to')).toBeTruthy();
    expect(screen.getByText('If yes')).toBeTruthy();
    expect(screen.getByText('If no')).toBeTruthy();
  });

  it('does not coerce unknown configuration away on an edit', () => {
    const onChange = vi.fn();
    const step = node('email', { template: '', futureOption: { keep: true } });
    render(
      <Inspector
        node={step}
        nodes={[step]}
        warnings={[]}
        readOnly={false}
        onChange={onChange}
        onConnect={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
      />,
    );
    const input = screen.getAllByRole('textbox').find((el) => (el as HTMLInputElement).value === step.label)!;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: 'Renamed', config: step.config }));
  });

  it('keeps read-only steps readable without mutation controls', () => {
    const step = node('email', { template: '' });
    render(
      <Inspector
        node={step}
        nodes={[step]}
        warnings={[]}
        readOnly
        onChange={() => {}}
        onConnect={() => {}}
        onDelete={() => {}}
        onDuplicate={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete step' })).toBeNull();
    expect(screen.getByText('Template')).toBeTruthy();
  });
});
