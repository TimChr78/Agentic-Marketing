import { runRetentionOnce } from '@agentic-marketing/audience';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testPort, type User } from './harness';

// Erasure already cascades in migration 0064; pin that guarantee and fix expiry cleanup (#359).
describe('profile score erasure and expiry', () => {
  let t: Awaited<ReturnType<typeof startTestServer>>;
  let owner: User;
  let ws: string;

  beforeAll(async () => {
    t = await startTestServer('test_score_erasure', testPort(3487));
    owner = await t.signUp(`score-erasure-${Date.now()}@example.com`);
    ws = await t.workspaceWith([[owner, 'owner']]);
  });
  afterAll(() => t?.close());

  async function seed(id: string, expired = false) {
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, id]);
    await t.srv.db.admin.query(
      `INSERT INTO profile_scores (workspace_id, profile_id, key, value, model, model_version, expires_at)
       VALUES ($1, $2, 'propensity', 0.8, 'test', 'v1', now() + $3::interval)`,
      [ws, id, expired ? '-1 hour' : '1 hour'],
    );
  }

  it('removes an unexpired prediction when the person is erased', async () => {
    const id = 'prf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await seed(id);
    const api = t.api(owner);
    expect((await api.call('profiles.scores', { profileId: id })).scores).toHaveLength(1);
    await api.call('profiles.erase', { profileId: id, reason: 'Erasure regression' });
    expect((await api.call('profiles.scores', { profileId: id })).scores).toEqual([]);
    const rows = await t.srv.db.admin.query('SELECT * FROM profile_scores WHERE workspace_id = $1 AND profile_id = $2', [ws, id]);
    expect(rows.rowCount).toBe(0);
  });

  it('prunes expired predictions while keeping live predictions', async () => {
    await seed('prf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', true);
    await seed('prf_cccccccccccccccccccccccccccccccc');
    const calibration = () => t.api(owner).call('ai.calibration', { scoreKey: 'propensity', event: 'Order Completed' });
    expect((await calibration()).predictions).toBe(1);
    const result = await runRetentionOnce({ db: t.srv.db, events: t.srv.events, ...t.srv.retention });
    expect(result.profileScores).toBe(1);
    expect((await calibration()).predictions).toBe(1);
    const rows = await t.srv.db.admin.query('SELECT profile_id FROM profile_scores WHERE workspace_id = $1', [ws]);
    expect(rows.rows).toEqual([{ profile_id: 'prf_cccccccccccccccccccccccccccccccc' }]);
  });
  it('bounds expired-score pruning per workspace and continues on the next pass', async () => {
    await t.srv.db.admin.query(
      `INSERT INTO profile_scores (workspace_id, profile_id, key, value, model, model_version, expires_at)
       SELECT $1, $2, 'batch_' || g, 0.5, 'test', 'v1', now() - interval '1 hour'
       FROM generate_series(1, 5001) g`,
      [ws, 'prf_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    );
    const deps = { db: t.srv.db, events: t.srv.events, ...t.srv.retention };
    expect((await runRetentionOnce(deps)).profileScores).toBe(5000);
    expect((await runRetentionOnce(deps)).profileScores).toBe(1);
    expect((await t.api(owner).call('profiles.scores', { profileId: 'prf_cccccccccccccccccccccccccccccccc' })).scores).toHaveLength(1);
  });
});
