import { describe, expect, it } from 'vitest';
import { contrast } from '../src/features/brand/defaults';

// The brand editor warns about low contrast but never blocks saving (#112). This covers the
// pure WCAG helper behind that warning: #rgb and #rrggbb only, null for anything else.
describe('brand contrast', () => {
  it('computes the WCAG ratio for #rgb and #rrggbb', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrast('#fff', '#000')).toBeCloseTo(21);
    // The bug's default: the intended accentText is white, but the button inherited the text
    // colour, so the confirm button read #111827 on #1d4ed8.
    expect(contrast('#111827', '#1d4ed8')).toBeCloseTo(2.65, 1);
  });

  it('returns null for anything that is not a three- or six-digit hex colour', () => {
    expect(contrast('red', '#ffffff')).toBeNull();
    expect(contrast('#12345', '#ffffff')).toBeNull();
    expect(contrast('#gggggg', '#ffffff')).toBeNull();
  });
});
