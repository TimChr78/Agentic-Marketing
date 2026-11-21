import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { personCrypto } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import type { AdapterDeps } from '../src/adapters';
import { outbox } from '../src/adapters';
import { deliverOne, deliverRound, recoverUnhandledDelivery } from '../src/gateway';
import { linkSigner } from '../src/links';
import { MAX_ATTEMPTS } from '../src/outbox';
import { sealSecrets, webhookTokenHash } from '../src/providers';
import { deliverPush } from '../src/push/gateway';
import { deliverSms } from '../src/sms/gateway';

// #1054: one message whose handling throws an unexpected error must not abandon the messages
// claimed after it. A failure before any provider call goes back to `queued` with backoff and is
// retried; once the provider may have been reached, only that message fails, conservatively, as
// `unknown_outcome`.

const MASTER_KEY = Buffer.alloc(32, 61).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let templateId: string;
let providerId: string;

async function person(label: string): Promise<string> {
  const id = newId('prf');
  const email = `${label}@example.test`;
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: d.workspace, id, traits: { timezone: 'UTC' } });
    const crypto = personCrypto(tx, d.workspace, kp);
    await tx.insert(schema.identifiers).values({
      workspaceId: d.workspace,
      profileId: id,
      type: 'email',
      value: await crypto.matchHash('email', email),
      valueEnc: await crypto.seal(id, email),
    });
  });
  return id;
}

async function queuedMessage(profileId: string, createdAt: string): Promise<string> {
  const id = newId('msg');
  await d.db.admin.query(
    `INSERT INTO messages (workspace_id, id, idempotency_key, channel, profile_id, purpose, template_id, template_version, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'email', $4, 'onboarding', $5, 1, 'queued', $6, $6)`,
    [d.workspace, id, `idem-${id}`, profileId, templateId, createdAt],
  );
  return id;
}

const message = async (id: string) =>
  (
    await d.db.admin.query<{ status: string; reason: string | null; attempts: number; next_attempt_at: Date | null }>(
      'SELECT status, reason, attempts, next_attempt_at FROM messages WHERE workspace_id = $1 AND id = $2',
      [d.workspace, id],
    )
  ).rows[0]!;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('email_batch_isolation');
  kp = localKeyProvider(MASTER_KEY);
  templateId = newId('eml');
  providerId = newId('prv');
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.artifacts).values({
      workspaceId: d.workspace,
      id: templateId,
      type: 'email_template',
      name: 'Delivery isolation',
      latestVersion: 1,
      publishedVersion: 1,
    });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: d.workspace,
      artifactId: templateId,
      number: 1,
      state: 'published',
      content: {
        purpose: 'onboarding',
        subject: 'Hello',
        mjml: '<mjml><mj-body><mj-section><mj-column><mj-text>Hello<a href="{{ unsubscribe_url | raw }}">Unsubscribe</a></mj-text></mj-column></mj-section></mj-body></mjml>',
      },
      contentHash: 'hash-1',
      authorType: 'user',
      authorId: 'usr_test',
    });
    await tx.insert(schema.emailProviders).values({
      workspaceId: d.workspace,
      id: providerId,
      name: 'Outbox',
      adapter: 'log',
      config: {},
      fromEmail: 'hej@example.test',
      fromName: 'Test',
      useFor: ['transactional'],
      webhookTokenHash: webhookTokenHash(`held-${newId('prv')}`),
    });
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const email = (failFor?: string) => {
  const links = linkSigner('batch-isolation-test');
  return {
    publicUrl: 'https://links.example.test',
    links: {
      sign: (payload: object) => {
        if (failFor && (payload as { m?: string }).m === failFor) throw new Error('the key provider is unavailable');
        return links.sign(payload);
      },
      verify: links.verify,
    },
    adapterDeps: {} as AdapterDeps,
    trackClicks: false,
  };
};

