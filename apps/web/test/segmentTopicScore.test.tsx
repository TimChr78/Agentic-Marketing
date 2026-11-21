import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import { resetPickerIndexes } from '../src/features/artifacts/pickerIndex';
import { SegmentEditor } from '../src/features/artifacts/SegmentEditor';
import { ToastProvider } from '../src/ui';

// #1172: topic and score are valid server leaves. The visual editor used to read them as a blank
// trait row, hiding the real condition and corrupting it on the next edit.

const ws = '11111111-1111-4111-8111-111111111111';
const SEG = `seg_${'a'.repeat(32)}`;

const h = vi.hoisted(() => ({ changed: [] as unknown[] }));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null };
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
}));

function Harness({ initial }: { initial: unknown }) {
  const [content, setContent] = useState({ mode: 'dynamic', condition: initial });
  return (
    <ToastProvider>
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
    </ToastProvider>
  );
}

const lastCondition = () => (h.changed.at(-1) as { condition: unknown }).condition;

beforeEach(() => {
  h.changed.length = 0;
  resetPickerIndexes();
  setWorkspaceId(ws, { persist: false });
});
afterEach(() => cleanup());

describe('segment builder topic and score conditions (#1172)', () => {
  it('shows a topic condition as a topic row and edits only its topic', () => {
    render(<Harness initial={{ topic: 'newsletter' }} />);
    expect((screen.getByRole('combobox', { name: 'Kind of condition 1' }) as HTMLSelectElement).value).toBe('topic');
    const topic = screen.getByLabelText('Topic, condition 1') as HTMLInputElement;
    expect(topic.value).toBe('newsletter');
    fireEvent.change(topic, { target: { value: 'weekly_news' } });
    expect(lastCondition()).toEqual({ topic: 'weekly_news' });
  });

  it('shows a score condition with its key and bounds', () => {
    render(<Harness initial={{ score: { key: 'conversion_propensity', gte: 0.4 } }} />);
    expect((screen.getByRole('combobox', { name: 'Kind of condition 1' }) as HTMLSelectElement).value).toBe('score');
    expect((screen.getByLabelText('Score key, condition 1') as HTMLInputElement).value).toBe('conversion_propensity');
    expect((screen.getByLabelText('Score at least, condition 1') as HTMLInputElement).value).toBe('0.4');
    expect((screen.getByLabelText('Score at most, condition 1') as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('Score at most, condition 1'), { target: { value: '0.9' } });
    expect(lastCondition()).toEqual({ score: { key: 'conversion_propensity', gte: 0.4, lte: 0.9 } });
  });

  it('offers topic and score as kinds for a new condition', () => {
    render(<Harness initial={{ trait: 'city', op: 'eq', value: 'Aarhus' }} />);
    const kind = screen.getByRole('combobox', { name: 'Kind of condition 1' }) as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: 'topic' } });
    expect(lastCondition()).toEqual({ topic: '' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Kind of condition 1' }), { target: { value: 'score' } });
    expect(lastCondition()).toMatchObject({ score: { key: '' } });
  });
});
