import { describe, expect, it } from 'vitest';
import { isUndoable } from '../src/undo';

const ran = { ok: true, decision: 'allow', undoneAt: null };

describe('isUndoable (#301)', () => {
  it('offers undo for a reversal that records the published version', () => {
    expect(isUndoable({ ...ran, undo: { kind: 'republish', artifactId: 'a', previousVersion: 1, publishedVersion: 2 } })).toBe(true);
  });

  it('does not offer undo for a record from before 0.5.2, alone or in a group', () => {
    expect(isUndoable({ ...ran, undo: { kind: 'republish', artifactId: 'a', previousVersion: 1 } })).toBe(false);
    expect(
      isUndoable({
        ...ran,
        undo: {
          kind: 'group',
          items: [
            { kind: 'republish', artifactId: 'b', previousVersion: null },
            { kind: 'cancel_send', broadcastId: 'b' },
          ],
        },
      }),
    ).toBe(false);
  });

  it('does not offer undo for what did not run, was undone, or cannot be reversed', () => {
    const undo = { kind: 'republish' as const, artifactId: 'a', previousVersion: 1, publishedVersion: 2 };
    expect(isUndoable({ ...ran, undo, undoneAt: new Date() })).toBe(false);
    expect(isUndoable({ ...ran, undo, decision: 'deny' })).toBe(false);
    expect(isUndoable({ ...ran, undo: { kind: 'none', reason: 'sent' } })).toBe(false);
  });
});
