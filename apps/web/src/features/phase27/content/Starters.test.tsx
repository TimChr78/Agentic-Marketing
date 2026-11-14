import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecipesPage from '../../../pages/build/RecipesPage';

type Call = { name: string; input: Record<string, unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Call[],
  ready: true,
  empty: false,
  two: false,
  // The selection race tests resolve the detail reads immediately and hold the action they test.
  fastGet: false,
  holdPreview: false,
  previewHeld: [] as { recipeId: string; resolve: (value: unknown) => void }[],
  holdInstall: false,
  installHeld: [] as { recipeId: string; resolve: (value: unknown) => void }[],
  held: [] as { which: 'A' | 'B'; resolve: (value: unknown) => void }[],
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
              : h.two
                ? [
                    {
                      id: `rcp_${'a'.repeat(32)}`,
                      title: 'Starter A',
                      description: 'The first starter.',
                      version: 1,
                      artifacts: 1,
                      parameters: 1,
                      prerequisites: 0,
                    },
                    {
                      id: `rcp_${'b'.repeat(32)}`,
                      title: 'Starter B',
                      description: 'The second starter.',
                      version: 1,
                      artifacts: 1,
                      parameters: 1,
                      prerequisites: 0,
                    },
                  ]
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
        if (name === 'recipes.get') {
          // With two starters the reads are held, so the test decides the order they resolve in.
          if (h.two && !h.fastGet) {
            const which = input.recipeId === `rcp_${'b'.repeat(32)}` ? ('B' as const) : ('A' as const);
            return new Promise((resolve) => h.held.push({ which, resolve }));
          }
          if (h.two) {
            const isB = input.recipeId === `rcp_${'b'.repeat(32)}`;
            return {
              recipe: {
                id: input.recipeId,
                title: isB ? 'Starter B' : 'Starter A',
                description: isB ? 'The second starter.' : 'The first starter.',
                version: 1,
                artifacts: 1,
                parameters: [
                  {
                    key: isB ? 'bParam' : 'aParam',
                    label: isB ? 'B parameter' : 'A parameter',
                    type: 'text',
                    required: true,
                    default: isB ? 'B value' : 'A value',
                  },
                ],
                prerequisites: [],
                checklist: [],
              },
            };
          }
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
        }
        if (name === 'recipes.preview') {
          if (h.checkError) throw h.checkError;
          if (h.holdPreview) return new Promise((resolve) => h.previewHeld.push({ recipeId: String(input.recipeId), resolve }));
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
          if (h.holdInstall) return new Promise((resolve) => h.installHeld.push({ recipeId: String(input.recipeId), resolve }));
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
  h.two = false;
  h.fastGet = false;
  h.holdPreview = false;
  h.previewHeld = [];
  h.holdInstall = false;
  h.installHeld = [];
  h.held = [];
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

  it('lets only the latest selection commit when an earlier read resolves last (#616)', async () => {
    h.two = true;
    renderPage();
    expect(await screen.findByRole('button', { name: /Starter A/ })).toBeTruthy();
    // The first selection starts its detail read; it stays in flight.
    await waitFor(() => expect(h.held).toHaveLength(1));
    expect(h.held[0].which).toBe('A');

    await userEvent.click(screen.getByRole('button', { name: /Starter B/ }));
    await waitFor(() => expect(h.held).toHaveLength(2));
    expect(h.held[1].which).toBe('B');

    // The newly selected starter shows its own loading state, never the old form.
    expect(screen.getByLabelText('Loading the starter')).toBeTruthy();
    expect(screen.queryByLabelText(/^A parameter/)).toBeNull();

    // B arrives first and commits.
    await act(async () => {
      h.held[1].resolve({
        recipe: {
          id: `rcp_${'b'.repeat(32)}`,
          title: 'Starter B',
          description: 'The second starter.',
          version: 1,
          artifacts: 1,
          parameters: [{ key: 'bParam', label: 'B parameter', type: 'text', required: true, default: 'B value' }],
          prerequisites: [],
          checklist: [],
        },
      });
    });
    await waitFor(() => expect(screen.getByLabelText(/^B parameter/)).toHaveProperty('value', 'B value'));

    // A resolves last but must not overwrite the selection that is now active.
    await act(async () => {
      h.held[0].resolve({
        recipe: {
          id: `rcp_${'a'.repeat(32)}`,
          title: 'Starter A',
          description: 'The first starter.',
          version: 1,
          artifacts: 1,
          parameters: [{ key: 'aParam', label: 'A parameter', type: 'text', required: true, default: 'A value' }],
          prerequisites: [],
          checklist: [],
        },
      });
    });

    await waitFor(() => expect(screen.getByLabelText(/^B parameter/)).toHaveProperty('value', 'B value'));
    expect(screen.queryByLabelText(/^A parameter/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Starter B' })).toBeTruthy();
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

  it('discards a prerequisite check that resolves after another starter is selected (#792)', async () => {
    h.two = true;
    h.fastGet = true;
    renderPage();
    await screen.findByRole('button', { name: /Starter A/ });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Starter A' })).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', false));

    // Start A's explicit check and keep it in flight.
    h.holdPreview = true;
    await userEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }));
    await waitFor(() => expect(h.previewHeld).toHaveLength(1));
    expect(h.previewHeld[0].recipeId).toBe(`rcp_${'a'.repeat(32)}`);

    // Select B while A's check is pending: B's own preview is read and resolves first.
    await userEvent.click(screen.getByRole('button', { name: /Starter B/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Starter B' })).toBeTruthy());
    await waitFor(() => expect(h.previewHeld).toHaveLength(2));
    expect(h.previewHeld[1].recipeId).toBe(`rcp_${'b'.repeat(32)}`);
    await act(async () => {
      h.previewHeld[1].resolve({
        ready: false,
        prerequisites: [{ kind: 'purpose', description: 'B purpose', ok: false, message: 'B is missing a purpose.' }],
        artifacts: [{ key: 'tpl_b', type: 'email_template', name: 'Starter B draft' }],
      });
    });
    await screen.findByText('B is missing a purpose.');

    // A's slower response must not land under B.
    await act(async () => {
      h.previewHeld[0].resolve({
        ready: true,
        prerequisites: [{ kind: 'purpose', description: 'A purpose', ok: true, message: '' }],
        artifacts: [{ key: 'tpl_a', type: 'email_template', name: 'Starter A draft' }],
      });
    });
    await act(async () => {});
    expect(screen.queryByText('Starter A draft')).toBeNull();
    expect(screen.queryByText('Everything is in place.')).toBeNull();
    expect(screen.getByText('One or more prerequisites are missing.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', true);
  });

  it('discards created drafts that resolve after another starter is selected (#792)', async () => {
    h.two = true;
    h.fastGet = true;
    renderPage();
    await screen.findByRole('button', { name: /Starter A/ });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', false));

    // Start A's install and keep it in flight.
    h.holdInstall = true;
    await userEvent.click(screen.getByRole('button', { name: 'Create drafts' }));
    await waitFor(() => expect(h.installHeld).toHaveLength(1));
    expect(h.installHeld[0].recipeId).toBe(`rcp_${'a'.repeat(32)}`);

    await userEvent.click(screen.getByRole('button', { name: /Starter B/ }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Starter B' })).toBeTruthy());

    await act(async () => {
      h.installHeld[0].resolve({ artifacts: [{ artifactId: `eml_${'f'.repeat(32)}`, name: 'Starter A draft' }] });
    });
    await act(async () => {});
    expect(screen.queryByText(/Created 1 drafts/)).toBeNull();
    expect(screen.queryByText('Starter A draft')).toBeNull();
  });

  // #933: a parameter edit invalidates the derived state, exactly as a selection change does. The
  // screen once kept the old parameters' "Everything is in place", prerequisites and enabled
  // Create drafts, and two checks could overwrite each other because only `load()` moved the
  // sequence.
  const editParam = async (value: string) => {
    const input = screen.getByLabelText(/^Newsletter name/);
    await userEvent.clear(input);
    await userEvent.type(input, value);
  };

  it('drops the previous parameters’ check and readiness when a parameter changes', async () => {
    renderPage();
    await screen.findByRole('button', { name: /Weekly newsletter/ });
    await waitFor(() => expect(screen.getByText('Everything is in place.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('heading', { name: 'Prerequisites' })).toBeTruthy();

    await editParam('Fjeldvej');

    expect(screen.queryByText('Everything is in place.')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Prerequisites' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', true);

    // A new check computes for the current parameters and restores readiness.
    await userEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }));
    await waitFor(() => expect(screen.getByText('Everything is in place.')).toBeTruthy());
    expect(h.calls.filter((c) => c.name === 'recipes.preview').at(-1)?.input.params).toMatchObject({ newsletterName: 'Fjeldvej' });
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', false);
  });

  it('keeps a slow check for the old parameters off the screen after an edit', async () => {
    renderPage();
    await screen.findByRole('button', { name: /Weekly newsletter/ });
    await waitFor(() => expect(screen.getByText('Everything is in place.')).toBeTruthy());

    h.holdPreview = true;
    await userEvent.click(screen.getByRole('button', { name: 'Check prerequisites' }));
    await waitFor(() => expect(h.previewHeld).toHaveLength(1));

    await editParam('Fjeldvej');
    await act(async () => {
      h.previewHeld[0].resolve({
        ready: true,
        prerequisites: [{ kind: 'purpose', description: 'Old purpose', ok: true, message: '' }],
        artifacts: [{ key: 'tpl_old', type: 'email_template', name: 'Old parameters draft' }],
      });
    });
    await act(async () => {});

    expect(screen.queryByText('Everything is in place.')).toBeNull();
    expect(screen.queryByText('Old parameters draft')).toBeNull();
    expect(screen.queryByText('Old purpose')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', true);
  });

  it('lets only the latest of two checks in flight commit', async () => {
    renderPage();
    await screen.findByRole('button', { name: /Weekly newsletter/ });
    await waitFor(() => expect(screen.getByText('Everything is in place.')).toBeTruthy());

    // Two clicks in one tick, before the button can paint its loading state: both checks run.
    h.holdPreview = true;
    const button = screen.getByRole('button', { name: 'Check prerequisites' });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(h.previewHeld).toHaveLength(2));

    const [older, newer] = h.previewHeld;
    await act(async () => {
      newer.resolve({
        ready: false,
        prerequisites: [{ kind: 'purpose', description: 'New purpose', ok: false, message: 'The newest check says a purpose is missing.' }],
        artifacts: [{ key: 'tpl_new', type: 'email_template', name: 'Newest check draft' }],
      });
    });
    await screen.findByText('The newest check says a purpose is missing.');

    // The older check resolves last; its result belongs to no current request.
    await act(async () => {
      older.resolve({
        ready: true,
        prerequisites: [{ kind: 'purpose', description: 'Old purpose', ok: true, message: '' }],
        artifacts: [{ key: 'tpl_old', type: 'email_template', name: 'Older check draft' }],
      });
    });
    await act(async () => {});

    expect(screen.queryByText('Older check draft')).toBeNull();
    expect(screen.queryByText('Everything is in place.')).toBeNull();
    expect(screen.getByText('The newest check says a purpose is missing.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', true);
  });

  it('does not show an install success under parameters it was not run for', async () => {
    renderPage();
    await screen.findByRole('button', { name: /Weekly newsletter/ });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', false));

    h.holdInstall = true;
    await userEvent.click(screen.getByRole('button', { name: 'Create drafts' }));
    await waitFor(() => expect(h.installHeld).toHaveLength(1));

    await editParam('Fjeldvej');
    await act(async () => {
      h.installHeld[0].resolve({ artifacts: [{ artifactId: `eml_${'e'.repeat(32)}`, name: 'Old parameters draft' }] });
    });
    await act(async () => {});

    expect(screen.queryByText(/Created 1 drafts/)).toBeNull();
    expect(screen.queryByText('Old parameters draft')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveProperty('disabled', true);
  });
});
