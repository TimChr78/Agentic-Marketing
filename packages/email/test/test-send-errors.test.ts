import type { EmailTemplate } from '@agentic-marketing/artifacts';
import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #885 round 2: templates.sendTest copied a transport's or renderer's exception into the
// per-recipient `reason`, the skipped list and (when every copy failed) the AppError's message.
// A provider's own refusal is expected and stays; anything else becomes a fixed reason.

const SECRET = 'driver failure: password=probe-secret';

const state = vi.hoisted(() => ({
  sendError: null as Error | null,
  failFor: null as string | null,
  renderError: null as Error | null,
}));

vi.mock('../src/providers', () => ({
  transportFor: async () => ({
    async send(m: { to: string }) {
      if (state.sendError) throw state.sendError;
      if (state.failFor && m.to === state.failFor) throw new Error(SECRET);
      return { providerMessageId: 'pm_1' };
    },
    async close() {},
  }),
}));

vi.mock('../src/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/render')>();
  return {
    ...actual,
    renderTemplate: async (...args: Parameters<typeof actual.renderTemplate>) => {
      if (state.renderError) throw state.renderError;
      return actual.renderTemplate(...args);
    },
  };
});

vi.mock('@agentic-marketing/profiles', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentic-marketing/profiles')>();
  return {
    ...actual,
    personCrypto: () => ({ matchHash: async () => 'hash' }),
    profileForMessage: async () => null,
  };
});

const { ProviderSendError } = await import('../src/adapters');
const { sendTestMessages } = await import('../src/testSend');
const { TemplateError } = await import('../src/render');

const provider = {
  id: `epr_${'a'.repeat(32)}`,
  workspaceId: 'ws_test',
  name: 'Probe',
  adapter: 'cloudflare' as const,
  config: {},
  fromEmail: 'news@example.com',
  fromName: '',
  replyTo: null,
  useFor: ['transactional', 'marketing'],
  enabled: true,
};

/** The reads sendTestMessages makes: members, workspace seed list and the enabled provider. */
function fakeTx() {
  let messages = 0;
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.workspaceMembers) return [{ userId: 'usr_owner' }, { userId: 'usr_reader' }];
        return {
          where: async () => {
            if (table === schema.workspaces) return [{ id: 'ws_test', seedList: [] }];
            if (table === schema.emailProviders) return [provider];
            return [];
          },
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => [{ ...values, id: `msg_${++messages}`, status: values.status }],
      }),
    }),
    update: () => ({
      set: () => ({ where: async () => {} }),
    }),
  };
}

const context = (): CommandContext =>
  ({
    tx: fakeTx(),
    principal: { workspaceId: 'ws_test', userId: 'usr_owner', type: 'user', permissions: new Set<string>() },
    services: {
      directory: {
        users: async () =>
          new Map([
            ['usr_owner', { email: 'owner@example.com', name: 'Owner' }],
            ['usr_reader', { email: 'reader@example.com', name: 'Reader' }],
          ]),
      },
      linksUrlFor: async () => 'https://links.example.com',
      email: { publicUrl: 'https://links.example.com', links: { sign: () => 'signed' } },
    },
  }) as unknown as CommandContext;

const template = {
  purpose: 'marketing_email',
  subject: 'Hi',
  mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
} as unknown as EmailTemplate;

const opts = (to: string[]) => ({
  templateId: `eml_${'b'.repeat(32)}`,
  templateVersion: 1,
  template,
  purpose: 'marketing_email',
  stream: 'marketing' as const,
  to,
});

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

beforeEach(() => {
  state.sendError = null;
  state.failFor = null;
  state.renderError = null;
});

describe('test-send failures (#885 round 2)', () => {
  it('uses a fixed reason for an unexpected transport error on a partial send', async () => {
    state.failFor = 'reader@example.com';
    const result = await sendTestMessages(context(), opts(['owner@example.com', 'reader@example.com']));
    const failed = result.messages.find((m) => m.email === 'reader@example.com')!;
    expect(failed.status).toBe('failed');
    expect(failed.reason).toBe('provider_error: the provider did not accept the message');
    expect(result.skipped[0]?.reason).toBe('provider_error: the provider did not accept the message');
    expect(JSON.stringify(result)).not.toContain('probe-secret');
  });

  it('does not put an unexpected transport error into the all-failed AppError', async () => {
    state.sendError = new Error(SECRET);
    const err = (await rejection(sendTestMessages(context(), opts(['owner@example.com'])))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('refused the test e-mail');
    expect(err.message).not.toContain('probe-secret');
    expect(err.message).not.toContain('driver failure');
  });

  it('keeps a provider’s own typed refusal, with credentials redacted', async () => {
    state.sendError = new ProviderSendError(`Postmark refused the message: access_token=${SECRET}`);
    const err = (await rejection(sendTestMessages(context(), opts(['owner@example.com'])))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('Postmark refused the message');
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain('probe-secret');
  });

  it('redacts a multi-line provider refusal before keeping its first line (#885 round 3)', async () => {
    state.sendError = new ProviderSendError('Postmark refused the message: password="probe-secret\nrest"');
    const err = (await rejection(sendTestMessages(context(), opts(['owner@example.com'])))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('Postmark refused the message');
    expect(err.message).not.toContain('probe-secret');
  });

  it('uses a fixed render reason when rendering fails unexpectedly', async () => {
    state.renderError = new Error(SECRET);
    const err = (await rejection(sendTestMessages(context(), opts(['owner@example.com'])))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).not.toContain('probe-secret');
    expect(err.message).toContain('render_error: the template could not be rendered');
  });

  it('keeps the template’s own render error, which the author can fix', async () => {
    state.renderError = new TemplateError('The template needs a title.');
    const err = (await rejection(sendTestMessages(context(), opts(['owner@example.com'])))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('The template needs a title.');
  });
});
