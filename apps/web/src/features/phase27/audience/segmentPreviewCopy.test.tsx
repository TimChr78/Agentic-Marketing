import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SegmentPreview } from '../../previews/SegmentPreview';

vi.mock('../../../app/session', () => ({
  useSession: () => ({ can: () => true }),
}));

afterEach(cleanup);

describe('segment preview copy (#525)', () => {
  it('explains that the preview is the saved version and points to the explicit estimate', () => {
    render(
      <SegmentPreview
        artifactId={`seg_${'a'.repeat(32)}`}
        source={{ kind: 'unsaved', baseVersion: 3 }}
        content={{ mode: 'dynamic', condition: { trait: 'loyaltyTier', op: 'eq', value: 'gold' } }}
      />,
    );
    expect(screen.getByText(/preview shows the saved version/i)).toBeTruthy();
    expect(screen.getByText(/Content → Estimate audience/)).toBeTruthy();
    expect(screen.queryByText(/Save draft to estimate membership/)).toBeNull();
  });
});