describe.skipIf(!hasTestDatabase())('delivery batch isolation (#1054)', () => {
  it('retries a message that failed before the provider call and still sends the rest', async () => {
    outbox.length = 0;
    const first = await queuedMessage(await person('first'), '2026-01-01T00:00:00Z');
    const second = await queuedMessage(await person('second'), '2026-01-01T00:00:01Z');

    // The first message hits an unexpected dependency failure while it is prepared; the second
    // must still be attempted in the same round.
    const handled = await deliverRound(d.db, {
      kp,
      events: {} as EventStore,
      email: email(first),
    });

    expect(handled).toBe(2);
    const failed = await message(first);
    expect(failed).toMatchObject({ status: 'queued', attempts: 1 });
    expect(failed.reason).toMatch(/^delivery_error: /);
    expect(failed.next_attempt_at).not.toBeNull();

    const sent = await message(second);
    expect(sent.status).toBe('sent');
    expect(outbox.map((m) => m.messageId)).toEqual([second]);
  });

  it('never requeues a message whose provider send succeeded but whose outcome failed to commit', async () => {
    outbox.length = 0;
    const id = await queuedMessage(await person('accepted'), '2026-01-01T12:00:00Z');
    // A database blip on the first transaction after the provider accepted the message: the old
    // provider_error catch turned it back into `queued`, and the next round sent it again.
    let blipped = false;
    const db = new Proxy(d.db, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== 'withWorkspace') return typeof value === 'function' ? value.bind(target) : value;
        return (ws: string, fn: (tx: never) => Promise<unknown>) => {
          if (!blipped && outbox.length > 0) {
            blipped = true;
            return Promise.reject(new Error('connection terminated unexpectedly'));
          }
          return target.withWorkspace(ws, fn as never);
        };
      },
    });

    await deliverRound(db, { kp, events: {} as EventStore, email: email() });
    await d.db.admin.query('UPDATE messages SET next_attempt_at = now() WHERE workspace_id = $1 AND id = $2', [d.workspace, id]);
    await deliverRound(d.db, { kp, events: {} as EventStore, email: email() });

    expect(blipped).toBe(true);
    expect(outbox.filter((m) => m.messageId === id)).toHaveLength(1);
    const row = await message(id);
    expect(row.status).toBe('failed');
    expect(row.reason).toMatch(/^unknown_outcome: /);
  });

  it('never retries a message the provider may already have accepted', async () => {
    const id = await queuedMessage(await person('uncertain'), '2026-01-02T00:00:00Z');
    await d.db.admin.query(`UPDATE messages SET status = 'sending', attempts = 1 WHERE workspace_id = $1 AND id = $2`, [d.workspace, id]);

    await recoverUnhandledDelivery(d.db, d.workspace, id, { providerCalled: true, error: new Error('the commit failed') });

    const row = await message(id);
    expect(row).toMatchObject({ status: 'failed', next_attempt_at: null });
    expect(row.reason).toMatch(/^unknown_outcome: /);
  });

  it('leaves a message alone when its handler already recorded an outcome', async () => {
    const id = await queuedMessage(await person('settled'), '2026-01-03T00:00:00Z');
    await d.db.admin.query(`UPDATE messages SET status = 'sent', attempts = 1 WHERE workspace_id = $1 AND id = $2`, [d.workspace, id]);

    await recoverUnhandledDelivery(d.db, d.workspace, id, { providerCalled: false, error: new Error('close failed') });

    expect((await message(id)).status).toBe('sent');
  });

  it('stops retrying a safe failure once the attempt budget is spent', async () => {
    const id = await queuedMessage(await person('exhausted'), '2026-01-04T00:00:00Z');
    await d.db.admin.query(`UPDATE messages SET status = 'sending', attempts = $3 WHERE workspace_id = $1 AND id = $2`, [
      d.workspace,
      id,
      MAX_ATTEMPTS,
    ]);

    await recoverUnhandledDelivery(d.db, d.workspace, id, { providerCalled: false, error: new Error('still unavailable') });

    const row = await message(id);
    expect(row).toMatchObject({ status: 'failed', next_attempt_at: null });
    expect(row.reason).toMatch(/^delivery_error: /);
  });

  it('records a decision event when the stale sweep gives up on a stuck send (#1098)', async () => {
    // A worker stopped mid-send and never came back. The sweep is the only writer that settles
    // this row, so its outcome must be as visible to reports and guardrails as a per-message
    // recovery: the status and its event commit together.
    const id = await queuedMessage(await person('stale'), '2026-01-05T00:00:00Z');
    await d.db.admin.query(
      `UPDATE messages SET status = 'sending', attempts = 1, updated_at = now() - interval '11 minutes'
       WHERE workspace_id = $1 AND id = $2`,
      [d.workspace, id],
    );
    await d.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1', [d.workspace]);

    await deliverRound(d.db, { kp, events: {} as EventStore, email: email() });

    const row = await message(id);
    expect(row).toMatchObject({ status: 'failed', next_attempt_at: null });
    expect(row.reason).toMatch(/^unknown_outcome: /);
    const { rows } = await d.db.admin.query<{ payload: { events: { messageId: string; type: string; reason: string }[] } }>(
      `SELECT payload FROM outbox WHERE workspace_id = $1 AND kind = 'message_event'`,
      [d.workspace],
    );
    const recorded = rows
      .flatMap((entry) => entry.payload.events)
      .filter((event) => event.messageId === id)
      .map((event) => ({ type: event.type, reason: event.reason }));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.type).toBe('failed');
    expect(recorded[0]!.reason).toMatch(/^unknown_outcome: /);
  });
});

