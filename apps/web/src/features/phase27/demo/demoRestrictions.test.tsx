import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_RESTRICTION_REASON } from '../../../app/capabilities';
import { DEMO_ARTIFACTS, DEMO_PENDING_APPROVALS } from '../integration/demo';

const media = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', media);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('scrollTo', () => {});
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const renderDemoAt = async (path: string) => {
  window.history.replaceState(null, '', path);
  const { DemoRoot } = await import('../integration/demo/DemoRoot');
  render(<DemoRoot />);
};

describe('demo mutation controls are visibly disabled (#530)', () => {
  it('Workspace settings: Save is disabled with the demo reason', async () => {
    await renderDemoAt('/demo/settings/workspace');
    const save = (await screen.findByRole('button', { name: 'Save' })) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
    expect(save.getAttribute('data-demo-blocked')).toBe('true');
  });

  it('Providers: the provider save is disabled with the demo reason', async () => {
    await renderDemoAt('/demo/settings/providers');
    const adds = await screen.findAllByRole('button', { name: 'Add provider' });
    fireEvent.click(adds[0]!);
    const drawer = await screen.findByRole('dialog');
    const save = within(drawer)
      .getAllByRole('button')
      .find((button) => button.textContent?.includes('Add provider')) as HTMLButtonElement;
    expect(save).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
  });

  it('Approvals: Approve and publish is disabled with the demo reason', async () => {
    const approval = DEMO_PENDING_APPROVALS.find((row) => row.holdUntil === null)!;
    await renderDemoAt(`/demo/approvals/${approval.id}`);
    const approve = (await screen.findByRole('button', { name: 'Approve and publish' })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
    expect(approve.getAttribute('data-demo-blocked')).toBe('true');
  });

  it('A draft template detail: Submit for review is disabled with the demo reason', async () => {
    const draft = DEMO_ARTIFACTS.find((row) => row.name === 'Weekly Signal #43')!;
    await renderDemoAt(`/demo/content/templates/${draft.id}`);
    const submit = (await screen.findByRole('button', { name: 'Submit for review' })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
    expect(submit.getAttribute('data-demo-blocked')).toBe('true');
  });

  it('Journeys: the create dialog submit is disabled with the demo reason', async () => {
    await renderDemoAt('/demo/marketing/journeys');
    fireEvent.click(await screen.findByRole('button', { name: 'New journey' }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create draft' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
  });

  it('Templates: the create dialog submit is disabled with the demo reason', async () => {
    await renderDemoAt('/demo/content/templates');
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const dialog = await screen.findByRole('dialog');
    const create = within(dialog).getByRole('button', { name: 'Create draft' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(create.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
  });

  it('Integrations: the Hermes webhook switch and Delete action are disabled', async () => {
    await renderDemoAt('/demo/settings/integrations');
    fireEvent.click(await screen.findByRole('tab', { name: 'Webhooks' }));

    const toggle = (await screen.findByRole('switch', { name: 'Enable Hermes' })) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
    expect(toggle.getAttribute('data-demo-blocked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'More for Hermes' }));
    const remove = screen.getByRole('menuitem', { name: 'Delete' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
    expect(remove.getAttribute('data-demo-blocked')).toBe('true');
  });

  it('Users: role dropdowns are disabled, so a role change never submits', async () => {
    const { api } = await import('../../../app/api');
    const call = vi.spyOn(api, 'call');
    await renderDemoAt('/demo/settings/users');
    // Exactly one dropdown per rendered layout: the desktop table and the mobile list both mount,
    // and CSS picks one at a breakpoint, so the count is read from the DOM instead of guessed.
    const roles = (await screen.findAllByRole('combobox', { name: 'Role for Vic Chen' })) as HTMLSelectElement[];
    const layouts = (screen.queryByRole('table', { name: 'Members' }) ? 1 : 0) + (screen.queryByRole('list', { name: 'Members' }) ? 1 : 0);
    expect(layouts).toBeGreaterThan(0);
    expect(roles.length).toBe(layouts);

    // Page-load reads are not the dropdown's doing; only what happens after a change counts.
    call.mockClear();
    for (const role of roles) {
      expect(role.disabled).toBe(true);
      expect(role.getAttribute('title')).toBe(DEMO_RESTRICTION_REASON);
      expect(role.getAttribute('data-demo-blocked')).toBe('true');
      fireEvent.change(role, { target: { value: 'admin' } });
    }

    // A disabled dropdown does not fire onChange, so no command reaches the demo transport and no
    // request leaves the page; a regression shows up as a "Demo only" refusal toast instead.
    expect(call).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/Demo only/)).toBeNull();
    call.mockRestore();
  });

  it('leaves the same controls enabled outside the demo', async () => {
    // The shared primitive is the single switch: the default context keeps every page unchanged.
    const { Button } = await import('../../../ui');
    render(<Button mutation>Save</Button>);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
