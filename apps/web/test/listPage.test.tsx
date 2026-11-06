import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListPage } from '../src/ui/ListPage';

afterEach(cleanup);

function table() {
  return (
    <table>
      <caption>Rows</caption>
      <thead>
        <tr>
          <th scope="col">Name</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Alpha</td>
        </tr>
      </tbody>
    </table>
  );
}

function list(overrides: Partial<Parameters<typeof ListPage>[0]> = {}) {
  return (
    <ListPage
      title="Broadcasts"
      description="One-off e-mails."
      primaryAction={<button type="button">New broadcast</button>}
      filters={<select aria-label="Status" />}
      countLabel="47 broadcasts"
      state="ready"
      loadingContent={<p>Loading rows</p>}
      desktopTable={table()}
      mobileList={<ul aria-label="Rows" />}
      pagination={<button type="button">Next</button>}
      {...overrides}
    />
  );
}

describe('ListPage template (#448)', () => {
  it('keeps one h1, the filters, the count and a single ready table with pagination', () => {
    render(list());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Broadcasts' })).toBeTruthy();
    expect(screen.getByLabelText('Status')).toBeTruthy();
    expect(screen.getByText('47 broadcasts')).toBeTruthy();
    // The table and the phone list are both present in the DOM but each is display-hidden at the
    // other breakpoint; there is never a table/cards switch.
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Rows' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
  });

  it('replaces rows with the loading content and keeps aria-busy', () => {
    render(list({ state: 'loading' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('Loading rows')).toBeTruthy();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('shows the error notice and Retry while retaining the header and filters', () => {
    const retry = vi.fn();
    render(
      list({
        state: 'error',
        countLabel: undefined,
        notice: {
          title: 'Couldn’t load broadcasts',
          body: 'Broadcast data is unavailable.',
          action: (
            <button type="button" onClick={retry}>
              Retry
            </button>
          ),
        },
      }),
    );
    expect(screen.getByText('Couldn’t load broadcasts')).toBeTruthy();
    expect(screen.getByText('Broadcast data is unavailable.')).toBeTruthy();
    expect(screen.getByLabelText('Status')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New broadcast' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an empty notice without org-wide count or pagination', () => {
    render(
      list({
        state: 'empty',
        countLabel: '0 broadcasts',
        notice: { title: 'No broadcasts yet', body: 'Create an e-mail send to a segment.' },
      }),
    );
    expect(screen.getByText('No broadcasts yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('hides filters, count and create action for a restricted read', () => {
    render(
      list({
        state: 'restricted',
        primaryAction: undefined,
        notice: { title: 'Broadcasts are restricted', body: 'Ask an admin for access.' },
      }),
    );
    expect(screen.getByText('Broadcasts are restricted')).toBeTruthy();
    expect(screen.queryByLabelText('Status')).toBeNull();
    expect(screen.queryByText('47 broadcasts')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New broadcast' })).toBeNull();
  });
});
