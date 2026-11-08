import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATEGORIES, KINDS, PALETTE_ORDER } from '../../journey/model';
import { Palette } from '../../journey/Palette';

afterEach(cleanup);

const allKinds = () => PALETTE_ORDER.map((k) => KINDS[k].label);

describe('journey step palette (#528)', () => {
  it('keeps every one of the 17 step kinds, grouped in the existing categories', () => {
    render(<Palette onAdd={() => {}} />);
    // The palette is one navigation landmark; every kind stays a button with its own name.
    expect(screen.getByRole('navigation', { name: 'Steps' })).toBeTruthy();
    for (const label of allKinds()) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(allKinds()).toHaveLength(17);
    for (const category of CATEGORIES) expect(screen.getAllByText(category.label).length).toBeGreaterThan(0);
  });

  it('shows an icon, name and short purpose for every step', () => {
    render(<Palette onAdd={() => {}} />);
    for (const kind of PALETTE_ORDER) {
      const button = screen.getByRole('button', { name: KINDS[kind].label });
      expect(button.textContent).toContain(KINDS[kind].label);
      expect(button.textContent).toContain(KINDS[kind].hint);
      expect(button.querySelector('svg')).toBeTruthy();
    }
  });

  it('filters locally without changing which steps exist', () => {
    const onAdd = vi.fn();
    render(<Palette onAdd={onAdd} />);
    const search = screen.getByRole('textbox', { name: 'Find a step' });

    fireEvent.change(search, { target: { value: 'wait' } });
    expect(screen.getByRole('button', { name: 'Wait' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wait for event' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Wait until' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'E-mail' })).toBeNull();
    expect(screen.getAllByText('Wait').length).toBeGreaterThan(0);

    // Search matches the short purpose too, never the semantics.
    fireEvent.change(search, { target: { value: 'webhook endpoint' } });
    expect(screen.getByRole('button', { name: 'Webhook' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Action' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Webhook' }));
    expect(onAdd).toHaveBeenCalledWith('webhook');
  });

  it('offers Clear search when nothing matches, then restores all kinds', () => {
    render(<Palette onAdd={() => {}} />);
    const search = screen.getByRole('textbox', { name: 'Find a step' });

    fireEvent.change(search, { target: { value: 'no such step' } });
    expect(screen.getByText(/No steps match/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect((screen.getByRole('textbox', { name: 'Find a step' }) as HTMLInputElement).value).toBe('');
    for (const label of allKinds()) expect(screen.getByRole('button', { name: label })).toBeTruthy();
  });

  it('still adds every kind by pressing it', () => {
    const onAdd = vi.fn();
    render(<Palette onAdd={onAdd} />);
    for (const kind of PALETTE_ORDER) fireEvent.click(screen.getByRole('button', { name: KINDS[kind].label }));
    expect(onAdd.mock.calls.map(([kind]) => kind)).toEqual(PALETTE_ORDER);
  });
});
