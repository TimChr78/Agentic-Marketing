import { describe, expect, it } from 'vitest';
import { type EdgeSettings, planEdgeConfigure } from '../src/edge';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const base: EdgeSettings = {
  accountId: A,
  namespaceId: B,
  apiBase: null,
  snapshots: true,
  enabled: true,
  bundleHash: 'hash-of-the-bundle',
  pushedKeys: ['am:exp:ws', 'am:key:abc'],
  backfillCursor: null,
  cleanupMode: null,
  priorTarget: null,
};

describe('edge.configure state', () => {
  it('starts a new target with a backfill', () => {
    const plan = planEdgeConfigure(null, { accountId: A, namespaceId: B, enabled: true });
    expect(plan).toMatchObject({ backfillCursor: '', bundleHash: null, pushedKeys: [], cleanupMode: null, priorTarget: null });
  });

  it('does not backfill a new target when snapshots are off', () => {
    const plan = planEdgeConfigure(null, { accountId: A, namespaceId: B, snapshots: false });
    expect(plan.backfillCursor).toBeNull();
  });

  it('keeps a rotated token from rebuilding the bundle or the snapshots', () => {
    const plan = planEdgeConfigure(base, { accountId: A, namespaceId: B });
    expect(plan).toMatchObject({
      bundleHash: base.bundleHash,
      pushedKeys: base.pushedKeys,
      backfillCursor: null,
      cleanupMode: null,
    });
  });

  it('restarts the backfill on a new namespace and records the old copies', () => {
    const plan = planEdgeConfigure(base, { accountId: A, namespaceId: 'c'.repeat(32) });
    expect(plan).toMatchObject({ backfillCursor: '', bundleHash: null, pushedKeys: [], cleanupMode: 'all' });
    expect(plan.priorTarget).toEqual([{ accountId: A, namespaceId: B, apiBase: null, keys: base.pushedKeys }]);
  });

  it('restarts the backfill on a new account and keeps every earlier destination', () => {
    const movedOnce: EdgeSettings = {
      ...base,
      accountId: 'c'.repeat(32),
      priorTarget: [{ accountId: A, namespaceId: B, apiBase: null, keys: [] }],
    };
    const plan = planEdgeConfigure(movedOnce, { accountId: 'd'.repeat(32), namespaceId: B });
    expect(plan.priorTarget?.map((p) => p.accountId).sort()).toEqual(['c'.repeat(32), A].sort());
  });

  it('cleans a destination it is about to reuse instead of keeping it stale', () => {
    const plan = planEdgeConfigure(
      { ...base, accountId: 'c'.repeat(32), priorTarget: [{ accountId: A, namespaceId: B, apiBase: null, keys: [] }] },
      { accountId: A, namespaceId: B },
    );
    // The reused namespace is cleared by cleanupMode; the destination just left stays queued.
    expect(plan.priorTarget?.map((p) => p.accountId)).toEqual(['c'.repeat(32)]);
    expect(plan.cleanupMode).toBe('all');
  });

  it('backfills when snapshots are turned back on', () => {
    const off: EdgeSettings = { ...base, snapshots: false, backfillCursor: null };
    const plan = planEdgeConfigure(off, { accountId: A, namespaceId: B, snapshots: true });
    expect(plan).toMatchObject({ backfillCursor: '', cleanupMode: null });
  });

  it('owes a full cleanup when the mirror is disabled', () => {
    const plan = planEdgeConfigure(base, { accountId: A, namespaceId: B, enabled: false });
    expect(plan).toMatchObject({ cleanupMode: 'all', backfillCursor: null, pushedKeys: base.pushedKeys });
  });

  it('owes a snapshot cleanup, but keeps serving the bundle, when only snapshots are disabled', () => {
    const plan = planEdgeConfigure(base, { accountId: A, namespaceId: B, snapshots: false });
    expect(plan).toMatchObject({
      cleanupMode: 'snapshots',
      bundleHash: base.bundleHash,
      pushedKeys: base.pushedKeys,
      backfillCursor: null,
    });
  });

  it('keeps the owed cleanup when a disabled target is enabled again, so serving waits for it', () => {
    const disabled: EdgeSettings = { ...base, enabled: false, cleanupMode: 'all', backfillCursor: null };
    const plan = planEdgeConfigure(disabled, { accountId: A, namespaceId: B, enabled: true });
    expect(plan).toMatchObject({ cleanupMode: 'all', backfillCursor: '', bundleHash: null });
  });

  it('does not owe a new cleanup every time an already disabled target is reconfigured', () => {
    const disabled: EdgeSettings = { ...base, enabled: false, cleanupMode: null, backfillCursor: null };
    const plan = planEdgeConfigure(disabled, { accountId: A, namespaceId: B, enabled: false });
    expect(plan.cleanupMode).toBeNull();
  });
  it('preserves a custom API base on a token-only rotation', () => {
    const plan = planEdgeConfigure({ ...base, apiBase: 'https://kv.example.com' }, { accountId: A, namespaceId: B });
    expect(plan).toMatchObject({ apiBase: 'https://kv.example.com', bundleHash: base.bundleHash, cleanupMode: null, priorTarget: null });
  });

  it('tracks old write keys when returning to an earlier namespace', () => {
    const plan = planEdgeConfigure(
      { ...base, namespaceId: 'c'.repeat(32), priorTarget: [{ accountId: A, namespaceId: B, apiBase: null, keys: ['am:key:retired'] }] },
      { accountId: A, namespaceId: B },
    );
    expect(plan.pushedKeys).toEqual(['am:key:retired']);
    expect(plan.cleanupMode).toBe('all');
  });
});
