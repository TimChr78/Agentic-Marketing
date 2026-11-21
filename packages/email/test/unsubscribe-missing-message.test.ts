import { newId } from '@agentic-marketing/core';
import { schema } from '@agentic-marketing/db';
import type { AdapterDeps } from '@agentic-marketing/email';
import { emailRoutes, linkSigner } from '@agentic-marketing/email';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';

// #1152: when POST /u/:token found no messages row (erased person, pruned message), the route
// fell back to the link's profile id and still enqueued a message_event and called consentChanged.
// After an erasure that wrote new outbox and ClickHouse rows for the erased id; after a merge it
// named the merged-away id instead of the survivor.

const MASTER_KEY = Buffer.alloc(32, 62).toString('base64');

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws: string;
const changed: { workspaceId: string; profileIds: string[]; cause: string }[] = [];

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('email_unsub_missing');
  ws = d.workspace;
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const app = () =>
  emailRoutes({
    db: d.db,
    kp: localKeyProvider(MASTER_KEY),
    events: {} as EventStore,
    email: {
      publicUrl: 'https://links.example.com',
      links: linkSigner('unsubscribe-missing-message'),
      adapterDeps: {} as AdapterDeps,
      trackClicks: false,
    },
    consentChanged: async (workspaceId, profileIds, cause) => {
      changed.push({ workspaceId, profileIds, cause });
    },
  });

const tokenFor = (profileId: string) =>
  linkSigner('unsubscribe-missing-message').sign({ w: ws, p: profileId, u: 'marketing_email', m: newId('msg') });

const outbox = async () =>
  (await d.db.admin.query<{ payload: { events: { profileId: string }[] } }>('SELECT payload FROM outbox WHERE workspace_id = $1', [ws]))
    .rows;

describe.skipIf(!hasTestDatabase())('POST /u/:token without a messages row (#1152)', () => {
  it('writes nothing for an erased or missing profile', async () => {
    changed.length = 0;
    const missing = newId('prf');
    const response = await app().request(`/u/${tokenFor(missing)}`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await outbox()).toEqual([]);
    expect(changed).toEqual([]);
    const consent = await d.db.admin.query('SELECT 1 FROM consent_records WHERE workspace_id = $1 AND profile_id = $2', [ws, missing]);
    expect(consent.rowCount).toBe(0);
  }, 60_000);

  it('uses the canonical survivor when the profile was merged', async () => {
    changed.length = 0;
    const survivor = newId('prf');
    const alias = newId('prf');
    await d.db.withWorkspace(ws, async (tx) => {
      await tx.insert(schema.profiles).values([
        { workspaceId: ws, id: survivor },
        { workspaceId: ws, id: alias, mergedInto: survivor },
      ]);
      await tx.insert(schema.profileMerges).values({ workspaceId: ws, fromId: alias, intoId: survivor, reason: 'test merge' });
    });

    const response = await app().request(`/u/${tokenFor(alias)}`, { method: 'POST' });

    expect(response.status).toBe(200);
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.events.map((e) => e.profileId)).toEqual([survivor]);
    expect(changed).toEqual([{ workspaceId: ws, profileIds: [survivor], cause: expect.stringMatching(/^unsubscribe:/) }]);
  }, 60_000);
});
