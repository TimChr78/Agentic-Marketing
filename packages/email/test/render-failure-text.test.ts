import type { EmailTemplate } from '@agentic-marketing/artifacts';
import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { emailPublishProblems } from '../src/checks';
import { failureText, firstLine, TemplateError, templateRenderError } from '../src/render';
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

describe('Liquid’s own errors are the template’s, not the platform’s (#885 round 2)', () => {
  const cases: [string, string, RegExp][] = [
    ['a filter argument error (base64)', '{{ "!" | base64_decode }}', /base64/i],
    ['a missing filter argument (append)', '{{ "x" | append }}', /append/i],
    ['an include, which is disabled', '{% include "x" %}', /include|lookup/i],
    ['a render, which is disabled', '{% render "x" %}', /render|lookup/i],
  ];

  for (const [name, source, message] of cases) {
    it(`keeps ${name} as an AppError`, async () => {
      const ctx = context(fakeTx(template(`<mj-text>${source}</mj-text>`), 2, new Error(SECRET)));
      const err = (await previewTemplate.handler({ artifactId: TEMPLATE }, ctx).catch((e: unknown) => e)) as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.message).toContain('The template could not be rendered with this data');
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain('probe-secret');
    });
  }

  it('still lets our block resolver’s own error through Liquid as an unexpected failure', async () => {
    const ctx = context(fakeTx(template(`<mj-text>Hi</mj-text>{% block '${BLOCK}' %}`), 2, new Error(SECRET)));
    const err = (await previewTemplate.handler({ artifactId: TEMPLATE }, ctx).catch((e: unknown) => e)) as Error;
    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toContain('probe-secret');
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

describe('render failure text redaction order (#885 round 4)', () => {
  it('redacts a multi-line credential before keeping the first line', () => {
    const err = templateRenderError(new TemplateError('Block URL invalid: password="probe-secret\nrest"'), 'Render failed');
    expect(err).not.toBeNull();
    expect(err!.message).toContain('Block URL invalid');
    expect(err!.message).not.toContain('probe-secret');
  });

  it('firstLine never returns a credential split from its closing quote', () => {
    expect(firstLine('token="probe-secret\nrest"')).not.toContain('probe-secret');
    expect(firstLine('plain first line\nsecond')).toBe('plain first line');
  });

  it('bounds a first line even when nothing else does (#919)', () => {
    // 2 MB on one line: a misbehaving gateway echoing its body. No caller may store it whole.
    const huge = 'the gateway answered '.repeat(100_000);
    expect(huge.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(firstLine(huge).length).toBe(500);
  });
});

describe('the stored send-failure reason is bounded (#919)', () => {
  const huge = 'the gateway answered '.repeat(100_000);

  it('keeps at most 300 characters of a 2 MB single-line provider error', () => {
    const reason = `provider_error: ${failureText(huge)}`;
    expect(reason.length).toBeLessThanOrEqual(320);
    expect(reason.startsWith('provider_error: the gateway answered')).toBe(true);
  });

  it('redacts first, then takes the first line, then cuts', () => {
    const reason = `provider_error: ${failureText(`password=${'z'.repeat(4096)}\nsecond line`)}`;
    expect(reason).not.toContain('zzzz');
    expect(reason).toContain('password=[redacted]');
    expect(reason).not.toContain('second line');
  });
});