/** The decision events recorded for one message, oldest first. */
async function decisionEvents(messageId: string) {
  const { rows } = await d.db.admin.query<{ payload: { events: { messageId: string; type: string; reason: string }[] } }>(
    `SELECT payload FROM outbox WHERE workspace_id = $1 AND kind = 'message_event'`,
    [d.workspace],
  );
  return rows
    .flatMap((entry) => entry.payload.events)
    .filter((event) => event.messageId === messageId)
    .map((event) => ({ type: event.type, reason: event.reason }));
}

/** Replaces the enabled providers with one Postmark provider whose send the caller holds. */
async function slowProvider(): Promise<void> {
  await d.db.admin.query('UPDATE email_providers SET enabled = false WHERE workspace_id = $1', [d.workspace]);
  await d.db.withWorkspace(d.workspace, async (tx) => {
    const sealed = await sealSecrets(tx, d.workspace, kp, { serverToken: 'pm-server-token-1234567890' });
    await tx.insert(schema.emailProviders).values({
      workspaceId: d.workspace,
      id: newId('prv'),
      name: 'Postmark held',
      adapter: 'postmark',
      config: { transactionalStream: 'outbound' },
      ...sealed,
      fromEmail: 'hej@example.test',
      fromName: 'Test',
      useFor: ['transactional'],
      webhookTokenHash: webhookTokenHash(`held-${newId('prv')}`),
    });
  });
}

/**
 * A send that is still on the wire past the stale bound. A second delivery round then settles the
 * row as `unknown_outcome`; the first one finishes the send afterwards.
 */
async function sweptWhileSending(response: () => Response) {
  const id = await queuedMessage(await person(`slow-${Date.now()}`), '2026-01-06T00:00:00Z');
  await d.db.admin.query(`DELETE FROM messages WHERE workspace_id = $1 AND status = 'queued' AND id <> $2`, [d.workspace, id]);
  await d.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1', [d.workspace]);
  await slowProvider();

  let releaseSend!: () => void;
  const held = new Promise<void>((resolve) => (releaseSend = resolve));
  let reachedProvider!: () => void;
  const sending = new Promise<void>((resolve) => (reachedProvider = resolve));
  const fetchImpl = (async () => {
    reachedProvider();
    await held;
    return response();
  }) as typeof fetch;

  const round = deliverRound(d.db, { kp, events: {} as EventStore, email: { ...email(), adapterDeps: { fetch: fetchImpl } } });
  await sending;
  // The worker has been in the provider call longer than the stale bound, so a second round's
  // sweep settles the attempt as unknown_outcome while the first still holds the send.
  await d.db.admin.query(`UPDATE messages SET updated_at = now() - interval '11 minutes' WHERE workspace_id = $1 AND id = $2`, [
    d.workspace,
    id,
  ]);
  await deliverRound(d.db, { kp, events: {} as EventStore, email: email() });
  const swept = await message(id);
  expect(swept).toMatchObject({ status: 'failed', next_attempt_at: null });
  expect(swept.reason).toMatch(/^unknown_outcome: /);

  releaseSend();
  await round;
  return id;
}

