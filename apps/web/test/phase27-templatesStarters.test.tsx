import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TemplatesPage from '../src/pages/design/TemplatesPage';
import { ToastProvider } from '../src/ui/toast';

const h = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        h.calls.push(name);
        if (name === 'artifacts.list') return { artifacts: [], total: 0, nextCursor: null };
        if (name === 'recipes.list') return { recipes: [] };
        throw new Error(`unexpected ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, workspace: { id: 'ws-1' } }),
  useWorkspace: () => ({ can: () => true, workspace: { id: 'ws-1', approvalPolicy: 'none', timeZone: 'UTC' } }),
}));

beforeEach(() => {
  h.calls.length = 0;
  window.history.replaceState(null, '', '/content/templates?tab=starters');
});

afterEach(cleanup);

describe('Templates Starters tab (#524)', () => {
  it('mounts the existing recipes gallery through its embedded export, without double chrome', async () => {
    render(
      <ToastProvider>
        <TemplatesPage />
      </ToastProvider>,
    );
    expect(await screen.findByRole('tab', { name: 'Starters' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Templates' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Blocks' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Starters' }).getAttribute('aria-selected')).toBe('true');
    // The recipe gallery is the embedded one: it renders no second page heading and no
    // "This tab is unavailable" notice.
    await waitFor(() => expect(h.calls).toContain('recipes.list'));
    expect(await screen.findByText('No recipes')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Recipes' })).toBeNull();
    expect(screen.queryByText('This tab is unavailable.')).toBeNull();
  });
});
