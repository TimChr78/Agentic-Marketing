import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssetsPage from '../../../pages/design/AssetsPage';
import { ToastProvider } from '../../../ui';

type Call = { name: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  assets: [] as unknown[],
  detail: null as unknown,
  error: null as Error | null,
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'assets.list') {
          if (h.error) throw h.error;
          return { assets: h.assets };
        }
        if (name === 'assets.get') return h.detail;
        if (name === 'assets.update' || name === 'assets.delete') return {};
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => true }),
}));

const asset = (over: Record<string, unknown> = {}) => ({
  id: `ast_${'a'.repeat(32)}`,
  name: 'Coastal light',
  fileName: 'coast.png',
  contentType: 'image/png',
  kind: 'image',
  byteSize: 12345,
  width: 1200,
  height: 800,
  altText: 'A lighthouse on a quiet coast',
  url: 'https://cdn.example/a/coast.png',
  rendition: null,
  sanitized: [],
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-02T09:00:00.000Z',
  createdBy: 'u1',
  usageCount: 1,
  usage: [{ artifactId: `eml_${'b'.repeat(32)}`, artifactName: 'Weekly journal', artifactType: 'email_template', versions: ['published'] }],
  ...over,
});

const png = asset();
const svg = asset({
  id: `ast_${'c'.repeat(32)}`,
  name: 'Wordmark',
  fileName: 'wordmark.svg',
  contentType: 'image/svg+xml',
  url: 'https://cdn.example/a/wordmark.svg',
  rendition: {
    contentType: 'image/png',
    byteSize: 2048,
    width: 400,
    height: 120,
    url: 'https://cdn.example/a/wordmark.png',
  },
  sanitized: ['script'],
  usageCount: 0,
  usage: [],
});

const renderPage = () =>
  render(
    <ToastProvider>
      <AssetsPage />
    </ToastProvider>,
  );

beforeEach(() => {
  h.calls = [];
  h.error = null;
  h.assets = [png, svg];
  h.detail = png;
});

afterEach(cleanup);

describe('Assets page (#526)', () => {
  it('leads with a thumbnail gallery and the same search, kind filter and upload action', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Assets' })).toBeTruthy();
    expect(screen.getByLabelText('Search assets')).toBeTruthy();
    expect(screen.getByLabelText('Kind')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeTruthy();
    expect((await screen.findAllByRole('button', { name: /Coastal light/ })).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Wordmark/ }).length).toBeGreaterThan(0);
    expect(screen.getByText('2 shown · up to 200')).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'assets.list')).toHaveLength(1);
    // No usage read per tile: the list response already carries the usage count.
    expect(h.calls.some((c) => c.name === 'assets.get')).toBe(false);
  });

  it('opens the detail drawer with the public URL, name, alt text and usage links', async () => {
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /Coastal light/ }))[0]);
    const drawer = await screen.findByRole('dialog', { name: /Coastal light/ });
    expect(within(drawer).getByText('Public URL')).toBeTruthy();
    expect(within(drawer).getByText('https://cdn.example/a/coast.png')).toBeTruthy();
    expect(within(drawer).getByLabelText(/^Name/)).toHaveProperty('value', 'Coastal light');
    expect(within(drawer).getByLabelText(/^Alt text/)).toHaveProperty('value', 'A lighthouse on a quiet coast');
    expect(within(drawer).getByText('Weekly journal')).toBeTruthy();
    expect(within(drawer).getByText('Live')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(h.calls.filter((c) => c.name === 'assets.get')).toHaveLength(1);
  });

  it('shows the PNG e-mail variant and sanitised-SVG note for an SVG', async () => {
    h.detail = svg;
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /Wordmark/ }))[0]);
    const drawer = await screen.findByRole('dialog', { name: /Wordmark/ });
    expect(within(drawer).getByText('PNG version for e-mail')).toBeTruthy();
    expect(within(drawer).getByText('https://cdn.example/a/wordmark.png')).toBeTruthy();
    expect(within(drawer).getByText(/Use the generated PNG version in e-mail/)).toBeTruthy();
    expect(within(drawer).getByText(/This SVG was sanitised/)).toBeTruthy();
    expect(within(drawer).getByText(/Removed: script/)).toBeTruthy();
  });

  it('explains every usage before force-deleting an in-use asset', async () => {
    renderPage();
    await userEvent.click((await screen.findAllByRole('button', { name: /Coastal light/ }))[0]);
    const drawer = await screen.findByRole('dialog', { name: /Coastal light/ });
    await userEvent.click(within(drawer).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(/It is used in 1 item/)).toBeTruthy();
    expect(within(confirm).getByText(/Weekly journal/)).toBeTruthy();
    await userEvent.type(within(confirm).getByLabelText(/Type Coastal light to confirm/), 'Coastal light');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() =>
      expect(h.calls.find((c) => c.name === 'assets.delete')?.input).toEqual({
        id: `ast_${'a'.repeat(32)}`,
        force: true,
      }),
    );
  });

  it('keeps the filtered empty state and offers Clear filters', async () => {
    h.assets = [];
    renderPage();
    expect(await screen.findByText('No assets yet')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Search assets'), 'missing');
    expect(await screen.findByText('Nothing matches')).toBeTruthy();
    await waitFor(() => expect(h.calls.some((c) => c.name === 'assets.list' && c.input.query === 'missing')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('No assets yet')).toBeTruthy();
  });
});
