import type { Db } from '@agentic-marketing/db';
import { refreshSnapshots } from '@agentic-marketing/personalize';
import { runErasureCleanupOnce } from '@agentic-marketing/profiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventually, startTestServer, testPort, type User } from './harness';

// #1196 and #1197: an erasure is the correctness boundary for the decision API's hot state and
// for a segment's stored dynamic total.
//
// A snapshot refresh or a late accepted event must not rewrite hot state after the erasure's final
// hot-state delete, because `/v1/decide` reads precisely that state. Both writers re-check after
// writing and delete again, so decide never personalises from an erased person even when the write
// was in flight while the erasure committed. `segments.members` reports `segment_runs.members` for
// a dynamic segment, so the erasure transaction decrements it for the memberships it removes.

const PORT = testPort(3598);
const DB = 'test_privacy_hot_state_1196';

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let owner: User;

const consent = { consent: { categoryPreferences: { analytics: true, web_personalization: true } } };

const sendWith = (key: string) => (batch: unknown[]) =>
  fetch(`${t.base}/v1/batch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://shop.example.com',
      authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
    },
    body: JSON.stringify({ batch }),
  });

const decide = async (key: string, body: Record<string, unknown>) => {
  const res = await fetch(`${t.base}/v1/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://shop.example.com' },
    body: JSON.stringify({ writeKey: key, placements: [], ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { personalized: boolean; decisions: { experienceId: string }[] };
};

/** Wraps a Db so the first `withWorkspace` pauses after its transaction has returned. */
function pauseAfterFirstRead(db: Db, pause: () => Promise<void>): Db {
  let first = true;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'withWorkspace') return Reflect.get(target, prop, receiver);
      return async (workspaceId: string, fn: Parameters<Db['withWorkspace']>[1], opts?: Parameters<Db['withWorkspace']>[2]) => {
        const out = await target.withWorkspace(workspaceId, fn, opts);
        if (first) {
          first = false;
          await pause();
        }
        return out;
      };
    },
  }) as Db;
}

const cleanupDeps = () => ({ db: t.srv.db, kp: t.srv.keyProvider, events: t.srv.events, hot: t.srv.hot });

const makeDue = (workspaceId: string, erasureId: string) =>
  t.srv.db.admin.query(
    `UPDATE erasure_cleanup_jobs SET next_attempt_at = now()
      WHERE workspace_id = $1 AND erasure_id = $2 AND state <> 'complete'`,
    [workspaceId, erasureId],
  );

async function completeErasure(workspaceId: string, erasureId: string) {
  const api = t.api(owner, workspaceId);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await runErasureCleanupOnce(cleanupDeps(), {
      finalSweepMs: 0,
      outboxWaitSeconds: 0,
      coverageWaitSeconds: 0,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    });
    if ((await api.call('profiles.erasureStatus', { erasureId })).status === 'complete') return;
    await makeDue(workspaceId, erasureId);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`erasure ${erasureId} did not complete`);
}

async function publish(api: ReturnType<Server['api']>, type: 'experience' | 'segment', name: string, content: unknown) {
  const a = await api.call('artifacts.create', { type, name, content: content as Record<string, unknown> });
  await api.call('artifacts.requestPublish', { artifactId: a.artifactId, note: 'test' });
  return a.artifactId;
}

/** A workspace with one source and two experiences: one trait-targeted, one session-targeted. */
async function newWorkspace() {
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  const key = (await api.call('sources.create', { name: 'Shop', kind: 'browser', allowedOrigins: ['https://shop.example.com'] })).key;
  const variants = [{ id: 'a', name: 'Only', weight: 100, content: { html: '<p>Personalised</p>' } }];
  const traitExperience = await publish(api, 'experience', 'Trait hero', {
    placement: 'hero_trait',
    targeting: { trait: 'tier', op: 'eq', value: 'gold' },
    variants,
  });
  const sessionExperience = await publish(api, 'experience', 'Session hero', {
    placement: 'hero_session',
    targeting: { session: 'page', count: { gte: 1 } },
    variants,
  });
  return { ws, api, key, traitExperience, sessionExperience };
}

async function identify(api: ReturnType<Server['api']>, key: string, userId: string, anonymousId: string) {
  const response = await sendWith(key)([{ type: 'identify', userId, anonymousId, traits: { tier: 'gold' }, context: consent }]);
  expect(response.status).toBe(200);
  const person = await eventually(
    () => api.call('profiles.find', { type: 'user_id', value: userId }),
    (r) => !!r.profileId,
  );
  return { profileId: person.profileId as string, userId, anonymousId };
}

beforeAll(async () => {
  t = await startTestServer(DB, PORT, {}, { erasureCleanup: false, erasurePurge: false });
  owner = await t.signUp(`privacy-${Date.now()}@example.com`);
}, 120_000);

afterAll(() => t?.close());

