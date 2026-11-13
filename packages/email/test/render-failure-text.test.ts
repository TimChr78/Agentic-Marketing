import type { EmailTemplate } from '@agentic-marketing/artifacts';
import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { emailPublishProblems } from '../src/checks';
import { checkTemplate, previewTemplate } from '../src/templates';

// #885: templates.preview, templates.check and the publish gate wrapped *every* failure of a render
// into an AppError. A block is resolved from the database while the template renders, so a database
// error became "The template could not be rendered with this data: <driver text>" — a message the
// caller reads and the audit log keeps. Only the template's own render failure is expected now.
const SECRET = 'driver failure: password=probe-secret';
const BLOCK = `blk_${'b'.repeat(32)}`;
const TEMPLATE = `eml_${'a'.repeat(32)}`;

const mjml = (inner: string) => `<mjml><mj-body><mj-section><mj-column>${inner}</mj-column></mj-section></mj-body></mjml>`;

const template = (inner: string): EmailTemplate =>
  ({ purpose: 'marketing_email', subject: 'Hi', mjml: mjml(inner) }) as unknown as EmailTemplate;

/**
 * Answers the version read, then the reads a render makes: `blockReadAt` is the call index of the
 * block resolver's lookup (2 for the preview, 3 for the check, which reads the purposes first).
 */
function fakeTx(content: EmailTemplate, blockReadAt: number, failure: unknown) {
  let calls = 0;
  const tx = {
    select: () => {
      calls += 1;
      const call = calls;
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: async () => [{ number: 1, content }] }),
          }),
          innerJoin: () => ({
            where: async () => {
              if (call === blockReadAt) throw failure;
              return [];
            },
          }),
        }),
      };
    },
  };
  return tx;
}

const context = (tx: unknown): CommandContext =>
  ({
    tx,
    principal: { workspaceId: 'ws_test', userId: 'usr_owner', type: 'user', permissions: new Set<string>() },
    services: {
      linksUrlFor: async () => 'https://links.example.com',
      email: { publicUrl: 'https://links.example.com' },
    },
  }) as unknown as CommandContext;

describe('templates.preview render failures (#885)', () => {
  it('lets a block resolver’s database error propagate', async () => {
    const ctx = context(fakeTx(template(`<mj-text>Hi</mj-text>{% block '${BLOCK}' %}`), 2, new Error(SECRET)));
    const err = (await previewTemplate.handler({ artifactId: TEMPLATE }, ctx).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });

  it('keeps the template’s own Liquid error, which the author can fix', async () => {
    const ctx = context(fakeTx(template('{% if %}'), 2, new Error(SECRET)));
    const err = (await previewTemplate.handler({ artifactId: TEMPLATE }, ctx).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('The template could not be rendered with this data');
    expect(err.message).not.toContain('probe-secret');
  });
});

describe('templates.check render failures (#885)', () => {
  it('lets a block resolver’s database error propagate', async () => {
    const ctx = context(fakeTx(template(`<mj-text>Hi</mj-text>{% block '${BLOCK}' %}`), 3, new Error(SECRET)));
    const err = (await checkTemplate.handler({ artifactId: TEMPLATE }, ctx).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });

  it('keeps the template’s own Liquid error, which the author can fix', async () => {
    const ctx = context(fakeTx(template('{% if %}'), 3, new Error(SECRET)));
    const err = (await checkTemplate.handler({ artifactId: TEMPLATE }, ctx).catch((e: unknown) => e)) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('The template could not be rendered with this data');
  });
});

describe('the publish gate’s render check (#885)', () => {
  const opts = (blocks: (id: string) => Promise<never>) => ({
    marketing: true,
    purposeChannels: ['email'],
    assets: async () => new Map(),
    render: { blocks },
  });

  it('lets a block resolver’s database error propagate instead of refusing a publish with it', async () => {
    const failure = new Error(SECRET);
    const err = (await emailPublishProblems(
      template(`<mj-text>Hi</mj-text>{% block '${BLOCK}' %}`),
      opts(async () => {
        throw failure;
      }),
    ).then(
      () => null,
      (e: unknown) => e,
    )) as Error | null;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AppError);
  });

  it('still refuses with the template’s own render problem', async () => {
    const problems = await emailPublishProblems(
      template('{% if %}'),
      opts(async () => [] as never),
    );
    expect(problems.join(' ')).toContain('the template could not be rendered for its checks');
    expect(problems.join(' ')).not.toContain('probe-secret');
  });
});
