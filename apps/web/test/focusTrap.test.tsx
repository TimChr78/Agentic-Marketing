import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Modal } from '../src/ui/overlay';

// #820: dialogs pass `onClose` inline, so its identity changes on every render. The focus trap must
// not treat that as a reason to re-run: a keystroke that re-renders the dialog used to pull focus
// back to the first field, interleaving whatever was typed into a later field.

function Dialog() {
  const [open, setOpen] = useState(true);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Two fields">
      <label>
        First
        <input value={first} onChange={(e) => setFirst(e.target.value)} />
      </label>
      <label>
        Second
        <input aria-label="Second" value={second} onChange={(e) => setSecond(e.target.value)} />
      </label>
    </Modal>
  );
}

afterEach(cleanup);

describe('dialog focus trap (#820)', () => {
  it('keeps focus in the second input while typing re-renders the dialog', () => {
    render(<Dialog />);
    const second = screen.getByLabelText('Second');
    second.focus();
    expect(document.activeElement).toBe(second);

    fireEvent.change(second, { target: { value: 'a' } });
    expect(document.activeElement).toBe(second);

    fireEvent.change(second, { target: { value: 'ab' } });
    expect(document.activeElement).toBe(second);
    expect((second as HTMLInputElement).value).toBe('ab');
  });
});
