import { describe, expect, it } from 'vitest';
import {
  adoptSnapshot,
  beginSave,
  createDraftSync,
  draftJson,
  markSaved,
  saveResponseIsCurrent,
  shouldAdoptSnapshot,
  shouldScheduleAutosave,
  switchArtifact,
} from '../src/features/artifacts/draftSync';

describe('artifact draft sync (#381)', () => {
  it('keeps edits typed while a delayed save is in flight', () => {
    const initial = { nodes: [] };
    let state = adoptSnapshot(createDraftSync(), 'jrn_1', initial);

    // The first edit starts saving; the person then types a second edit before it returns.
    const first = beginSave(state, 'jrn_1', { nodes: ['A'] });
    state = first.state;
    const localDraft = { nodes: ['A', 'B'] };

    // The delayed save persists A, then the guaranteed post-save refetch returns A again.
    state = markSaved(state, first.snapshot);

    expect(shouldAdoptSnapshot(state, 'jrn_1', localDraft, { nodes: ['A'] })).toBe(false);
    // The draft is still dirty against the new server snapshot, so autosave re-arms after saving ends.
    expect(
      shouldScheduleAutosave({
        autosave: true,
        dirty: true,
        readOnly: false,
        saving: false,
        conflict: false,
        snapshot: draftJson(localDraft),
        failedSnapshot: null,
      }),
    ).toBe(true);
  });

  it('adopts a refetch when nothing was typed since the last save', () => {
    const initial = { nodes: [] };
    let state = adoptSnapshot(createDraftSync(), 'jrn_1', initial);
    const started = beginSave(state, 'jrn_1', { nodes: ['A'] });
    state = markSaved(started.state, started.snapshot);

    expect(shouldAdoptSnapshot(state, 'jrn_1', { nodes: ['A'] }, { nodes: ['A'] })).toBe(true);
  });

  it('ignores an out-of-order response from an older save attempt', () => {
    let state = adoptSnapshot(createDraftSync(), 'jrn_1', { nodes: [] });
    const older = beginSave(state, 'jrn_1', { nodes: ['A'] });
    state = older.state;
    const newer = beginSave(state, 'jrn_1', { nodes: ['A', 'B'] });
    state = newer.state;

    expect(saveResponseIsCurrent(state, older.seq, 'jrn_1')).toBe(false);
    expect(saveResponseIsCurrent(state, newer.seq, 'jrn_1')).toBe(true);
  });

  it('drops a save response and the old draft after switching documents', () => {
    let state = adoptSnapshot(createDraftSync(), 'jrn_1', { nodes: ['A'] });
    const inFlight = beginSave(state, 'jrn_1', { nodes: ['A', 'B'] });
    state = switchArtifact(inFlight.state, 'jrn_2');

    expect(saveResponseIsCurrent(state, inFlight.seq, 'jrn_2')).toBe(false);
    // The new document's first snapshot wins even though the old draft was dirty.
    expect(shouldAdoptSnapshot(state, 'jrn_2', { nodes: ['A', 'B'] }, { nodes: ['X'] })).toBe(true);
  });

  it('cannot revive an old save after leaving and returning to the same document', () => {
    let state = adoptSnapshot(createDraftSync(), 'jrn_1', { nodes: ['A'] });
    const oldVisit = beginSave(state, 'jrn_1', { nodes: ['A', 'B'] });
    state = adoptSnapshot(switchArtifact(oldVisit.state, 'jrn_2'), 'jrn_2', { nodes: ['X'] });
    state = adoptSnapshot(switchArtifact(state, 'jrn_1'), 'jrn_1', { nodes: ['A'] });
    expect(saveResponseIsCurrent(state, oldVisit.seq, 'jrn_1')).toBe(false);
    const newVisit = beginSave(state, 'jrn_1', { nodes: ['C'] });
    expect(saveResponseIsCurrent(newVisit.state, newVisit.seq, 'jrn_1')).toBe(true);
  });

  it('keeps local edits on an ordinary refetch but follows the server when untouched', () => {
    let state = adoptSnapshot(createDraftSync(), 'jrn_1', { title: 'A' });

    expect(shouldAdoptSnapshot(state, 'jrn_1', { title: 'B' }, { title: 'A' })).toBe(false);
    state = adoptSnapshot(state, 'jrn_1', { title: 'A' });
    expect(shouldAdoptSnapshot(state, 'jrn_1', { title: 'A' }, { title: 'C' })).toBe(true);
  });

  it('does not retry the same failed snapshot, but retries after a change', () => {
    const failed = draftJson({ title: 'A' });
    const base = { autosave: true, dirty: true, readOnly: false, saving: false, conflict: false, failedSnapshot: failed };

    expect(shouldScheduleAutosave({ ...base, snapshot: failed })).toBe(false);
    expect(shouldScheduleAutosave({ ...base, snapshot: draftJson({ title: 'B' }) })).toBe(true);
    expect(shouldScheduleAutosave({ ...base, snapshot: failed, saving: true })).toBe(false);
    expect(shouldScheduleAutosave({ ...base, snapshot: failed, conflict: true })).toBe(false);
  });
});
