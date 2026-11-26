import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// #1264: the preview card still called a message-rule count the segment's size "now", and it
// printed a snapshot's source segment as its raw id while the rest of the UI shows names.

const SEG = `seg_${'a'.repeat(32)}`;
const h = vi.hoisted(() => ({ fail: false }));

vi.mock('../src/app/session', () => ({ useSession: () => ({ can: () => true }) }));
vi.mock('../src/features/artifactCache', () => ({
  useArtifactRef: (id?: string | null) =>
    id
      ? h.fail
        ? { artifact: null, error: 'Not found' }
        : { artifact: { id, type: 'segment', name: 'Weekly readers', publishedVersion: 2 }, error: null }
      : { artifact: null, error: null },
}));

import { SegmentPreview } from '../src/features/previews/SegmentPreview';

const renderPreview = (content: Record<string, unknown>) =>
  render(<SegmentPreview artifactId={SEG} source={{ kind: 'unsaved', baseVersion: 3 }} content={content} />);

afterEach(() => {
  cleanup();
  h.fail = false;
});

describe('segment preview size card (#1264)', () => {
  it('labels a message rule as live data and says membership moves at the next refresh', () => {
    renderPreview({ mode: 'dynamic', condition: { message: 'opened', within: 'P7D' } });

    expect(screen.getByText('Estimated size from live data')).toBeTruthy();
    expect(screen.getByText('Membership updates at the next scheduled refresh, not as messages arrive.')).toBeTruthy();
    expect(screen.queryByText('Estimated size now')).toBeNull();
  });

  it('keeps the caveat off a rule without a message leaf', () => {
    renderPreview({ mode: 'dynamic', condition: { trait: 'city', op: 'eq', value: 'Aarhus' } });
    expect(screen.getByText('Estimated size from live data')).toBeTruthy();
    expect(screen.queryByText('Membership updates at the next scheduled refresh, not as messages arrive.')).toBeNull();
  });

  it('names the snapshot’s source segment and its captured version, without the source’s live pill', () => {
    renderPreview({ mode: 'snapshot', sourceSegment: SEG, snapshotVersion: 4 });

    expect(screen.getByText('Weekly readers')).toBeTruthy();
    expect(document.body.textContent).toContain('A frozen snapshot of');
    expect(document.body.textContent).toContain('captured at v4');
    expect(document.body.textContent).not.toContain('Live v');
    expect(document.body.textContent).not.toContain(SEG);
  });

  it('uses a neutral fallback when the source lookup fails, never the raw id', () => {
    h.fail = true;
    renderPreview({ mode: 'snapshot', sourceSegment: SEG, snapshotVersion: 4 });

    expect(document.body.textContent).toContain('an unavailable segment');
    expect(document.body.textContent).toContain('captured at v4');
    expect(document.body.textContent).not.toContain(SEG);
  });
});
