import { runExport, warehouseCommands } from '@agentic-marketing/warehouse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejects, startTestServer, testDatabaseUrl, testPort, type User } from './harness';

// #373: erasure failures stay visible, and private deletion keys exist only while needed.
// B2: an incomplete erasure no longer pins the cursor; it becomes a human-acknowledged backlog
// entry with no raw identifiers, so a later complete erasure's keys can still be pruned.
describe('warehouse erasure safety', () => {
  let t: Awaited<ReturnType<typeof startTestServer>>;
  let owner: User;
  let ws: string;
  let exportId: string;
  const name = 'test_v072_wh_safety';
  const url = testDatabaseUrl(`am_${name}`).toString();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
    return (await t.api(owner).call('profiles.erase', { profileId: id, reason: 'Warehouse erasure regression' })).erasureId;
  }
  const keys = async () => (await t.srv.db.admin.query('SELECT * FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws])).rows;
  const exportRow = async () => (await t.api(owner).call('warehouse.list', {})).exports.find((e) => e.id === exportId)!;
  const backlogRowCount = async () =>
    Number(
      (
        await t.srv.db.admin.query('SELECT count(*) AS n FROM warehouse_erasure_backlog WHERE workspace_id = $1 AND export_id = $2', [
          ws,
          exportId,
        ])
      ).rows[0].n,
    );
  const run = () => runExport({ db: t.srv.db, events: t.srv.events, kp: t.srv.keyProvider, egress: t.srv.egress, lagMs: 0 }, ws, exportId);

  it('does not retain erased identifiers in a workspace without a destination', async () => {
    await erase('a');
    expect(await keys()).toEqual([]);
  });

  it('advances the erasure cursor but keeps failed and visible while a manual cleanup is pending', async () => {
    const created = await t.api(owner).call('warehouse.create', {
      name: 'Safety destination',
      kind: 'postgres',
      config: { schema: 'warehouse_safety' },
      datasets: ['events'],
      secrets: { url },
    });
    exportId = created.id;
    // Keep the background scheduler out of this test; the export itself stays enabled so key
    // pruning is still gated by its cursor.
    await t.srv.db.admin.query(
      'UPDATE warehouse_exports SET every_minutes = 10080, run_requested = false, last_run_at = now() WHERE workspace_id = $1 AND id = $2',
      [ws, exportId],
    );

    // Two erasures whose captured keys are already gone (a legacy erasure, or one another
    // destination consumed): the destination cannot locate their events.
    const b = await erase('b');
    const d = await erase('d');
    expect(await keys()).toHaveLength(2);
    await t.srv.db.admin.query('DELETE FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws]);

    const first = await run();
    expect(first.status).toBe('failed');
    const afterFirst = await exportRow();
    expect(afterFirst.lastStatus).toBe('failed');
    expect(afterFirst.lastError).toContain('erasure not fully applied');
    expect(afterFirst.exportedUntil.erasures).toBeTruthy();
    expect(afterFirst.backlogCount).toBe(2);
    expect(await backlogRowCount()).toBe(2);

    await sleep(10);
    const second = await run();
    expect(second.status).toBe('failed');
    const afterSecond = await exportRow();
    // The cursor moved on despite the still-unresolved cleanup.
    expect(Date.parse(afterSecond.exportedUntil.erasures!)).toBeGreaterThan(Date.parse(afterFirst.exportedUntil.erasures!));
    expect(afterSecond.lastStatus).toBe('failed');
    expect(afterSecond.lastError).toContain('erasure cleanup pending');
    expect(afterSecond.backlogCount).toBe(2);

    // The backlog is inspectable page by page and contains only erasure ids and datasets.
    const page1 = await t.api(owner).call('warehouse.erasureBacklog', { id: exportId, limit: 1 });
    expect(page1.entries).toHaveLength(1);
    expect(page1.total).toBe(2);
    expect(page1.next).toBeTruthy();
    expect(page1.entries[0]!.datasets).toEqual(['events']);
    expect(Object.keys(page1.entries[0]!)).not.toContain('identifiers');
    const page2 = await t.api(owner).call('warehouse.erasureBacklog', { id: exportId, limit: 1, after: page1.next! });
    expect(page2.entries).toHaveLength(1);
    expect(page2.next).toBeNull();
    expect([page1.entries[0]!.erasureId, page2.entries[0]!.erasureId].sort()).toEqual([b, d].sort());

    // A later erasure can be applied completely; its raw keys are pruned even though the older
    // manual backlog is still open, because the cursor is no longer pinned before it.
    const c = await erase('c');
    expect((await keys()).map((k) => k.profile_id)).toEqual([`prf_${'c'.repeat(32)}`]);
    await sleep(10);
    const third = await run();
    expect(third.status).toBe('failed');
    expect(await keys()).toEqual([]);
    const afterThird = await exportRow();
    expect(afterThird.lastStatus).toBe('failed');
    expect(afterThird.lastError).toContain('erasure cleanup pending');
    expect(afterThird.backlogCount).toBe(2);
    expect(afterThird.exportedUntil.erasures! > afterSecond.exportedUntil.erasures!).toBe(true);
    // The complete erasure was applied downstream and is not part of the backlog.
    const all = await t.api(owner).call('warehouse.erasureBacklog', { id: exportId, limit: 200 });
    expect(all.entries.map((e) => e.erasureId).sort()).toEqual([b, d].sort());
    expect(all.entries.map((e) => e.erasureId)).not.toContain(c);
  });

  it('acknowledges only selected backlog entries, after a note, and is human-only', async () => {
    const command = warehouseCommands.find((c) => c.name === 'warehouse.acknowledgeErasures');
    expect(command?.humansOnly).toBe(true);

    const entries = (await t.api(owner).call('warehouse.erasureBacklog', { id: exportId, limit: 200 })).entries;
    expect(entries).toHaveLength(2);
    const [first, second] = entries.map((e) => e.erasureId).sort() as [string, string];

    // A cleanup note is required, and an id outside the backlog cannot be acknowledged.
    expect(
      await rejects(t.api(owner).call('warehouse.acknowledgeErasures', { id: exportId, erasureIds: [first], note: '   ' })),
    ).toBeTruthy();
    expect(
      await rejects(
        t.api(owner).call('warehouse.acknowledgeErasures', { id: exportId, erasureIds: ['era_not_in_backlog'], note: 'Cleaned elsewhere' }),
      ),
    ).toBeTruthy();

    const acknowledged = await t.api(owner).call('warehouse.acknowledgeErasures', {
      id: exportId,
      erasureIds: [first],
      note: 'Deleted the remaining events for this person from the analytics copy.',
    });
    expect(acknowledged).toEqual({ acknowledged: 1, remaining: 1 });
    // Only the selected entry is gone; the other one keeps the export failed and visible.
    const left = await t.api(owner).call('warehouse.erasureBacklog', { id: exportId, limit: 200 });
    expect(left.entries.map((e) => e.erasureId)).toEqual([second]);
    const pending = await exportRow();
    expect(pending.lastStatus).toBe('failed');
    expect(pending.lastError).toContain('erasure cleanup pending');
    expect(pending.backlogCount).toBe(1);

    expect(
      await t.api(owner).call('warehouse.acknowledgeErasures', {
        id: exportId,
        erasureIds: [second],
        note: 'Removed the remaining events from the analytics copy too.',
      }),
    ).toEqual({ acknowledged: 1, remaining: 0 });
    const cleared = await exportRow();
    expect(cleared.backlogCount).toBe(0);
    expect(cleared.lastStatus).toBe('ok');
    expect(cleared.lastError).toBeNull();
    expect(await backlogRowCount()).toBe(0);
  });

  it('preserves an unrelated run failure during partial and final acknowledgement', async () => {
    const first = await erase('0');
    const second = await erase('9');
    await t.srv.db.admin.query('DELETE FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws]);
    await sleep(10);
    expect((await run()).status).toBe('failed');
    expect(await backlogRowCount()).toBe(2);
    await t.srv.db.admin.query(
      "UPDATE warehouse_exports SET last_status = 'failed', last_error = 'Destination connection refused' WHERE workspace_id = $1 AND id = $2",
      [ws, exportId],
    );
    for (const erasureId of [first, second]) {
      await t.api(owner).call('warehouse.acknowledgeErasures', {
        id: exportId,
        erasureIds: [erasureId],
        note: 'Manually removed this person from the downstream copy.',
      });
      expect(await exportRow()).toMatchObject({ lastStatus: 'failed', lastError: 'Destination connection refused' });
    }
    expect(await backlogRowCount()).toBe(0);
    expect((await run()).status).toBe('ok');
  });

  it('drops remaining private keys and backlog when the final destination is removed', async () => {
    await erase('e');
    await t.srv.db.admin.query('DELETE FROM warehouse_erasure_keys WHERE workspace_id = $1', [ws]);
    await sleep(10);
    expect((await run()).status).toBe('failed');
    expect(await backlogRowCount()).toBe(1);

    await erase('f');
    expect(await keys()).toHaveLength(1);
    await t.api(owner).call('warehouse.delete', { id: exportId });
    expect(await keys()).toEqual([]);
    expect(
      (await t.srv.db.admin.query('SELECT count(*) AS n FROM warehouse_erasure_backlog WHERE workspace_id = $1', [ws])).rows[0].n,
    ).toBe('0');
  });
});
