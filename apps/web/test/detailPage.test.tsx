import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailPage } from '../src/ui/DetailPage';

afterEach(cleanup);

const tabs = [
  { key: 'content', label: 'Content', panel: <p>Content panel</p> },
  { key: 'sending', label: 'Sending', panel: <p>Sending panel</p> },
  { key: 'report', label: 'Report', panel: <p>Report panel</p> },
];

function detail(overrides: Partial<Parameters<typeof DetailPage>[0]> = {}) {
  return (
    <DetailPage
      title="Lifecycle playbook"
      kind="Broadcast"
      statePill={<span>Delivering</span>}
      metadata={<span>Published v2</span>}
      primaryAction={<button type="button">View report</button>}
      secondaryActions={<button type="button">More actions</button>}
      consequence={<p>Who · When · Next</p>}
      tabs={tabs}
      activeTab="content"
      onTabChange={() => {}}
      context={<p>Context facts</p>}
      state="ready"
      loadingContent={<p>Loading panel</p>}
      {...overrides}
    />
  );
}

describe('DetailPage template (#448)', () => {
  it('shows one h1, kind, pill, metadata, consequence before the tabs, the selected panel and context', () => {
    render(detail());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Lifecycle playbook' })).toBeTruthy();
    expect(screen.getByText('Broadcast')).toBeTruthy();
    expect(screen.getByText('Delivering')).toBeTruthy();
    expect(screen.getByText('Published v2')).toBeTruthy();
    expect(screen.getByText('View report')).toBeTruthy();
    expect(screen.getByText('More actions')).toBeTruthy();

    const consequence = screen.getByText('Who · When · Next');
    const tablist = screen.getByRole('tablist', { name: 'Sections' });
    expect(consequence.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByRole('tab', { name: 'Content' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Content panel')).toBeTruthy();
    expect(screen.queryByText('Sending panel')).toBeNull();
    expect(screen.getByText('Context facts')).toBeTruthy();
  });

  it('mounts only the selected panel and moves tabs with the arrow keys', () => {
    let active = 'content';
    const onTabChange = vi.fn((key: string) => {
      active = key;
    });
    const { rerender } = render(detail({ onTabChange }));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Content' }), { key: 'ArrowRight' });
    expect(onTabChange).toHaveBeenCalledWith('sending');
    rerender(detail({ activeTab: active, onTabChange }));
    expect(screen.getByText('Sending panel')).toBeTruthy();
    expect(screen.queryByText('Content panel')).toBeNull();
  });

  it('keeps the header and consequence space while loading', () => {
    render(detail({ state: 'loading' }));
    expect(screen.getByText('Loading panel')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it('replaces the content with a root error notice and no tabs', () => {
    render(
      detail({
        state: 'error',
        notice: { title: 'Broadcast not found', body: 'It may have been deleted.', action: <button type="button">Retry</button> },
      }),
    );
    expect(screen.getByText('Broadcast not found')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('Context facts')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows a restricted notice without actions', () => {
    render(
      detail({
        state: 'restricted',
        primaryAction: undefined,
        secondaryActions: undefined,
        notice: { title: 'Broadcasts are restricted', body: 'Ask an admin for access.' },
      }),
    );
    expect(screen.getByText('Broadcasts are restricted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View report' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
