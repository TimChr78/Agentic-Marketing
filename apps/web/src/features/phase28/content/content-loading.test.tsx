import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AssetsPage from '../../../pages/design/AssetsPage';
import { ToastProvider } from '../../../ui';
import { AssetPicker } from '../../assets/AssetPicker';
import { HostedPreview } from '../../brand/HostedPreview';
import { ContentList } from '../../phase27/content/ContentList';

// Phase 28 (#559): every C loading placeholder is the shared labelled skeleton with the geometry
// of the template it stands in for, and the object-specific label replaces the generic "Loading".

const h = vi.hoisted(() => ({
  mode: 'pending' as 'pending' | 'ready',
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (h.mode === 'pending') return new Promise(() => {});
        if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null };
        if (name === 'assets.list') return { assets: [] };
        if (name === 'hostedPages.preview') return { html: '<!doctype html><html><body>Preview</body></html>' };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => true, switchWorkspace: async () => {} }),
}));

beforeEach(() => {
  h.mode = 'pending';
  h.calls = [];
  vi.useRealTimers();
});
afterEach(cleanup);

const list = (over: Partial<Parameters<typeof ContentList>[0]> = {}) => (
  <ToastProvider>
    <ContentList
      type="email_template"
      title="E-mail templates"
      noun="templates"
      layout="gallery"
      description="E-mails in MJML."
      emptyTitle="No e-mail templates yet"
      emptyText="Create one."
      create={{ label: 'New template', content: (name: string) => ({ subject: name }) }}
      {...over}
    />
  </ToastProvider>
);

describe('content loading placeholders are labelled skeletons (#559)', () => {
  it('labels the template gallery read and uses the shared list geometry', () => {
    render(list());
    // One region per breakpoint: the phone rows and the desktop gallery. CSS shows exactly one.
    const regions = screen.getAllByRole('status', { name: 'Loading templates' });
    expect(regions).toHaveLength(2);
    for (const region of regions) {
      expect(region.getAttribute('aria-busy')).toBe('true');
      expect(region.getAttribute('data-geometry')).toBe('list');
      expect(region.querySelector('[data-skeleton-shape]')).toBeTruthy();
    }
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
  });

  it('reserves the phone list geometry below 768 px and the gallery above it', () => {
    render(list());
    const [phone, desktop] = screen.getAllByRole('status', { name: 'Loading templates' });
    // The phone slot is the ready list's compact row, not the desktop's 170 px tile.
    expect(phone.className).toContain('md:hidden');
    const rows = phone.querySelectorAll('[data-skeleton-phone-list] > li');
    expect(rows).toHaveLength(5);
    for (const row of rows) expect((row as HTMLElement).style.minHeight).toBe('72px');
    expect(phone.querySelector('[data-skeleton-phone-list]')?.querySelectorAll('svg')).toHaveLength(0);
    // The desktop region keeps the gallery tiles behind the md breakpoint.
    expect(desktop.parentElement?.className).toContain('hidden md:block');
    expect(desktop.querySelectorAll('li')).toHaveLength(6);
  });

  it('labels the block table read', () => {
    render(list({ type: 'email_block', title: 'Blocks', noun: 'blocks', layout: 'table' }));
    expect(screen.getAllByRole('status', { name: 'Loading blocks' })).toHaveLength(2);
  });

  it('labels the asset list read', () => {
    render(
      <ToastProvider>
        <AssetsPage />
      </ToastProvider>,
    );
    const region = screen.getByRole('status', { name: 'Loading assets' });
    expect(region.getAttribute('aria-busy')).toBe('true');
  });

  it('labels the asset picker read', () => {
    render(<AssetPicker onClose={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Loading images' })).toBeTruthy();
  });

  it('reserves the hosted preview frame at its own height', () => {
    render(<HostedPreview brand={{ siteName: 'Northstar' }} height={420} />);
    const region = screen.getByRole('status', { name: 'Loading the hosted page preview' });
    expect(region.style.minHeight).toBe('420px');
    expect(region.getAttribute('aria-busy')).toBe('true');
  });
});
