import type { Db } from '@agentic-marketing/db';
import type { HotState } from '@agentic-marketing/hotstate';
import { describe, expect, it, vi } from 'vitest';
import { edgeMirror, latestOutboxValues, snapshotSubject, tombstonedSnapshotKeys } from '../src/edge';

describe('edge erasure lookup failure', () => {
  it('fails erasure instead of silently dropping remote deletion when the target lookup fails', async () => {
    const hot = { deleteSnapshot: vi.fn().mockResolvedValue(undefined) } as unknown as HotState;
    const db = { admin: { query: vi.fn().mockRejectedValue(new Error('target lookup unavailable')) } } as unknown as Db;
    await expect(edgeMirror(hot, db).deleteSnapshot('ws', { anonymousIds: ['visitor'], userIds: [] })).rejects.toThrow(
      'target lookup unavailable',
    );
    expect(hot.deleteSnapshot).toHaveBeenCalled();
  });
});

describe('an erased snapshot is never republished to the edge (#1196 review)', () => {
  it('queues only the ids the local fenced write accepted', async () => {
    const queued: unknown[][] = [];
    const hot = {
      writeSnapshot: vi.fn().mockResolvedValue({ anonymousIds: ['alive'], userIds: [] }),
    } as unknown as HotState;
    const db = {
      admin: {
        query: vi.fn(async (text: string, params?: unknown[]) => {
          // `enabled` asks whether the target serves snapshots; the outbox insert follows it.
          if (text.startsWith('SELECT 1 FROM edge_targets')) return { rows: [], rowCount: 1 };
          queued.push(params ?? []);
          return { rows: [], rowCount: 1 };
        }),
      },
    } as unknown as Db;
    const snapshot = { profileId: 'prf', traits: { tier: 'gold' }, segments: [], at: '2026-11-22T10:00:00.000Z' };

    const written = await edgeMirror(hot, db).writeSnapshot(
      'ws-only-accepted',
      { anonymousIds: ['erased', 'alive'], userIds: [] },
      snapshot,
    );

    expect(written).toEqual({ anonymousIds: ['alive'], userIds: [] });
    expect(queued).toEqual([['ws-only-accepted', ['am:snap:ws-only-accepted:a:alive'], JSON.stringify(snapshot)]]);
  });

  it('lets an erasure delete win over a put queued after it for the same key', () => {
    // The refresh's local write was accepted before the fence, its put was queued after the
    // erasure's delete: the delete must still be what the sync applies.
    const rows = [
      { key: 'am:snap:ws:a:visitor', value: { profileId: 'prf_stale' } },
      { key: 'am:snap:ws:a:visitor', value: null },
      { key: 'am:snap:ws:a:visitor', value: { profileId: 'prf_late' } },
    ];
    expect(latestOutboxValues(rows).get('am:snap:ws:a:visitor')).toBeNull();
    expect(
      latestOutboxValues([
        { key: 'k', value: null },
        { key: 'k', value: { v: 2 } },
      ]).get('k'),
    ).toBeNull();
    // Without an erasure, the latest put still wins as before.
    expect(
      latestOutboxValues([
        { key: 'k', value: { v: 1 } },
        { key: 'k', value: { v: 2 } },
      ]).get('k'),
    ).toEqual({ v: 2 });
  });

  it('drops a put whose subject is tombstoned at sync time, even in a later batch', async () => {
    const hot = {
      tombstonedIds: vi.fn().mockResolvedValue({ anonymousIds: ['erased'], userIds: [] }),
    } as unknown as HotState;
    const keys = ['am:snap:ws:a:erased', 'am:snap:ws:a:alive', 'am:snap:ws:u:user'];

    expect(snapshotSubject('ws', 'am:snap:ws:a:erased')).toEqual({ kind: 'a', id: 'erased' });
    expect(snapshotSubject('ws', 'am:snap:ws:b:other')).toBeNull();
    expect(await tombstonedSnapshotKeys(hot, 'ws', keys)).toEqual(new Set(['am:snap:ws:a:erased']));
    expect(hot.tombstonedIds).toHaveBeenCalledWith('ws', {
      anonymousIds: ['erased', 'alive'],
      userIds: ['user'],
    });
  });
});
