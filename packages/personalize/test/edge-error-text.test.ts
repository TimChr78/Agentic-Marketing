import { describe, expect, it } from 'vitest';
import { edgeErrorText } from '../src/edge';

// #885 round 6: a background edge sync stores its failure in the experience's status and in
// `edge_targets.last_error`. A driver or a Cloudflare answer can echo a credential, so the text is
// redacted while it is complete, then cut.

describe('edge sync failure text (#885)', () => {
  it('redacts a credential an exception carries', () => {
    const text = edgeErrorText(new Error('driver failure: password=probe-secret'));
    expect(text).toContain('driver failure');
    expect(text).not.toContain('probe-secret');
  });

  it('redacts before cutting a long message', () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    const text = edgeErrorText(new Error(`${' '.repeat(490)}${token}`));
    expect(text).not.toContain('a1b2c3d4e5f60718');
    expect(text.length).toBeLessThanOrEqual(500);
  });
});
