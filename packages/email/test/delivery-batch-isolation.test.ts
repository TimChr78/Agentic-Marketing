import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { EventStore } from '@agentic-marketing/events';
import { personCrypto } from '@agentic-marketing/profiles';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import type { AdapterDeps } from '../src/adapters';
import { outbox } from '../src/adapters';
import { deliverRound, recoverUnhandledDelivery } from '../src/gateway';
import { linkSigner } from '../src/links';
import { MAX_ATTEMPTS } from '../src/outbox';

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
      webhookTokenHash: 'hash',
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
});
