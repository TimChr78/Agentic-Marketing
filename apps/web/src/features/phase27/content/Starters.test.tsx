import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecipesPage from '../../../pages/build/RecipesPage';

type Call = { name: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  ready: true,
  empty: false,
  checkError: null as Error | null,
  installError: null as Error | null,
}));

vi.mock('../../../app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn(async (name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (name === 'recipes.list')
          return {
            recipes: h.empty
              ? []
              : [
                  {
                    id: `rcp_${'a'.repeat(32)}`,
                    title: 'Weekly newsletter',
                    description: 'A newsletter loop with confirmation.',
                    version: 1,
                    artifacts: 2,
                    parameters: 2,
                    prerequisites: 1,
                  },
                ],
          };
        if (name === 'recipes.get')
          return {
            recipe: {
              id: `rcp_${'a'.repeat(32)}`,
              title: 'Weekly newsletter',
              description: 'A newsletter loop with confirmation.',
              version: 1,
              artifacts: 2,
              parameters: [
                { key: 'newsletterName', label: 'Newsletter name', type: 'text', required: true, default: 'Northstar Journal' },
                {
                  key: 'confirmSubject',
                  label: 'Confirmation subject',
                  type: 'text',
                  required: true,
                  default: 'Please confirm your subscription',
                },
              ],
              prerequisites: [{ kind: 'purpose', description: 'A published marketing purpose' }],
              checklist: ['Review the confirmation e-mail', 'Check the send time'],
            },
          };
        if (name === 'recipes.preview') {
          if (h.checkError) throw h.checkError;
          return {
            ready: h.ready,
            prerequisites: [
              {
                kind: 'purpose',
                description: 'A published marketing purpose',
                ok: h.ready,
                message: h.ready ? '' : 'A required published purpose or template is missing.',
              },
            ],
            artifacts: [{ key: 'tpl_weekly', type: 'email_template', name: 'Weekly newsletter' }],
          };
        }
        if (name === 'recipes.install') {
          if (h.installError) throw h.installError;
          return { artifacts: [{ artifactId: `eml_${'b'.repeat(32)}`, name: 'Weekly newsletter' }] };
        }
        throw new Error(`unexpected command ${name}`);
      }),
    },
  };
});

vi.mock('../../../app/session', () => ({
  useWorkspace: () => ({ can: () => true }),
}));

const renderPage = () => render(<RecipesPage embedded />);

beforeEach(() => {
  h.calls = [];
  h.ready = true;
  h.empty = false;
  h.checkError = null;
  h.installError = null;
});
afterEach(cleanup);

describe('Starters gallery (#526)', () => {
  it('loads one list, then one detail and one resolved preview', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Start from an existing pattern' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Weekly newsletter/ })).toBeTruthy();
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'recipes.get')).toHaveLength(1));
    expect(h.calls.filter((c) => c.name === 'recipes.list')).toHaveLength(1);
    expect(h.calls.filter((c) => c.name === 'recipes.preview')).toHaveLength(1);
    expect(screen.getByLabelText(/^Newsletter name/)).toHaveProperty('value', 'Northstar Journal');
    expect(screen.getByLabelText(/^Confirmation subject/)).toHaveProperty('value', 'Please confirm your subscription');
    expect(screen.getByText('Review the confirmation e-mail')).toBeTruthy();
    expect(screen.getByText('Check the send time')).toBeTruthy();
    expect(screen.getByText('Nothing is published or sent by creating drafts.')).toBeTruthy();
  });

  it('checks prerequisites with one preview and keeps Create drafts unavailable while missing', async () => {
    h.ready = false;
    renderPage();
    await screen.findByRole('button', { name: /Weekly newsletter/ });
    await screen.findByRole('button', { name: 'Check prerequisites' });
    await waitFor(() => expect(screen.getByText('Missing')).toBeTruthy());
    const create = screen.getByRole('button', { name: 'Create drafts' });
    expect(create).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/A required published purpose or template is missing/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }));
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'recipes.preview')).toHaveLength(2));
  });

  it('reports a failed prerequisite check without losing the parameters', async () => {
    renderPage();
    await screen.findByRole('button', { name: /Weekly newsletter/ });
    await screen.findByRole('button', { name: 'Check prerequisites' });
    h.checkError = new Error('Network unavailable');
    await userEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }));
    expect(await screen.findByText('Could not check the starter prerequisites')).toBeTruthy();
    expect(screen.getByText(/Network unavailable/)).toBeTruthy();
    expect(screen.getByLabelText(/^Newsletter name/)).toHaveProperty('value', 'Northstar Journal');
  });

  it('installs drafts only and links each created draft', async () => {
    renderPage();
    await screen.findByRole('button', { name: /Weekly newsletter/ });
    const create = await screen.findByRole('button', { name: 'Create drafts' });
    await waitFor(() => expect(create).toHaveProperty('disabled', false));
    await userEvent.click(create);
    await waitFor(() => expect(h.calls.filter((c) => c.name === 'recipes.install')).toHaveLength(1));
    const alert = await screen.findByText('Created 1 drafts');
    expect(alert).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Weekly newsletter' });
    expect(link.getAttribute('href')).toBe(`/artifacts/eml_${'b'.repeat(32)}`);
    expect(screen.getByText(/nothing has been published/)).toBeTruthy();
  });

  it('shows the no-recipes state without inventing a starter', async () => {
    h.empty = true;
    renderPage();
    expect(await screen.findByText('No recipes')).toBeTruthy();
    expect(screen.getByText(/Create a template from scratch/)).toBeTruthy();
    // The empty list names its next action through the existing destination.
    expect(screen.getByRole('link', { name: 'Open e-mail templates' }).getAttribute('href')).toBe('/content/templates');
  });
});
