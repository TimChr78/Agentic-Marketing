import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceId } from '../src/app/api';
import ImportsPage from '../src/pages/audience/ImportsPage';
import { ToastProvider } from '../src/ui';

// #600: an import row for a purpose that is no longer configured must use the 0.14.0 fallback,
// "Unavailable purpose", with the technical key kept behind its copy control.

const ws = '11111111-1111-4111-8111-111111111111';

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string) => {
        if (name === 'purposes.list') return { source: 'published', purposes: [] };
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../src/app/session', () => {
  const session = () => ({
    can: () => true,
    workspace: { id: ws, approvalPolicy: 'none', timeZone: 'UTC' },
    user: { id: 'u1', name: 'Alex Morgan', email: 'alex@example.com' },
  });
  return { useSession: session, useWorkspace: session };
});

beforeEach(() => {
  cleanup();
  setWorkspaceId(ws, { persist: false });
  window.history.replaceState(null, '', '/');
});

afterEach(() => cleanup());

describe('import purpose fallback (#600)', () => {
  it('names an unresolved saved purpose “Unavailable purpose” and keeps its key behind the copy control', async () => {
    render(
      <ToastProvider>
        <ImportsPage />
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Or paste the CSV'), {
      target: { value: 'email_address,first_name\nada@example.com,Ada' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use pasted CSV' }));

    const purpose = (await screen.findByRole('textbox', { name: /^Purpose/ })) as HTMLInputElement;
    fireEvent.change(purpose, { target: { value: 'legacy_purpose' } });
    expect((screen.getByRole('textbox', { name: /^Purpose/ }) as HTMLInputElement).value).toBe('legacy_purpose');

    const preview = await screen.findByRole('table', { name: 'Rows to import' });
    expect(await within(preview).findByText('Unavailable purpose')).toBeTruthy();
    expect(preview.textContent).not.toContain('Legacy Purpose');
    // The raw key is named only by the copy affordance, never as the label itself.
    expect(
      within(preview)
        .getByText(/legacy_purpose/)
        .closest('button')?.textContent,
    ).toContain('Copy purpose key legacy_purpose');
  });
});
