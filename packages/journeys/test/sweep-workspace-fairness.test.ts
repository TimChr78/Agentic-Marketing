import { randomUUID } from 'node:crypto';
import { newId } from '@agentic-marketing/core';
import type { EventStore } from '@agentic-marketing/events';
import { localKeyProvider } from '@agentic-marketing/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { sweep } from '../src/runtime';

// #1245: the sweep took its 100 workspaces in plan order (`SELECT DISTINCT workspace_id … LIMIT
// 100`, no ORDER BY), so with more than 100 workspaces due the highest ids never got a turn while
// the first 100 kept due rows. The scan must start with the workspace that has been due longest.

const MASTER_KEY = Buffer.alloc(32, 47).toString('base64');
const WORKSPACES = 120;

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let kp: ReturnType<typeof localKeyProvider>;

const store = {
  async countEvents() {
    return [];
  },
  async insertJourneyEvents() {},
} as unknown as EventStore;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('journey_sweep_fairness');
  kp = localKeyProvider(MASTER_KEY);
}, 180_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('the sweep serves the workspace due longest (#1245)', () => {
  it('reaches a workspace whose id sorts after the first 100', async () => {
    // The workspace with the oldest due time is deliberately the one whose id sorts last: the old
    // plan (Sort by workspace_id) never put it in the first 100.
    const ids = Array.from({ length: WORKSPACES }, () => randomUUID());
    const oldest = [...ids].sort().at(-1)!;
    const now = Date.now();
    for (const [index, ws] of ids.entries()) {
      await d.db.admin.query(`INSERT INTO workspaces (id, name, approval_policy) VALUES ($1, $2, 'none')`, [ws, `fair ${index}`]);
      const journeyId = newId('jrn');
      await d.db.admin.query(
        `INSERT INTO artifacts (workspace_id, id, type, name, latest_version, published_version)
         VALUES ($1, $2, 'journey', $3, 1, 1)`,
        [ws, journeyId, `J ${index}`],
      );
      await d.db.admin.query(
        `INSERT INTO artifact_versions (workspace_id, artifact_id, number, state, content, content_hash, author_type, author_id)
         VALUES ($1, $2, 1, 'published', $3, $4, 'user', 'user_test')`,
        [
          ws,
          journeyId,
          JSON.stringify({
            purpose: 'marketing_email',
            nodes: [
              { id: 'start', kind: 'trigger', label: 'Start', config: { event: 'Signed Up' }, next: [{ to: 'done' }] },
              { id: 'done', kind: 'exit', label: 'Done', config: {} },
            ],
          }),
          `hash_${journeyId}`,
        ],
      );
      const profileId = newId('prf');
      await d.db.admin.query(`INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)`, [ws, profileId]);
      // The oldest workspace is due longest; everyone else is due but newer.
      const dueAt = new Date(ws === oldest ? now - 120_000 : now - 60_000 + index);
      await d.db.admin.query(
        `INSERT INTO journey_participants (workspace_id, journey_id, version, profile_id, entry_key, node, status, due_at, context)
         VALUES ($1, $2, 1, $3, 'fair', 'start', 'ready', $4, '{}'::jsonb)`,
        [ws, journeyId, profileId, dueAt],
      );
    }

    expect(await sweep(d.db, { kp, events: store }, { batch: 1 })).toBeGreaterThanOrEqual(100);
    const { rows } = await d.db.admin.query<{ status: string }>(`SELECT status FROM journey_participants WHERE workspace_id = $1`, [
      oldest,
    ]);
    expect(rows).toEqual([{ status: 'completed' }]);
  }, 180_000);
});
