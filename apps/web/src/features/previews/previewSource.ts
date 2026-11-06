// What a preview shows: the unsaved draft in the editor, one exact saved version, or the
// published version. Provenance is presentation only; it never chooses which version is fetched.
// Phase 25 contract (docs/design/phase-25/README.md).

export type PreviewSource =
  | { kind: 'unsaved'; baseVersion: number }
  | { kind: 'saved'; version: number }
  | { kind: 'published'; version: number };

/** The version a source is pinned to, or the saved version an unsaved draft was based on. */
export function sourceVersion(source: PreviewSource): number {
  return source.kind === 'unsaved' ? source.baseVersion : source.version;
}

export const isUnsaved = (source: PreviewSource | undefined): source is Extract<PreviewSource, { kind: 'unsaved' }> =>
  source?.kind === 'unsaved';

/**
 * Default for callers that predate `source`. An explicitly requested version is a Saved vN pin:
 * it is never promoted to Published just because the pointer happens to match. Without a requested
 * version, the returned version is compared with the publication pointer first. `undefined` means
 * the caller has not resolved enough to make a truthful claim, so no label is shown.
 */
export function resolvePreviewSource({
  requestedVersion,
  resolvedVersion,
  publishedVersion,
}: {
  requestedVersion?: number | null;
  resolvedVersion?: number | null;
  publishedVersion?: number | null;
}): PreviewSource | undefined {
  if (requestedVersion != null) return { kind: 'saved', version: requestedVersion };
  if (resolvedVersion == null) return undefined;
  if (publishedVersion != null && publishedVersion === resolvedVersion) return { kind: 'published', version: resolvedVersion };
  return { kind: 'saved', version: resolvedVersion };
}

export interface PreviewLabelText {
  primary: string;
  secondary?: string;
}

/**
 * The two parts of a provenance label: the source line, then an optional reason or context
 * ("Based on Saved v2", "Under review", "In this bundle"). A zero base version means the caller
 * knows the content is local but not which saved version it grew from; no claim is invented.
 */
export function previewLabelText(source: PreviewSource, suffix?: string): PreviewLabelText {
  const extra = suffix?.trim() || undefined;
  if (source.kind === 'unsaved') {
    const basedOn = source.baseVersion > 0 ? `Based on Saved v${source.baseVersion}` : undefined;
    const secondary = [extra, basedOn].filter(Boolean).join(' · ') || undefined;
    return { primary: 'Unsaved draft', ...(secondary ? { secondary } : {}) };
  }
  return {
    primary: source.kind === 'published' ? `Published v${source.version}` : `Saved v${source.version}`,
    ...(extra ? { secondary: extra } : {}),
  };
}
