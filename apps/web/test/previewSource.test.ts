import { describe, expect, it } from 'vitest';
import { isUnsaved, previewLabelText, resolvePreviewSource, sourceVersion } from '../src/features/previews/previewSource';

// The shared preview provenance contract (#499). Defaults must never infer Published from a
// missing version: a caller omission says nothing about the publication pointer.

describe('resolvePreviewSource', () => {
  it('treats an explicitly requested version as Saved vN, even when it is the published version', () => {
    expect(resolvePreviewSource({ requestedVersion: 3, resolvedVersion: 3, publishedVersion: 3 })).toEqual({
      kind: 'saved',
      version: 3,
    });
  });

  it('labels a returned version as Published only when it equals the publication pointer', () => {
    expect(resolvePreviewSource({ resolvedVersion: 4, publishedVersion: 4 })).toEqual({ kind: 'published', version: 4 });
    expect(resolvePreviewSource({ resolvedVersion: 5, publishedVersion: 4 })).toEqual({ kind: 'saved', version: 5 });
  });

  it('does not infer Published when the pointer is unknown, and makes no claim when nothing resolved', () => {
    expect(resolvePreviewSource({ resolvedVersion: 2 })).toEqual({ kind: 'saved', version: 2 });
    expect(resolvePreviewSource({})).toBeUndefined();
    expect(resolvePreviewSource({ publishedVersion: 2 })).toBeUndefined();
  });

  it('returns the base version for an unsaved draft and the pinned version otherwise', () => {
    expect(sourceVersion({ kind: 'unsaved', baseVersion: 2 })).toBe(2);
    expect(sourceVersion({ kind: 'saved', version: 3 })).toBe(3);
    expect(sourceVersion({ kind: 'published', version: 4 })).toBe(4);
    expect(isUnsaved({ kind: 'unsaved', baseVersion: 2 })).toBe(true);
    expect(isUnsaved({ kind: 'saved', version: 2 })).toBe(false);
  });
});

describe('previewLabelText', () => {
  it('says what an unsaved draft was based on', () => {
    expect(previewLabelText({ kind: 'unsaved', baseVersion: 2 })).toEqual({
      primary: 'Unsaved draft',
      secondary: 'Based on Saved v2',
    });
  });

  it('keeps a suffix beside an unsaved draft', () => {
    expect(previewLabelText({ kind: 'unsaved', baseVersion: 2 }, 'Under review')).toEqual({
      primary: 'Unsaved draft',
      secondary: 'Under review · Based on Saved v2',
    });
  });

  it('does not invent a base version it was not given', () => {
    expect(previewLabelText({ kind: 'unsaved', baseVersion: 0 })).toEqual({ primary: 'Unsaved draft' });
  });

  it('names saved and published versions and appends context', () => {
    expect(previewLabelText({ kind: 'saved', version: 2 })).toEqual({ primary: 'Saved v2' });
    expect(previewLabelText({ kind: 'published', version: 3 }, 'In this bundle')).toEqual({
      primary: 'Published v3',
      secondary: 'In this bundle',
    });
  });
});
