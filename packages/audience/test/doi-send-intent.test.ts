import { newId } from '@agentic-marketing/core';
import { enqueueOutbox, schema } from '@agentic-marketing/db';
import { linkSigner } from '@agentic-marketing/email';
import type { BusEvent, EventBus, EventStore, MessageEvent } from '@agentic-marketing/events';
import { personCrypto } from '@agentic-marketing/profiles';
import { localKeyProvider, recordingKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { consentHook, dispatchOutboxOnce, SUBMITTED } from '../src';

// #978 part 2: a double opt-in form submission writes a durable send intent in the consent
// transaction and the dispatcher calls requestEmail after commit. The consent batch therefore
// makes no key-provider or ClickHouse call, a rollback leaves no send pending, and a redelivery
// (or a dispatcher crash after the send) never sends a second confirmation.

const MASTER_KEY = Buffer.alloc(32, 17).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof recordingKeyProvider>;
let recorder: ReturnType<typeof recordingKeyProvider>;
let links: ReturnType<typeof linkSigner>;
let templateId: string;
let formId: string;
const formVersion = 1;
let profileId: string;

const sent: MessageEvent[] = [];
let clickhouseBlocked = true;
const events = {
  async insertMessageEvents(list: MessageEvent[]) {
    if (clickhouseBlocked) throw new Error('ClickHouse unavailable');
    sent.push(...list);
  },
} as unknown as EventStore;

/** The segment-change publisher the dispatcher needs; this file has no segment rows. */
const bus = { async publish() {} } as unknown as EventBus;

const formEvent = (doubleOptIn = true, messageId = newId('evt')): BusEvent => ({
  workspaceId: d.workspace,
  sourceId: formId,
  messageId,
  type: 'track',
  name: SUBMITTED,
  anonymousId: 'anon_doi',
  userId: profileId,
  timestamp: new Date().toISOString(),
  receivedAt: new Date().toISOString(),
  properties: {
    form_id: formId,
    form_version: formVersion,
    double_opt_in: doubleOptIn,
    purposes: ['marketing_email'],
    consent_text: 'Send me the newsletter.',
  },
  traits: {},
  piiTraits: {},
  context: {},
  consent: {},
});

const hook = () =>
  consentHook({
    db: d.db,
    links,
    linksUrl: 'https://links.test',
    linksUrlFor: async () => 'https://brand.test',
  });

const intentRows = async () => {
  const { rows } = await d.db.admin.query<{ operation_key: string; payload: { data?: { confirm_url?: string } } }>(
    `SELECT operation_key, payload FROM outbox WHERE workspace_id = $1 AND kind = 'doi_send' ORDER BY created_at`,
    [d.workspace],
  );
  return rows;
};

const messagesForKey = async (key: string) =>
  (
    await d.db.admin.query<{ id: string; status: string }>(
      'SELECT id, status FROM messages WHERE workspace_id = $1 AND idempotency_key = $2',
      [d.workspace, key],
    )
  ).rows;

async function artifact(type: 'email_template' | 'form', content: Record<string, unknown>) {
  const id = newId(type === 'form' ? 'frm' : 'eml');
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.artifacts).values({
      workspaceId: d.workspace,
      id,
      type,
      name: type,
      latestVersion: 1,
      publishedVersion: 1,
    });
    await tx.insert(schema.artifactVersions).values({
      workspaceId: d.workspace,
      artifactId: id,
      number: 1,
      state: 'published',
      content,
      contentHash: `hash-${id}`,
      authorType: 'user',
      authorId: 'usr_test',
    });
  });
  return id;
}

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('doi_outbox');
  recorder = recordingKeyProvider(localKeyProvider(MASTER_KEY));
  kp = recorder;
  links = linkSigner('doi-outbox-test-secret');
  profileId = newId('prf');
  await d.db.withWorkspace(d.workspace, async (tx) => {
    await tx.insert(schema.profiles).values({ workspaceId: d.workspace, id: profileId });
    const crypto = personCrypto(tx, d.workspace, kp);
    const email = 'doi@example.com';
    await tx.insert(schema.identifiers).values({
      workspaceId: d.workspace,
      profileId,
      type: 'email',
      value: await crypto.matchHash('email', email),
      valueEnc: await crypto.seal(profileId, email),
    });
  });
  templateId = await artifact('email_template', {
    purpose: 'onboarding',
    subject: 'Confirm your subscription',
    mjml: '<mjml><mj-body><mj-section><mj-column><mj-text><a href="{{ confirm_url | raw }}">Confirm</a></mj-text></mj-column></mj-section></mj-body></mjml>',
  });
  formId = await artifact('form', {
    purposes: ['marketing_email'],
    doubleOptIn: true,
    confirmationTemplate: templateId,
    consentText: 'Send me the newsletter.',
    successUrl: '/check-inbox',
  });
}, 120_000);

