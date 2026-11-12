import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Deferred, deferred, settle } from './keyedReadsSupport';

// #612: the approval and token drawers are reused when the URL id changes. They must withhold the
// previous entity and its actions until the read for the id in the address bar has landed.

const h = vi.hoisted(() => ({
  impl: null as null | ((name: string, input: Record<string, unknown>) => Promise<unknown>),
  calls: [] as { name: string; input: Record<string, unknown> }[],
}));

vi.mock('../src/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/app/api')>();
  return {
    ...actual,
    api: {
      call: vi.fn((name: string, input: Record<string, unknown>) => {
        h.calls.push({ name, input });
        if (!h.impl) throw new Error(`unexpected command ${name}`);
        return h.impl(name, input);
      }),
    },
  };
});

vi.mock('../src/app/session', () => ({
  useSession: () => ({ can: () => true, user: { id: 'usr_admin' } }),
  useWorkspace: () => ({
    can: () => true,
    user: { id: 'usr_admin' },
    workspace: { id: 'ws_1', approvalPolicy: 'agent_changes', you: { role: 'owner', permissions: ['workspace:admin', 'artifacts:read'] } },
  }),
}));

import { ApprovalDrawer } from '../src/features/approvals/ApprovalDrawer';
import { TokenDrawer } from '../src/features/tokens/TokenDrawer';
import { ToastProvider } from '../src/ui/toast';

const requester = { kind: 'person', displayName: 'Sam Builder', personName: 'Sam Builder', tokenName: null, clientName: null };

const approval = (id: string, artifactName: string, artifactId: string) => ({
  id,
  artifactId,
  artifactName,
  artifactType: 'form',
  version: 1,
  status: 'pending',
  requestedBy: { type: 'user', id: 'usr_builder' },
  requester,
  note: '',
  decidedBy: null,
  decisionNote: null,
  createdAt: '2026-11-06T09:00:00.000Z',
  holdUntil: null,
  artifactLatestVersion: 1,
  artifactPublishedVersion: null,
  publishedVersion: null,
  reviewUrl: null,
  bundle: null,
  content: {
    purposes: ['marketing_email'],
    doubleOptIn: true,
    consentText: 'Yes, send me the newsletter.',
    traits: ['firstName'],
    successUrl: 'https://martechsignal.example/thanks',
    allowedOrigins: [],
  },
  publishedContent: null,
  diff: { from: null, to: 1, changes: [] },
  history: [],
});

const token = (id: string, name: string) => ({
  id,
  workspaceId: 'ws_1',
  workspaceName: 'Brand',
  name,
  userId: 'usr_admin',
  ownerName: 'Admin',
  owner: { id: 'usr_admin', name: 'Admin', email: 'admin@example.com' },
  tokenHint: 'amk_1234…abcd',
  scopes: ['artifacts:read'],
  createdAt: '2026-11-01T09:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
  revoked: false,
  history: [],
});

const APR_A = `apr_${'a'.repeat(32)}`;
const APR_B = `apr_${'b'.repeat(32)}`;
const TOK_A = `tok_${'a'.repeat(32)}`;
const TOK_B = `tok_${'b'.repeat(32)}`;

let approvalB: Deferred<unknown>;
let tokenB: Deferred<unknown>;

beforeEach(() => {
  h.calls.length = 0;
  approvalB = deferred();
  tokenB = deferred();
  h.impl = (name, input) => {
    if (name === 'approvals.get') {
      if (input.approvalId === APR_B) return approvalB.promise;
      return Promise.resolve(approval(APR_A, 'Alpha approval', `frm_${'1'.repeat(32)}`));
    }
    if (name === 'purposes.list') return Promise.resolve({ source: 'published', purposes: [] });
    if (name === 'apiTokens.get') {
      if (input.id === TOK_B) return tokenB.promise;
      return Promise.resolve(token(TOK_A, 'Alpha token'));
    }
    throw new Error(`unexpected command ${name}`);
  };
});

afterEach(cleanup);

const drawApproval = (id: string) =>
  render(
    <ToastProvider>
      <ApprovalDrawer id={id} queue={[APR_A, APR_B]} onClose={() => {}} onDecided={() => {}} />
    </ToastProvider>,
  );

const drawToken = (id: string) =>
  render(
    <ToastProvider>
      <TokenDrawer id={id} onClose={() => {}} onChanged={() => {}} />
    </ToastProvider>,
  );

describe('approval drawer follows the id in the address bar (#612)', () => {
  it('shows no previous approval or decision while the next one loads', async () => {
    const view = drawApproval(APR_A);
    expect(await screen.findByText('Alpha approval')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Approve and publish/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Reject$/ })).toBeTruthy();

    view.rerender(
      <ToastProvider>
        <ApprovalDrawer id={APR_B} queue={[APR_A, APR_B]} onClose={() => {}} onDecided={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.queryByText('Alpha approval')).toBeNull());
    expect(screen.getByRole('status', { name: 'Loading the approval request' })).toBeTruthy();
    // A decision during the pending read would act on the previous id, so no action is offered.
    expect(screen.queryByRole('button', { name: /Approve and publish/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject$/ })).toBeNull();

    await settle(approvalB, approval(APR_B, 'Beta approval', `frm_${'2'.repeat(32)}`));

    expect(await screen.findByText('Beta approval')).toBeTruthy();
    expect(screen.queryByText('Alpha approval')).toBeNull();
    expect(screen.getByRole('button', { name: /Approve and publish/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Reject$/ })).toBeTruthy();
  });
});

describe('token drawer follows the id in the address bar (#612)', () => {
  it('shows no previous token or revoke action while the next one loads', async () => {
    const view = drawToken(TOK_A);
    expect(await screen.findByText('Alpha token')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();

    view.rerender(
      <ToastProvider>
        <TokenDrawer id={TOK_B} onClose={() => {}} onChanged={() => {}} />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.queryByText('Alpha token')).toBeNull());
    expect(screen.getByRole('status', { name: 'Loading the token' })).toBeTruthy();
    // Revoke reads the token on screen, so it must not be clickable for the previous one.
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();

    await settle(tokenB, token(TOK_B, 'Beta token'));

    expect(await screen.findByText('Beta token')).toBeTruthy();
    expect(screen.queryByText('Alpha token')).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
  });
});
