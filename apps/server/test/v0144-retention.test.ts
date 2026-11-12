import { randomUUID } from 'node:crypto';
import { runRetentionOnce } from '@agentic-marketing/audience';
import type { BusEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// Sol's review of #627: retention must delete only on positive evidence, re-check consent and
// identifiers atomically, and page through kept candidates so they cannot starve an eligible one.

const PORT = testPort(4332);

let t: Awaited<ReturnType<typeof startTestServer>>;
let owner: User;
let ws = '';
let seq = 0;

const api = () => t.api(owner, ws);

const retentionDeps = () => ({ db: t.srv.db, events: t.srv.events, hot: t.srv.hot, unconfirmedDays: 30, logDays: 180 });

/** A profile in exactly the SQL shape retention considers: one e-mail, one anonymous id, no user id. */
async function seedProfile(anon: string, email: string, createdAt: Date, id?: string) {
  const profileId = id ?? `prf_${randomUUID().replaceAll('-', '')}`;
  const old = new Date(Date.now() - 40 * 86_400_000);
  await t.srv.db.admin.query(`INSERT INTO profiles (workspace_id, id, created_at, first_seen, last_seen) VALUES ($1, $2, $3, $4, $4)`, [
    ws,
    profileId,
    createdAt,
    old,
  ]);
  await t.srv.db.admin.query(
    `INSERT INTO identifiers (workspace_id, type, value, profile_id, first_seen, last_seen)
     VALUES ($1, 'anonymous_id', $2, $3, $4, $4), ($1, 'email', $5, $3, $4, $4)`,
    [ws, anon, profileId, old, email],
  );
  return profileId;
}

function storedEvent(anon: string, name: string, opts: { type?: BusEvent['type']; sourceId?: string; timestamp?: string } = {}): BusEvent {
  const at = opts.timestamp ?? new Date().toISOString();
  return {
    workspaceId: ws,
    sourceId: opts.sourceId ?? `frm_${'a'.repeat(32)}`,
    messageId: `retention:${anon}:${name}:${++seq}`,
    type: opts.type ?? 'track',
    name,
    anonymousId: anon,
    userId: '',
    timestamp: at,
    receivedAt: at,
    properties: {},
    traits: {},
    piiTraits: {},
    context: {},
    consent: {},
  };
}

const profileExists = async (id: string) =>
  (await t.srv.db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM profiles WHERE workspace_id = $1 AND id = $2', [ws, id]))
    .rows[0].n === 1;

beforeAll(async () => {
  t = await startTestServer('test_v0144_retention', PORT);
  owner = await t.signUp(`owner-retention-${Date.now()}@example.com`);
  ws = await t.workspaceWith([[owner, 'owner']]);
}, 60_000);

afterAll(() => t?.close());

describe('retention positive evidence (#627 review)', () => {
  it('keeps a form: profile that already has Subscription Confirmed but no consent row yet', async () => {
    const anon = 'form:confirmed-arrived-first';
    const id = await seedProfile(anon, 'confirmed-first@example.com', new Date(Date.now() - 60 * 86_400_000));
    await t.srv.events.insert([storedEvent(anon, 'Form Submitted'), storedEvent(anon, 'Subscription Confirmed')]);

    expect((await runRetentionOnce(retentionDeps())).profiles).toBe(0);
    expect(await profileExists(id)).toBe(true);
  });

  it('keeps an empty history, then deletes it once the form submission is visible and nothing else is', async () => {
    const anon = 'form:empty-history';
    const id = await seedProfile(anon, 'empty-history@example.com', new Date(Date.now() - 60 * 86_400_000));

    expect((await runRetentionOnce(retentionDeps())).profiles).toBe(0);
    expect(await profileExists(id)).toBe(true);

    await t.srv.events.insert([storedEvent(anon, 'Form Submitted')]);
    expect((await runRetentionOnce(retentionDeps())).profiles).toBe(1);
    expect(await profileExists(id)).toBe(false);
  });

  it('keeps a profile whose consent is written after selection and before deletion', async () => {
    const anon = 'form:consent-race';
    const id = await seedProfile(anon, 'consent-race@example.com', new Date(Date.now() - 60 * 86_400_000));
    await t.srv.events.insert([storedEvent(anon, 'Form Submitted')]);

    let written = false;
    const writeConsent = async () => {
      if (written) return;
      written = true;
      await api().call('consent.record', { profileId: id, purpose: 'marketing_email', status: 'granted', source: 'api' });
    };
    // The consent is written after the candidate was selected and before the delete transaction.
    const events = {
      ...t.srv.events,
      async eventsOf(...args: Parameters<typeof t.srv.events.eventsOf>) {
        await writeConsent();
        return t.srv.events.eventsOf(...args);
      },
      async eventsOfAnonymousIds(...args: Parameters<typeof t.srv.events.eventsOfAnonymousIds>) {
        await writeConsent();
        return t.srv.events.eventsOfAnonymousIds(...args);
      },
    } as typeof t.srv.events;

    expect((await runRetentionOnce({ ...retentionDeps(), events })).profiles).toBe(0);
    expect(await profileExists(id)).toBe(true);
    expect((await api().call('consent.history', { profileId: id })).records.length).toBeGreaterThan(0);
  });

  it('does not treat an unrelated identify with the same timestamp as the form identify', async () => {
    const anon = 'form:timestamp-collision';
    const id = await seedProfile(anon, 'timestamp-collision@example.com', new Date(Date.now() - 60 * 86_400_000));
    const at = new Date().toISOString();
    await t.srv.events.insert([
      storedEvent(anon, 'Form Submitted', { timestamp: at }),
      // An SDK identify can share the timestamp, but its source is not the form.
      storedEvent(anon, 'identify', { type: 'identify', sourceId: 'src_other', timestamp: at }),
    ]);

    expect((await runRetentionOnce(retentionDeps())).profiles).toBe(0);
    expect(await profileExists(id)).toBe(true);
  });

  it('keeps a profile whose Form Submitted came through the public ingest API', async () => {
    const email = 'public-form-event@example.com';
    const anon = 'public-form-event';
    const at = new Date().toISOString();
    const { key } = await api().call('sources.create', { name: 'Public server', kind: 'server' });
    // A legitimate public SDK source, not the platform's form path.
    const res = await fetch(`${t.base}/v1/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      body: JSON.stringify({
        batch: [
          { type: 'identify', anonymousId: anon, timestamp: at, traits: { email } },
          { type: 'track', event: 'Form Submitted', anonymousId: anon, timestamp: at, properties: { form_id: `frm_${'a'.repeat(32)}` } },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { profileId } = await eventually(
      () => api().call('profiles.find', { type: 'email', value: email }),
      (r) => !!r.profileId,
    );
    await eventually(
      async () => (await t.srv.events.eventsOf(ws, { anonymousIds: [anon], userIds: [] })).length,
      (n) => n >= 2,
    );
    await t.srv.db.admin.query(
      `UPDATE profiles SET first_seen = now() - interval '45 days', created_at = now() - interval '60 days' WHERE id = $1`,
      [profileId],
    );

    expect((await runRetentionOnce(retentionDeps())).profiles).toBe(0);
    expect(await profileExists(profileId!)).toBe(true);
  });
});
