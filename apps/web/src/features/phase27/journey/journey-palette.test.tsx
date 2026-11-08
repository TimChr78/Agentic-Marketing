import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATEGORIES, KINDS, PALETTE_ORDER } from '../../journey/model';
import { Palette } from '../../journey/Palette';

afterEach(cleanup);

const allKinds = () => PALETTE_ORDER.map((k) => KINDS[k].label);

// A step button's accessible name is its visible text, the step name followed by its purpose
// (axe label-content-name-mismatch), so it is matched by name and hint together.
const hintOf = (label: string) => Object.values(KINDS).find((meta) => meta.label === label)?.hint ?? '';
const stepName = (label: string) => (name: string) => name.replace(/\s+/g, '') === `${label}${hintOf(label)}`.replace(/\s+/g, '');
const stepButton = (label: string) => screen.getByRole('button', { name: stepName(label) });
const queryStep = (label: string) => screen.queryByRole('button', { name: stepName(label) });

describe('journey step palette (#528)', () => {
  it('keeps every one of the 17 step kinds, grouped in the existing categories', () => {
    render(<Palette onAdd={() => {}} />);
    // The palette is one navigation landmark; every kind stays a button with its own name.
    expect(screen.getByRole('navigation', { name: 'Steps' })).toBeTruthy();
    for (const label of allKinds()) expect(stepButton(label)).toBeTruthy();
    expect(allKinds()).toHaveLength(17);
    for (const category of CATEGORIES) expect(screen.getAllByText(category.label).length).toBeGreaterThan(0);
  });

  it('shows an icon, name and short purpose for every step', () => {
    render(<Palette onAdd={() => {}} />);
    for (const kind of PALETTE_ORDER) {
      const button = stepButton(KINDS[kind].label);
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
    expect(stepButton('Wait')).toBeTruthy();
    expect(stepButton('Wait for event')).toBeTruthy();
    expect(stepButton('Wait until')).toBeTruthy();
    expect(queryStep('E-mail')).toBeNull();
    expect(screen.getAllByText('Wait').length).toBeGreaterThan(0);

    // Search matches the short purpose too, never the semantics.
    fireEvent.change(search, { target: { value: 'webhook endpoint' } });
    expect(stepButton('Webhook')).toBeTruthy();
    expect(queryStep('Action')).toBeNull();

    fireEvent.click(stepButton('Webhook'));
    expect(onAdd).toHaveBeenCalledWith('webhook');
  });

  it('offers Clear search when nothing matches, then restores all kinds', () => {
    render(<Palette onAdd={() => {}} />);
    const search = screen.getByRole('textbox', { name: 'Find a step' });

    fireEvent.change(search, { target: { value: 'no such step' } });
    expect(screen.getByText(/No steps match/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect((screen.getByRole('textbox', { name: 'Find a step' }) as HTMLInputElement).value).toBe('');
    for (const label of allKinds()) expect(stepButton(label)).toBeTruthy();
  });

  it('still adds every kind by pressing it', () => {
    const onAdd = vi.fn();
    render(<Palette onAdd={onAdd} />);
    for (const kind of PALETTE_ORDER) fireEvent.click(stepButton(KINDS[kind].label));
    expect(onAdd.mock.calls.map(([kind]) => kind)).toEqual(PALETTE_ORDER);
  });
});
