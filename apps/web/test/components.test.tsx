import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from '../src/ui/diff';
import { Field, Input } from '../src/ui/form';
import { Menu } from '../src/ui/menu';
import { useConfirm } from '../src/ui/overlay';
import { ChartSkeleton, KpiSkeleton, ListSkeleton, LoadingBlock, SKELETON_DELAY_MS, Skeleton } from '../src/ui/Skeleton';
import { Tabs } from '../src/ui/tabs';

afterEach(cleanup);

describe('ui components', () => {
  it('Field wires its label, hint and error to the control', () => {
    render(
      <Field label="From address" hint="On a verified domain." error="Enter an address.">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText('From address');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const described = input
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Enter an address.', 'On a verified domain.']);
  });

  it('Tabs move with the arrow keys (WAI-ARIA)', async () => {
    function T() {
      const [v, setV] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs
          label="T"
          value={v}
          onChange={setV}
          items={[
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
            { key: 'c', label: 'C' },
          ]}
        >
          {v}
        </Tabs>
      );
    }
    render(<T />);
    screen.getByRole('tab', { name: 'A' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tabpanel').textContent).toBe('c');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'A' })).toBe(document.activeElement);
  });

  it('a destructive confirm with the object name stays disabled until the name is typed', async () => {
    let answer: boolean | undefined;
    function C() {
      const [dialog, ask] = useConfirm();
      return (
        <>
          <button
            type="button"
            onClick={async () =>
              (answer = await ask({ title: 'Delete “Hermes”?', confirmLabel: 'Revoke token', destructive: true, typeToConfirm: 'Hermes' }))
            }
          >
            open
          </button>
          {dialog}
        </>
      );
    }
    render(<C />);
    await userEvent.click(screen.getByText('open'));
    const confirm = screen.getByRole('button', { name: 'Revoke token' });
    expect(confirm).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/to confirm/), 'Hermes');
    expect(confirm).toHaveProperty('disabled', false);
    await userEvent.click(confirm);
    expect(answer).toBe(true);
  });

  it('Escape cancels a confirm', async () => {
    let answer: boolean | undefined;
    function C() {
      const [dialog, ask] = useConfirm();
      return (
        <>
          <button type="button" onClick={async () => (answer = await ask({ title: 'Delete?', confirmLabel: 'Delete' }))}>
            open
          </button>
          {dialog}
        </>
      );
    }
    render(<C />);
    await userEvent.click(screen.getByText('open'));
    await userEvent.keyboard('{Escape}');
    expect(answer).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Menu opens with ArrowDown, moves with arrows and selects with Enter', async () => {
    const picked: string[] = [];
    render(
      <Menu
        label="More"
        items={[
          { label: 'Edit', onSelect: () => picked.push('edit') },
          'separator',
          { label: 'Delete', destructive: true, onSelect: () => picked.push('delete') },
        ]}
        trigger={(p) => (
          <button type="button" {...p}>
            More
          </button>
        )}
      />,
    );
    screen.getByRole('button', { name: 'More' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBe(document.activeElement);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(picked).toEqual(['delete']);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('DiffView labels changes in words, not colour alone', () => {
    render(
      <DiffView
        from={1}
        to={2}
        changes={[
          { path: 'subject', kind: 'changed', before: 'Old', after: 'New' },
          { path: 'preheader', kind: 'added', after: 'Hi' },
        ]}
      />,
    );
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.getByText(/v1 \(live\) → v2/)).toBeTruthy();
    expect(screen.getAllByText(/Before:|After:/).length).toBe(3);
    act(() => fireEvent.click(document.body));
  });
});

describe('reserved loading geometry (#555)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the list geometry the ready template uses', () => {
    render(<ListSkeleton label="Loading broadcasts" />);
    const region = screen.getByRole('status', { name: 'Loading broadcasts' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.getAttribute('data-geometry')).toBe('list');
    const table = region.querySelector('[data-skeleton-list="table"]')!;
    expect(table).toBeTruthy();
    // Header row 36 px and five 48 px body rows, not arbitrary text bars.
    expect(table.querySelector('.h-9')).toBeTruthy();
    expect(table.querySelectorAll('.h-12')).toHaveLength(5);
    // The phone branch reserves five real summary cards (88 px), not desktop rows.
    const cards = region.querySelector('[data-skeleton-list="cards"]')!;
    expect(cards.querySelectorAll('.min-h-\\[88px\\]')).toHaveLength(5);
  });

  it('renders the KPI and chart slots with their final dimensions', () => {
    render(<KpiSkeleton label="Loading delivered people" />);
    const kpi = screen.getByRole('status', { name: 'Loading delivered people' });
    expect(kpi.style.minHeight).toBe('204px');
    cleanup();
    render(<ChartSkeleton label="Loading performance" />);
    const chart = document.querySelector('[data-skeleton-shape="chart"]')!;
    expect(chart.className).toContain('h-[200px]');
    expect(chart.className).toContain('md:h-[240px]');
  });

  it('reserves the space immediately and reveals shapes only after 150 ms', () => {
    vi.useFakeTimers();
    render(<ListSkeleton label="Loading people" />);
    const region = screen.getByRole('status', { name: 'Loading people' });
    expect(region.getAttribute('data-skeleton-visible')).toBe('false');
    // The rows are in the DOM (space reserved) but hidden, so a fast read never flashes them.
    expect(region.querySelectorAll('.h-12')).toHaveLength(5);
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 1));
    expect(region.getAttribute('data-skeleton-visible')).toBe('false');
    act(() => vi.advanceTimersByTime(1));
    expect(region.getAttribute('data-skeleton-visible')).toBe('true');
  });

  it('keeps the generic adapter labelled and geometry-aware', () => {
    render(<LoadingBlock lines={2} label="Loading reviews" geometry="chart" delay={0} />);
    const region = screen.getByRole('status', { name: 'Loading reviews' });
    expect(region.getAttribute('data-geometry')).toBe('chart');
    expect(region.querySelector('[data-skeleton-shape="chart"]')).toBeTruthy();
  });

  it('never renders an animated shape', () => {
    render(<Skeleton shape="card" />);
    const shape = document.querySelector('[data-skeleton-shape="card"]')!;
    expect(shape.className).not.toMatch(/animate-|shimmer/);
  });
});
