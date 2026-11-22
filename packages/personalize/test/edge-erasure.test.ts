import type { Db } from '@agentic-marketing/db';
import type { HotState } from '@agentic-marketing/hotstate';
import { describe, expect, it, vi } from 'vitest';
import { edgeMirror } from '../src/edge';

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
