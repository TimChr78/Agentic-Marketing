import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1256: approvers may send a template test to their own address (the #53 rule), so the template
// page must offer the button to them too, as the approval drawer already does.

const h = vi.hoisted(() => ({ permissions: [] as string[] }));

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: (p: string) => h.permissions.includes(p), user: { id: 'usr_1' } }),
  useWorkspace: () => ({ can: (p: string) => h.permissions.includes(p), user: { id: 'usr_1' } }),
}));

vi.mock('../src/features/artifacts/ArtifactDetailPage', () => ({
  ArtifactDetailPage: (props: { id: string; extraActions?: (a: { id: string; version: { number: number } }) => unknown }) => (
    <div>
      <p>detail {props.id}</p>
      {props.extraActions?.({ id: props.id, version: { number: 3 } }) as never}
    </div>
  ),
}));

import TemplatePage from '../src/pages/design/TemplatePage';
import { ToastProvider } from '../src/ui';

const id = `eml_${'c'.repeat(32)}`;

const renderPage = () =>
  render(
    <ToastProvider>
      <TemplatePage params={{ id }} />
    </ToastProvider>,
  );

afterEach(() => {
  cleanup();
  h.permissions = [];
});

describe('template test send gate (#1256)', () => {
  it('shows “Send me a test” to an approver without artifacts:write', () => {
    h.permissions = ['artifacts:read', 'artifacts:approve'];
    renderPage();
    expect(screen.getByRole('button', { name: 'Send me a test' })).toBeTruthy();
  });

  it('keeps it for a builder and hides it from a read-only role', () => {
    h.permissions = ['artifacts:read', 'artifacts:write'];
    renderPage();
    expect(screen.getByRole('button', { name: 'Send me a test' })).toBeTruthy();
    cleanup();

    h.permissions = ['artifacts:read'];
    renderPage();
    expect(screen.queryByRole('button', { name: 'Send me a test' })).toBeNull();
  });
});
