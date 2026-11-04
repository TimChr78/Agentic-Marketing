import { runExport } from '@agentic-marketing/warehouse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// #373: erasure failures stay visible, and private deletion keys exist only while needed.
describe('warehouse erasure safety', () => {
  let t: Awaited<ReturnType<typeof startTestServer>>;
  let owner: User;
  let ws: string;
  let exportId: string;
  const name = 'test_v072_wh_safety';
  const url = testDatabaseUrl(`am_${name}`).toString();
  beforeAll(async () => {
    t = await startTestServer(name, testPort(3493), { EGRESS_ALLOWED_HOSTS: new URL(url).hostname }, { warehouseTickMs: 86_400_000 });
    owner = await t.signUp(`warehouse-safety-${Date.now()}@example.com`);
    ws = await t.workspaceWith([[owner, 'owner']], 'none');
  });
  afterAll(() => t?.close());

  async function erase(suffix: string) {
    const id = `prf_${suffix.repeat(32)}`;
    await t.srv.db.admin.query('INSERT INTO profiles (workspace_id, id) VALUES ($1, $2)', [ws, id]);
    await t.srv.db.admin.query("INSERT INTO identifiers (workspace_id, profile_id, type, value) VALUES ($1, $2, 'user_id', $3)", [
      ws,
      id,
      `erasure-${suffix}`,
    ]);
    await t.api(owner).call('profiles.erase', { profileId: id, reason: 'Warehouse erasure regression' });
  }
  const keys = async () => (await t.srv.db.admin.query('SELECT * FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws])).rows;

  it('does not retain erased identifiers in a workspace without a destination', async () => {
    await erase('a');
    expect(await keys()).toEqual([]);
  });

  it('keeps an incomplete erasure failed on a second run instead of clearing the warning', async () => {
    const created = await t.api(owner).call('warehouse.create', {
      name: 'Safety destination',
      kind: 'postgres',
      config: { schema: 'warehouse_safety' },
      datasets: ['events'],
      secrets: { url },
    });
    exportId = created.id;
    // Run directly below; avoid an overlapping scheduled export.
    await t.srv.db.admin.query('UPDATE warehouse_exports SET enabled = false, run_requested = false WHERE workspace_id = $1 AND id = $2', [
      ws,
      exportId,
    ]);
    await erase('b');
    expect(await keys()).toHaveLength(1);
    await t.srv.db.admin.query('DELETE FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws]);
    const deps = { db: t.srv.db, events: t.srv.events, kp: t.srv.keyProvider, egress: t.srv.egress, lagMs: -10000 };
    for (let i = 0; i < 2; i++) {
      expect((await runExport(deps, ws, exportId)).status).toBe('failed');
      const row = (await t.api(owner).call('warehouse.list', {})).exports.find((e) => e.id === exportId)!;
      expect(row.lastStatus).toBe('failed');
      expect(row.lastError).toContain('erasure not fully applied');
      expect(row.exportedUntil.erasures).toBeUndefined();
    }
  });

  it('drops remaining private keys when the final destination is removed', async () => {
    await erase('c');
    expect(await keys()).toHaveLength(1);
    await t.api(owner).call('warehouse.delete', { id: exportId });
    expect(await keys()).toEqual([]);
  });
});
