import { newId } from '@agentic-marketing/core';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { sweep } from '../src/runtime';

// #1300: the sweep locks the canonical profile of a participant, but then read consent (and the
// segment and condition state) under the participant's stored id. A participant left on an id an
// earlier merge folded away therefore read "no record" instead of the survivor's objection and kept
// advancing. The locked canonical id is the person every person-dependent read and effect uses.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;
let ws: string;

const store = {
  async countEvents() {
    return [];
  },
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_sweep_canonical');
  kp = localKeyProvider(Buffer.alloc(32, 48).toString('base64'));
  ws = d.workspace;
}, 180_000);

afterAll(async () => {
  await d?.close();
});

async function publishJourney() {
  const journeyId = newId('jrn');
  const content = {
    purpose: 'marketing_email',
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'done' }] },
      { id: 'done', kind: 'exit', label: 'Done', config: {} },
    ],
  };
  await d.db.admin.query(
    `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
     VALUES ($1, $2, 'journey', 'Legacy participant', 1, 1)`,
    [ws, journeyId],
  );
  await d.db.admin.query(
    `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
     VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
    [ws, journeyId, JSON.stringify(content), `hash_${journeyId}`],
  );
  return journeyId;
}

/** A merged pair, the participant left on the merged-away id (a legacy hook insert). */
async function legacyParticipant(objected: boolean) {
  const survivor = newId('prf');
  const alias = newId('prf');
  await d.db.admin.query(`INSERT INTO profiles (workspace_id, id) VALUES ($1, $2), ($1, $3)`, [ws, survivor, alias]);
  if (objected)
    await d.db.admin.query(
      `INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
       VALUES ($1, $2, 'marketing_email', '', 'objected', 'consent', 'api', now())`,
      [ws, survivor],
    );
  // The merge that folded the alias away: its own consent rows go with it.
  await d.db.admin.query(`UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2`, [ws, alias, survivor]);
  await d.db.admin.query(`INSERT INTO profile_merges (workspace_id, from_id, into_id, reason) VALUES ($1, $2, $3, 'merge')`, [
    ws,
    alias,
    survivor,
  ]);
  const journeyId = await publishJourney();
  const [row] = (
    await d.db.admin.query<{ id: string }>(
      `INSERT INTO journey_participants (workspace_id, journey_id, version, profile_id, entry_key, node, status, due_at, context)
       VALUES ($1, $2, 1, $3, 'legacy', 'start', 'ready', now() - interval '1 minute', '{}'::jsonb)
       RETURNING id`,
      [ws, journeyId, alias],
    )
  ).rows;
  return { survivor, alias, participantId: Number(row!.id) };
}

describe.skipIf(!hasTestDatabase())('the sweep reads the participant’s canonical person (#1300)', () => {
  it('exits a legacy participant whose survivor objected to the journey’s purpose', async () => {
    const { participantId } = await legacyParticipant(true);
    expect(await sweep(d.db, { kp, events: store })).toBe(1);
    const { rows } = await d.db.admin.query<{ status: string; error: string | null }>(
      'SELECT status, error FROM journey_participants WHERE workspace_id = $1 AND id = $2',
      [ws, participantId],
    );
    expect(rows[0]).toMatchObject({ status: 'exited', error: 'consent_withdrawn: marketing_email' });
  }, 180_000);

  it('still advances a legacy participant whose survivor allowed the purpose', async () => {
    // Guards against the fix turning every legacy participant into an exit.
    const survivor = newId('prf');
    const alias = newId('prf');
    await d.db.admin.query(`INSERT INTO profiles (workspace_id, id) VALUES ($1, $2), ($1, $3)`, [ws, survivor, alias]);
    await d.db.admin.query(
      `INSERT INTO consent_state (workspace_id, profile_id, purpose, channel, status, basis, source, updated_at)
       VALUES ($1, $2, 'marketing_email', '', 'granted', 'consent', 'api', now())`,
      [ws, survivor],
    );
    await d.db.admin.query(`UPDATE profiles SET merged_into = $3 WHERE workspace_id = $1 AND id = $2`, [ws, alias, survivor]);
    const journeyId = await publishJourney();
    const [row] = (
      await d.db.admin.query<{ id: string }>(
        `INSERT INTO journey_participants (workspace_id, journey_id, version, profile_id, entry_key, node, status, due_at, context)
         VALUES ($1, $2, 1, $3, 'legacy-ok', 'start', 'ready', now() - interval '1 minute', '{}'::jsonb)
         RETURNING id`,
        [ws, journeyId, alias],
      )
    ).rows;
    expect(await sweep(d.db, { kp, events: store })).toBe(1);
    const { rows } = await d.db.admin.query<{ status: string }>(
      'SELECT status FROM journey_participants WHERE workspace_id = $1 AND id = $2',
      [ws, Number(row!.id)],
    );
    expect(rows[0]!.status).toBe('completed');
  }, 180_000);
});
