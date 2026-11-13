import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InsertPalette } from '../src/features/templates/InsertPalette';
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

function EscapeDialog({ onEscape }: { onEscape: () => void }) {
  return (
    <Modal open onClose={onEscape} title="Escape target">
      <input aria-label="Field" />
    </Modal>
  );
}

function Palette() {
  const [open, setOpen] = useState(true);
  return open ? (
    <InsertPalette
      onClose={() => setOpen(false)}
      onInsertElement={() => undefined}
      onInsertImage={() => undefined}
      onInsertBlock={() => undefined}
    />
  ) : null;
}

describe('latest escape handler (#820)', () => {
  it('calls the handler from the latest render after the prop changes', () => {
    // The trap mounts once and reads the handler from a ref, so a new inline handler must be the
    // one Escape calls. Re-running the effect instead would also re-focus the first control.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<EscapeDialog onEscape={first} />);
    rerender(<EscapeDialog onEscape={second} />);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('Insert palette focus (#820)', () => {
  it('keeps focus in the search field while typing re-renders the palette', () => {
    render(<Palette />);
    const search = screen.getByPlaceholderText('Search insert palette');
    search.focus();
    expect(document.activeElement).toBe(search);

    fireEvent.change(search, { target: { value: 'i' } });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'im' } });
    expect(document.activeElement).toBe(search);
    expect((search as HTMLInputElement).value).toBe('im');
  });
});
