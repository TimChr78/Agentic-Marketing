import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { createDisposableDb, hasTestDatabase } from './disposable';

// #1144: a merge that ran before 0.17.6 did not move `profile_scores`, so a prediction stayed on
// the merged-away profile where segments, journeys and profiles.scores (all of which read the
// canonical id) never saw it, and ai.calibration counted an orphan prediction with no identifiers
// left to match. Migration 0119 folds those stranded rows onto the chain's survivor, keeping the
// newer score per key and collapsing a duplicate, the same rule a live merge applies.

let d: Awaited<ReturnType<typeof createDisposableDb>>;

const survivor = newId('prf');
const middle = newId('prf');
const stranded = newId('prf');
const strandedOlder = newId('prf');

// Fixed timestamps, so the assertions compare the values that were stored, never a fresh `Date`.
const olderAt = new Date(Date.now() - 40 * 60_000);
const strandedAt = new Date(Date.now() - 30 * 60_000);
const survivorAt = new Date(Date.now() - 5 * 60_000);

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  // Up to the head before 0119, so the stranded rows exist when the repair runs.
  d = await createDisposableDb('stranded_scores', { upTo: '0117_stranded_segment_memberships.sql' });
  const ws = d.workspace;
  // A two-hop chain (stranded → middle → survivor) plus a profile merged straight onto the
  // survivor, so the repair follows a chain and handles more than one origin.
  await d.db.admin.query(
    `INSERT INTO profiles (workspace_id, id, merged_into) VALUES
       ($1, $2, NULL),
       ($1, $3, $2),
       ($1, $4, $3),
       ($1, $5, $2)`,
    [ws, survivor, middle, stranded, strandedOlder],
  );
  const score = (profileId: string, key: string, value: number, createdAt: Date) =>
    d.db.admin.query(
      `INSERT INTO profile_scores (workspace_id, profile_id, key, value, model, model_version, created_at, expires_at)
       VALUES ($1, $2, $3, $4, 'test-model', 'v1', $5, '2030-01-01T00:00:00Z')`,
      [ws, profileId, key, value, createdAt],
    );
  // The survivor's propensity is older than the stranded one, so the stranded value wins...
  await score(survivor, 'propensity', 0.5, olderAt);
  await score(stranded, 'propensity', 0.77, strandedAt);
  // ...while the survivor's churn is newer and stays, even though two stranded profiles have one.
  await score(survivor, 'churn', 0.9, survivorAt);
  await score(stranded, 'churn', 0.2, strandedAt);
  await score(strandedOlder, 'churn', 0.4, olderAt);
  // A key only a merged-away profile has must move as it is, including from the middle of the chain.
  await score(middle, 'recency', 0.3, strandedAt);
  await score(strandedOlder, 'propensity', 0.1, olderAt);
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('stranded scores on merged-away profiles (#1144)', () => {
  it('folds them onto the survivor, keeps the newer score per key, and deletes the stranded rows', async () => {
    await migrate(d.db.admin, {
      appRole: 'am_ops_test_app',
      appRolePassword: 'am_ops_test_password',
    });
    const applied = await d.db.admin.query(`SELECT 1 FROM schema_migrations WHERE version = '0119_stranded_profile_scores.sql'`);
    expect(applied.rowCount).toBe(1);

    const rows = await d.db.admin.query<{ profile_id: string; key: string; value: number }>(
      `SELECT profile_id, key, value FROM profile_scores WHERE workspace_id = $1 ORDER BY key`,
      [d.workspace],
    );
    expect(rows.rows).toEqual([
      { profile_id: survivor, key: 'churn', value: 0.9 },
      { profile_id: survivor, key: 'propensity', value: 0.77 },
      { profile_id: survivor, key: 'recency', value: 0.3 },
    ]);

    const left = await d.db.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM profile_scores WHERE workspace_id = $1 AND profile_id <> $2`,
      [d.workspace, survivor],
    );
    expect(left.rows[0]?.count).toBe('0');
  }, 180_000);
});
