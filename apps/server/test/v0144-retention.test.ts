import { randomUUID } from 'node:crypto';
import { runRetentionOnce } from '@agentic-marketing/audience';
import type { BusEvent } from '@agentic-marketing/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

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

function storedEvent(anon: string, name: string, type: BusEvent['type'] = 'track'): BusEvent {
  const at = new Date().toISOString();
  return {
    workspaceId: ws,
    sourceId: 'frm_test',
    messageId: `retention:${anon}:${name}:${++seq}`,
    type,
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
});