afterAll(async () => {
  await d?.close();
});

beforeEach(async () => {
  sent.length = 0;
  clickhouseBlocked = true;
  recorder.reset();
  // Each case starts with an empty queue: the intent it writes is the only work due.
  if (d) {
    await d.db.admin.query('DELETE FROM outbox WHERE workspace_id = $1', [d.workspace]);
    await d.db.admin.query('DELETE FROM messages WHERE workspace_id = $1', [d.workspace]);
    await d.db.admin.query('DELETE FROM consent_records WHERE workspace_id = $1', [d.workspace]);
  }
});

describe.skipIf(!hasTestDatabase())('double opt-in send intents (#978 part 2)', () => {
  it('writes one intent in the consent transaction without a key-provider or ClickHouse call', async () => {
    const messageId = newId('evt');
    const submission = formEvent(false, messageId);
    const doi = formEvent(true, messageId);
    // One batch: a plain consent record and a double opt-in submission.
    await hook()(d.workspace, [
      { event: submission, profileId },
      { event: doi, profileId },
    ]);

    // The consent evidence committed; the only send is a durable intent, not a message yet.
    const records = await d.db.admin.query('SELECT status FROM consent_records WHERE workspace_id = $1', [d.workspace]);
    expect(records.rows).toEqual([{ status: 'granted' }]);
    expect(recorder.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    const intents = await intentRows();
    expect(intents).toHaveLength(1);
    expect(intents[0]!.operation_key).toBe(`doi:${messageId}`);
    // The link host was resolved and the signed link prepared before the transaction.
    expect(intents[0]!.payload.data?.confirm_url).toMatch(/^https:\/\/brand\.test\/f\/confirm\//);
    expect(await messagesForKey(`doi:${messageId}`)).toHaveLength(0);
  });

  it('a redelivered submission adds no second intent', async () => {
    const event = formEvent(true);
    await hook()(d.workspace, [{ event, profileId }]);
    await hook()(d.workspace, [
      { event, profileId },
      { event, profileId },
    ]);
    expect((await intentRows()).filter((r) => r.operation_key === `doi:${event.messageId}`)).toHaveLength(1);
  });

  it('sends once and publishes the decision event through the outbox', async () => {
    const event = formEvent(true);
    const key = `doi:${event.messageId}`;
    await hook()(d.workspace, [{ event, profileId }]);

    clickhouseBlocked = false;
    const first = await dispatchOutboxOnce({ db: d.db, kp, events, bus });
    expect(first).toMatchObject({ claimed: 1, delivered: 1 });
    const [message] = await messagesForKey(key);
    expect(message).toMatchObject({ status: 'queued' });

    // The decision event is itself an outbox row; the next round publishes it.
    const second = await dispatchOutboxOnce({ db: d.db, kp, events, bus });
    expect(second.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    const eventId = sent[0]!.eventId;
    expect(eventId).toMatch(/^decision:queued:0$/);

    // A dispatcher that died after sending redelivers the intent: requestEmail replays on its key,
    // so no second message exists, and the decision event keeps its stable id.
    await d.db.admin.query(
      `UPDATE outbox SET state = 'pending', lease_until = NULL, delivered_at = NULL WHERE workspace_id = $1 AND kind = 'doi_send' AND operation_key = $2`,
      [d.workspace, key],
    );
    await d.db.admin.query(
      `UPDATE outbox SET state = 'pending', lease_until = NULL, delivered_at = NULL WHERE workspace_id = $1 AND kind = 'message_event'`,
      [d.workspace],
    );
    await dispatchOutboxOnce({ db: d.db, kp, events, bus });
    await dispatchOutboxOnce({ db: d.db, kp, events, bus });
    expect(await messagesForKey(key)).toHaveLength(1);
    expect(sent.map((e) => e.eventId)).toEqual([eventId, eventId]);
  });

  it('two overlapping dispatchers send one confirmation', async () => {
    const event = formEvent(true);
    const key = `doi:${event.messageId}`;
    await hook()(d.workspace, [{ event, profileId }]);
    clickhouseBlocked = false;
    // Both rounds claim with SKIP LOCKED, and whichever runs the handler uses the intent's own
    // `doi:<message>` key, which requestEmail serialises and replays.
    await Promise.all([dispatchOutboxOnce({ db: d.db, kp, events, bus }), dispatchOutboxOnce({ db: d.db, kp, events, bus })]);
    expect(await messagesForKey(key)).toHaveLength(1);
  });

  it('fails a DOI intent without an idempotency key permanently, without sending', async () => {
    await d.db.withWorkspace(d.workspace, (tx) =>
      enqueueOutbox(tx, d.workspace, {
        kind: 'doi_send',
        operationKey: 'doi:missing-key',
        payload: { profileId, templateId, requestHash: 'hash-without-key' },
      }),
    );
    clickhouseBlocked = false;
    const result = await dispatchOutboxOnce({ db: d.db, kp, events, bus });
    expect(result.failed).toBe(1);
    expect(await messagesForKey('doi:missing-key')).toHaveLength(0);
    const { rows } = await d.db.admin.query<{ state: string; failure_kind: string }>(
      `SELECT state, failure_kind FROM outbox WHERE workspace_id = $1 AND operation_key = 'doi:missing-key'`,
      [d.workspace],
    );
    expect(rows[0]).toEqual({ state: 'failed', failure_kind: 'permanent' });
    // A permanent failure is not retried on a later round.
    expect((await dispatchOutboxOnce({ db: d.db, kp, events, bus })).claimed).toBe(0);
  });

  it('fails a malformed message-event payload permanently instead of retrying it', async () => {
    await d.db.withWorkspace(d.workspace, (tx) =>
      enqueueOutbox(tx, d.workspace, {
        kind: 'message_event',
        operationKey: 'malformed-message-event',
        payload: { events: [{}] },
      }),
    );
    clickhouseBlocked = false;
    const result = await dispatchOutboxOnce({ db: d.db, kp, events, bus });
    expect(result.failed).toBe(1);
    expect(sent).toHaveLength(0);
    const { rows } = await d.db.admin.query<{ state: string; failure_kind: string }>(
      `SELECT state, failure_kind FROM outbox WHERE workspace_id = $1 AND operation_key = 'malformed-message-event'`,
      [d.workspace],
    );
    expect(rows[0]).toEqual({ state: 'failed', failure_kind: 'permanent' });
  });

  it('fails an unknown kind once instead of retrying forever', async () => {
    await d.db.withWorkspace(d.workspace, async (tx) => {
      await tx.insert(schema.outbox).values({
        workspaceId: d.workspace,
        id: newId('obx'),
        kind: 'from-a-newer-release',
        payload: {},
        operationKey: 'unknown-kind',
      });
    });
    clickhouseBlocked = false;
    const result = await dispatchOutboxOnce({ db: d.db, kp, events, bus });
    expect(result.failed).toBeGreaterThanOrEqual(1);
    const { rows } = await d.db.admin.query<{ state: string; last_error: string }>(
      `SELECT state, last_error FROM outbox WHERE workspace_id = $1 AND operation_key = 'unknown-kind'`,
      [d.workspace],
    );
    expect(rows[0]).toMatchObject({ state: 'failed' });
    expect(rows[0]!.last_error).toContain('unknown outbox kind');
  });
});