describe('an erased person, when a writer was already in flight', () => {
  it('a snapshot refresh that read before the erasure leaves no snapshot for decide', async () => {
    const { ws, api, key, traitExperience } = await newWorkspace();
    const person = await identify(api, key, `user-refresh-${Date.now()}`, `anon-refresh-${Date.now()}`);

    // The person is personalised from the snapshot the refresh hook wrote.
    const before = await eventually(
      () => t.srv.hot.snapshot(ws, { anonymousId: person.anonymousId, userId: person.userId }),
      (s) => !!s,
    );
    expect(before?.traits).toMatchObject({ tier: 'gold' });
    const personalised = await decide(key, {
      anonymousId: person.anonymousId,
      userId: person.userId,
      placements: ['hero_trait'],
      context: consent,
    });
    expect(personalised.decisions.map((d) => d.experienceId)).toEqual([traitExperience]);

    // Hold the refresh between its read and its write, which is exactly the window an erasure
    // exploits: the read saw the profile, so it has data to write after the cleanup deleted it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let read!: () => void;
    const readDone = new Promise<void>((resolve) => {
      read = resolve;
    });
    const db = pauseAfterFirstRead(t.srv.db, async () => {
      read();
      await gate;
    });
    const refresh = refreshSnapshots({ db, hot: t.srv.hot }, ws, [person.profileId]);
    await readDone;

    const erased = await api.call('profiles.erase', { profileId: person.profileId, reason: 'holding a refresh open' });
    await completeErasure(ws, erased.erasureId);
    release();
    await refresh;

    // The refresh wrote the pre-erasure snapshot after the final hot-state delete, then its
    // re-check saw the profile is gone and deleted it again.
    expect(await t.srv.hot.snapshot(ws, { anonymousId: person.anonymousId, userId: person.userId })).toBeNull();
    expect(
      (await decide(key, { anonymousId: person.anonymousId, userId: person.userId, placements: ['hero_trait'], context: consent }))
        .decisions,
    ).toEqual([]);
  }, 120_000);

  it('a late accepted event after the erasure leaves no session for decide', async () => {
    const { ws, api, key } = await newWorkspace();
    const person = await identify(api, key, `user-late-${Date.now()}`, `anon-late-${Date.now()}`);
    await eventually(
      () => t.srv.hot.snapshot(ws, { anonymousId: person.anonymousId, userId: person.userId }),
      (s) => !!s,
    );

    const erased = await api.call('profiles.erase', { profileId: person.profileId, reason: 'a late event arrives' });
    await completeErasure(ws, erased.erasureId);
    expect((await t.srv.hot.session(ws, person.anonymousId)).isNew).toBe(true);

    // The resolver drops these within the erasure grace window, but ingest records session state
    // from what it accepted before resolution. Without the post-write re-check the session is
    // rebuilt after the erasure's final delete, and session targeting personalises the person.
    const late = await sendWith(key)([
      { type: 'page', anonymousId: person.anonymousId, name: 'Home', context: { ...consent, page: { path: '/home' } } },
      { type: 'page', anonymousId: person.anonymousId, name: 'Pricing', context: { ...consent, page: { path: '/pricing' } } },
    ]);
    expect(late.status).toBe(200);
    expect((await t.srv.hot.session(ws, person.anonymousId)).isNew).toBe(true);
    expect(await t.srv.hot.snapshot(ws, { anonymousId: person.anonymousId, userId: person.userId })).toBeNull();
    expect((await decide(key, { anonymousId: person.anonymousId, placements: ['hero_session'], context: consent })).decisions).toEqual([]);
  }, 120_000);
});

describe('a dynamic segment total', () => {
  it('drops the erased member in the erasure transaction (#1197)', async () => {
    const { ws, api } = await newWorkspace();
    const profileId = `prf_${'a'.repeat(32)}`;
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, profileId]);
    const { artifactId } = await api.call('artifacts.create', {
      type: 'segment',
      name: `Erased member ${Date.now()}`,
      content: { mode: 'dynamic', condition: { trait: 'city', op: 'eq', value: 'Aarhus' } },
    });
    // A completed recompute and its stored total, as the refresh leaves them.
    await t.srv.db.admin.query(
      `INSERT INTO segment_runs (workspace_id, segment_id, version, members, entered, exited, took_ms)
       VALUES ($1, $2, 1, 1, 1, 0, 5)`,
      [ws, artifactId],
    );
    await t.srv.db.admin.query(`INSERT INTO segment_memberships (workspace_id, segment_id, profile_id, since) VALUES ($1, $2, $3, now())`, [
      ws,
      artifactId,
      profileId,
    ]);

    await api.call('profiles.erase', { profileId, reason: 'segment total' });
    const view = await api.call('segments.members', { artifactId });
    // The membership row is gone, and the stored dynamic total no longer counts the erased person.
    expect({ members: view.members.length, total: view.total }).toEqual({ members: 0, total: 0 });
    const [run] = (
      await t.srv.db.admin.query<{ members: number }>('SELECT members FROM segment_runs WHERE workspace_id = $1 AND segment_id = $2', [
        ws,
        artifactId,
      ])
    ).rows;
    expect(run?.members).toBe(0);
  }, 60_000);
});
