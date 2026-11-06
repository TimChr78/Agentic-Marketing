import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Identifier, shortId } from '../src/ui/Identifier';

const ID = 'brd_01JB7Z4K9M2Q8V6N5T3R7Q2M';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Identifier (#437)', () => {
  it('shortens a long id to the first 8 and last 4 characters', () => {
    render(<Identifier value={ID} />);
    expect(shortId(ID)).toBe(`${ID.slice(0, 8)}…${ID.slice(-4)}`);
    expect(screen.getByText(shortId(ID))).toBeTruthy();
    expect(screen.queryByText(ID)).toBeNull();
  });

  it('keeps a short value whole', () => {
    render(<Identifier value="seg_1234abcd" />);
    expect(screen.getByText('seg_1234abcd')).toBeTruthy();
  });

  it('names the copy button with the full value and copies the exact original', async () => {
    render(<Identifier value={ID} label="Broadcast ID" />);
    const button = screen.getByRole('button', { name: `Copy ID ${ID}` });
    await userEvent.click(button);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ID);
    expect(screen.getAllByText('ID copied').length).toBeGreaterThan(0);
  });

  it('expands the short form to selectable full text on click', async () => {
    render(<Identifier value={ID} />);
    await userEvent.click(screen.getByRole('button', { name: /^ID:/ }));
    expect(screen.getByRole('button', { name: /^ID:/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(ID)).toBeTruthy();
  });

  it('reports a failed copy and leaves the full value selectable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<Identifier value={ID} />);
    await userEvent.click(screen.getByRole('button', { name: `Copy ID ${ID}` }));
    expect(screen.getAllByText('Could not copy ID').length).toBeGreaterThan(0);
    expect(screen.getByText(ID)).toBeTruthy();
  });

  it('never reports success when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(<Identifier value={ID} />);
    await userEvent.click(screen.getByRole('button', { name: `Copy ID ${ID}` }));
    expect(screen.queryByText('ID copied')).toBeNull();
    expect(screen.getAllByText('Could not copy ID').length).toBeGreaterThan(0);
  });
});
