/**
 * Client-side draft bookkeeping for the artifact detail page (#381).
 *
 * A refetch after every save gives the server content a new identity even when the content did not
 * change. Blindly adopting it drops edits typed while the save was in flight. These pure decisions
 * keep the local draft until the server content actually contains it, and ignore responses that
 * belong to an older save or a document the person already left.
 */

/** Stable comparison key for draft content; `undefined` is a real value here. */
export function draftJson(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? 'undefined' : json;
}

export interface DraftSyncState {
  /** The artifact the local draft belongs to. */
  artifactId: string | null;
  /** Serialized content the server is known to hold. */
  synced: string | null;
  /** Sequence of the latest save attempt. */
  saveSeq: number;
  /** Sequence whose response may still change the page. */
  latestSave: number;
}

export function createDraftSync(): DraftSyncState {
  return { artifactId: null, synced: null, saveSeq: 0, latestSave: 0 };
}

/** Starts a save and returns the ticket its response must present to be applied. */
export function beginSave(
  state: DraftSyncState,
  artifactId: string,
  draft: unknown,
): { state: DraftSyncState; seq: number; snapshot: string } {
  const seq = state.saveSeq + 1;
  return {
    state: { ...state, artifactId, saveSeq: seq, latestSave: seq },
    seq,
    snapshot: draftJson(draft),
  };
}

/** A response is current only when it is the latest save for the artifact still on screen. */
export function saveResponseIsCurrent(state: DraftSyncState, seq: number, activeArtifactId: string): boolean {
  return state.latestSave === seq && state.artifactId === activeArtifactId;
}

/** Records what the server now holds, without adopting it over edits made during the save. */
export function markSaved(state: DraftSyncState, snapshot: string): DraftSyncState {
  return { ...state, synced: snapshot };
}

/** Switches documents: the new artifact's first refetch always wins over the old draft. */
export function switchArtifact(state: DraftSyncState, _artifactId: string): DraftSyncState {
  // No artifact owns the draft until the new document's snapshot arrives, and the old save is stale.
  return { ...state, artifactId: null, synced: null, latestSave: state.saveSeq };
}

/**
 * Whether an incoming server snapshot may replace the local draft.
 *
 * - A new document, or a draft that has not loaded yet, adopts.
 * - Equal content adopts (refreshes the identity without touching text).
 * - Local edits are kept until a save has recorded them as synced.
 */
export function shouldAdoptSnapshot(state: DraftSyncState, activeArtifactId: string, localDraft: unknown, serverContent: unknown): boolean {
  if (state.artifactId !== activeArtifactId) return true;
  if (localDraft === undefined) return true;
  const local = draftJson(localDraft);
  if (local === draftJson(serverContent)) return true;
  return state.synced !== null && local === state.synced;
}

/** Marks the adopted server content as the new baseline. */
export function adoptSnapshot(state: DraftSyncState, artifactId: string, serverContent: unknown): DraftSyncState {
  return { ...state, artifactId, synced: draftJson(serverContent) };
}

/** The autosave timer's eligibility, including a failed snapshot that must not retry unchanged. */
export function shouldScheduleAutosave(state: {
  autosave: boolean;
  dirty: boolean;
  readOnly: boolean;
  saving: boolean;
  conflict: boolean;
  snapshot: string;
  failedSnapshot: string | null;
}): boolean {
  return state.autosave && state.dirty && !state.readOnly && !state.saving && !state.conflict && state.snapshot !== state.failedSnapshot;
}
