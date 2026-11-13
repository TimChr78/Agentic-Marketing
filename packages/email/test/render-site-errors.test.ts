import type { CommandContext } from '@agentic-marketing/commands';
import { AppError } from '@agentic-marketing/core';
import { describe, expect, it, vi } from 'vitest';

// #885: blocks.preview, smsTemplates.preview and pushTemplates.preview each caught every render
// failure and turned it into an AppError with its text. Only the template's own Liquid/MJML problem
// is expected; a database error, a bug or anything else must propagate to the executor, which
// answers and audits it as the fixed sanitised failure.
const SECRET = 'driver failure: password=probe-secret';

/** A switch per site, so one file can hold both the expected and the unexpected case. */
const state = vi.hoisted(() => ({
  blockFailure: null as Error | null,
  smsFailure: null as Error | null,
  pushFailure: null as Error | null,
}));

vi.mock('../src/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/render')>();
  return {
    ...actual,
    renderBlockFragment: async (...args: Parameters<typeof actual.renderBlockFragment>) => {
      if (state.blockFailure) throw state.blockFailure;
      return actual.renderBlockFragment(...args);
    },
  };
});

vi.mock('../src/sms/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sms/render')>();
  return {
    ...actual,
    renderSms: async (...args: Parameters<typeof actual.renderSms>) => {
      if (state.smsFailure) throw state.smsFailure;
      return actual.renderSms(...args);
    },
  };
});

vi.mock('../src/push/render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/push/render')>();
  return {
    ...actual,
    renderPush: async (...args: Parameters<typeof actual.renderPush>) => {
      if (state.pushFailure) throw state.pushFailure;
      return actual.renderPush(...args);
    },
  };
});

const { previewBlock } = await import('../src/blocks');
const { previewSms } = await import('../src/sms/commands');
const { previewPush } = await import('../src/push/commands');

const BLOCK = `blk_${'b'.repeat(32)}`;
const SMS = `sms_${'c'.repeat(32)}`;
const PUSH = `psh_${'d'.repeat(32)}`;

/** The version read, then the singleton and provider reads the previews make (empty). */
function fakeTx(content: unknown) {
  const versionRow = { number: 1, content };
  let calls = 0;
  const chain = {
    from: () => ({
      where: () => (calls === 1 ? Object.assign([], { orderBy: () => ({ limit: async () => [versionRow] }) }) : []),
      innerJoin: () => ({ where: async () => [] }),
    }),
  };
  return {
    select: () => {
      calls += 1;
      return chain;
    },
  };
}

const context = (tx: unknown): CommandContext =>
  ({
    tx,
    principal: { workspaceId: 'ws_test', userId: 'usr_owner', type: 'user', permissions: new Set<string>() },
  }) as unknown as CommandContext;

const rejection = <T>(promise: Promise<T>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('blocks.preview render failures (#885)', () => {
  const block = { category: 'section', mjml: '<mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section>', params: [] };

  it('lets an unexpected render failure propagate', async () => {
    state.blockFailure = new Error(SECRET);
    try {
      const err = (await rejection(previewBlock.handler({ artifactId: BLOCK }, context(fakeTx(block))))) as Error | null;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppError);
    } finally {
      state.blockFailure = null;
    }
  });

  it('keeps the block’s own Liquid error', async () => {
    const broken = { ...block, mjml: '<mj-section>{% if %}</mj-section>' };
    const err = (await rejection(previewBlock.handler({ artifactId: BLOCK }, context(fakeTx(broken))))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('The block could not be rendered');
  });
});

describe('smsTemplates.preview render failures (#885)', () => {
  const sms = { purpose: 'service_sms', body: 'Your order shipped.' };

  it('lets an unexpected render failure propagate', async () => {
    state.smsFailure = new Error(SECRET);
    try {
      const err = (await rejection(previewSms.handler({ artifactId: SMS }, context(fakeTx(sms))))) as Error | null;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppError);
    } finally {
      state.smsFailure = null;
    }
  });

  it('keeps the template’s own Liquid error', async () => {
    const err = (await rejection(previewSms.handler({ artifactId: SMS }, context(fakeTx({ ...sms, body: '{% if %}' }))))) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('The template could not be rendered with this data');
  });
});

describe('pushTemplates.preview render failures (#885)', () => {
  const push = { purpose: 'service_push', title: 'Shipped', body: 'Your order is on its way.' };

  it('lets an unexpected render failure propagate', async () => {
    state.pushFailure = new Error(SECRET);
    try {
      const err = (await rejection(previewPush.handler({ artifactId: PUSH }, context(fakeTx(push))))) as Error | null;
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppError);
    } finally {
      state.pushFailure = null;
    }
  });

  it('keeps a link that is not http(s), which the author can fix', async () => {
    const err = (await rejection(
      previewPush.handler({ artifactId: PUSH }, context(fakeTx({ ...push, url: 'example.com/orders' }))),
    )) as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toContain('is not an http(s) URL');
  });
});