describe.skipIf(!hasTestDatabase())('a send that finished after the stale sweep (#1098)', () => {
  it('keeps the sweep’s unknown_outcome when the provider then accepts the message', async () => {
    const id = await sweptWhileSending(
      () => new Response(JSON.stringify({ MessageID: 'pm-accepted' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    const row = await message(id);
    expect(row.status).toBe('failed');
    expect(row.reason).toMatch(/^unknown_outcome: /);
    // No phantom `sent` beside the sweep's `failed`: the sweep's row is all a person sees.
    expect((await decisionEvents(id)).map((event) => event.type)).toEqual(['failed']);
  }, 120_000);

  it('does not requeue a failure that arrived after the sweep', async () => {
    const id = await sweptWhileSending(
      () => new Response(JSON.stringify({ ErrorCode: 422, Message: 'provider refused' }), { status: 422 }),
    );

    const row = await message(id);
    expect(row.status).toBe('failed');
    expect(row.reason).toMatch(/^unknown_outcome: /);
    // A `queued` event would have scheduled a retry of a send that may already have happened.
    expect((await decisionEvents(id)).map((event) => event.type)).toEqual(['failed']);
  }, 120_000);
});

describe.skipIf(!hasTestDatabase())('a message the stale sweep took before delivery (#1148)', () => {
  it('is not sent and keeps the sweep’s outcome when the worker reaches it later', async () => {
    const first = await queuedMessage(await person('pre-first'), '2026-01-07T00:00:00Z');
    const second = await queuedMessage(await person('pre-second'), '2026-01-07T00:00:01Z');
    await d.db.admin.query(`DELETE FROM messages WHERE workspace_id = $1 AND status = 'queued' AND id NOT IN ($2, $3)`, [
      d.workspace,
      first,
      second,
    ]);
    await slowProvider();

    let calls = 0;
    let releaseSend!: () => void;
    const held = new Promise<void>((resolve) => (releaseSend = resolve));
    let reachedProvider!: () => void;
    const sending = new Promise<void>((resolve) => (reachedProvider = resolve));
    const fetchImpl = (async () => {
      calls++;
      reachedProvider();
      await held;
      return new Response(JSON.stringify({ MessageID: 'pm-first' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const round = deliverRound(d.db, { kp, events: {} as EventStore, email: { ...email(), adapterDeps: { fetch: fetchImpl } } });
    await sending;
    // Both rows were claimed; the first is still on the wire. Make the second look stuck and let
    // another round's sweep settle it before the first round reaches it.
    await d.db.admin.query(`UPDATE messages SET updated_at = now() - interval '11 minutes' WHERE workspace_id = $1 AND id = $2`, [
      d.workspace,
      second,
    ]);
    await deliverRound(d.db, { kp, events: {} as EventStore, email: email() });

    releaseSend();
    await round;

    // The provider was called for the first message only: the swept second one is skipped.
    expect(calls).toBe(1);
    expect((await message(first)).status).toBe('sent');
    const swept = await message(second);
    expect(swept).toMatchObject({ status: 'failed', next_attempt_at: null });
    expect(swept.reason).toMatch(/^unknown_outcome: /);
    // No phantom `suppressed`/`queued`/`sent` beside the sweep's `failed`.
    expect((await decisionEvents(second)).map((event) => event.type)).toEqual(['failed']);
  }, 120_000);

  it('does not revert a swept SMS message to queued or suppressed', async () => {
    const id = await queuedMessage(await person('pre-swept-sms'), '2026-01-08T00:00:00Z');
    const reason = 'unknown_outcome: the worker stopped while sending; check the provider before resending';
    await d.db.admin.query(`UPDATE messages SET status = 'failed', reason = $3, attempts = 1 WHERE workspace_id = $1 AND id = $2`, [
      d.workspace,
      id,
      reason,
    ]);
    await d.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1', [d.workspace]);

    await deliverSms(d.db, d.workspace, id, { kp, events: {} as EventStore, email: email() }, { providerCalled: false });

    expect(await message(id)).toMatchObject({ status: 'failed', reason });
    // The sweep's single decision stands; the late worker adds nothing.
    expect(await decisionEvents(id)).toEqual([]);
  });

  it('returns quietly instead of throwing when the row was deleted', async () => {
    const missing = newId('msg');
    const deps = { kp, events: {} as EventStore, email: email() };
    await expect(deliverSms(d.db, d.workspace, missing, deps)).resolves.toBeUndefined();
    await expect(deliverPush(d.db, d.workspace, missing, deps)).resolves.toBeUndefined();
    await expect(deliverOne(d.db, d.workspace, missing, deps, new Map(), { providerCalled: false })).resolves.toBeUndefined();
  });
});
