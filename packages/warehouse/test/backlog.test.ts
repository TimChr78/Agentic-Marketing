import { describe, expect, it } from 'vitest';
import { CLEANUP_PENDING_PREFIX, cleanupPendingWarning, INCOMPLETE_ERASURE_PREFIX, pendingErasureWarning } from '../src/run';

// B2: an incomplete erasure no longer pins the cursor. The outstanding manual cleanup lives in the
// backlog, and its warning must survive later otherwise-successful empty runs.
describe('erasure cleanup backlog warnings', () => {
  it('names an erasure the destination could not apply', () => {
    expect(pendingErasureWarning([{ id: 'era_1', uncovered: ['events'] }], 1)).toContain(INCOMPLETE_ERASURE_PREFIX);
  });

  it('stays failed while an older backlog entry is still unacknowledged', () => {
    const warning = pendingErasureWarning([], 2);
    expect(warning).toBe(cleanupPendingWarning(2));
    expect(warning).toContain(CLEANUP_PENDING_PREFIX);
    expect(warning).toContain('warehouse.acknowledgeErasures');
  });

  it('is healthy only when nothing is incomplete and the backlog is empty', () => {
    expect(pendingErasureWarning([], 0)).toBeNull();
  });
});
