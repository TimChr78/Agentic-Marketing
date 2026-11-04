import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonEditor } from '../src/features/artifacts/JsonEditor';
import { shouldSyncJsonText } from '../src/features/artifacts/jsonDraft';

afterEach(cleanup);

describe('JSON editor draft text (#384)', () => {
  it('never replaces text that is temporarily invalid', () => {
    expect(shouldSyncJsonText({ text: '{"a": 1', value: { a: 1 } })).toBe(false);
    expect(shouldSyncJsonText({ text: '{"a": 1', value: { a: 2 } })).toBe(false);
  });

  it('replaces equal-content identities only when the text no longer means the value', () => {
    expect(shouldSyncJsonText({ text: '{"a":1}', value: { a: 1 } })).toBe(false);
    expect(shouldSyncJsonText({ text: '{"a":1}', value: { a: 2 } })).toBe(true);
  });

  it('keeps mid-edit invalid text through a refetch, but resets on a document switch', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<JsonEditor value={{ a: 1 }} onChange={onChange} documentKey="exp_1" />);
    const text = screen.getByLabelText('Content (JSON)');
    fireEvent.change(text, { target: { value: '{{"a": 1' } });
    expect((text as HTMLTextAreaElement).value).toBe('{{"a": 1');

    // A post-save refetch gives `value` a new identity while the text does not parse.
    rerender(<JsonEditor value={{ a: 1 }} onChange={onChange} documentKey="exp_1" />);
    expect((text as HTMLTextAreaElement).value).toBe('{{"a": 1');

    // Switching artifacts must not leave the previous document's broken text in place.
    rerender(<JsonEditor value={{ b: 2 }} onChange={onChange} documentKey="exp_2" />);
    expect((text as HTMLTextAreaElement).value).toBe(JSON.stringify({ b: 2 }, null, 2));
    expect(screen.queryByText(/Not valid JSON yet/)).toBeNull();
  });

  it('follows a genuinely different valid value from the outside', () => {
    const { rerender } = render(<JsonEditor value={{ a: 1 }} onChange={vi.fn()} />);
    const text = screen.getByLabelText('Content (JSON)') as HTMLTextAreaElement;
    rerender(<JsonEditor value={{ a: 2 }} onChange={vi.fn()} />);
    expect(text.value).toBe(JSON.stringify({ a: 2 }, null, 2));
  });
});
