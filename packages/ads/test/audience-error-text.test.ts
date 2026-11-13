import { describe, expect, it } from 'vitest';
import { audienceErrorText } from '../src/audiences';

// #885 round 6: an audience sync stores its failure in the sync result, in a member's `lastError`
// and in the audit log. An exception's text can quote a provider or a driver, so it is redacted
// while it is complete, then cut.

describe('audience sync failure text (#885)', () => {
  it('redacts a credential an exception carries', () => {
    const text = audienceErrorText(new Error('driver failure: password=probe-secret'));
    expect(text).toContain('driver failure');
    expect(text).not.toContain('probe-secret');
  });

  it('redacts before cutting a long message', () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    const text = audienceErrorText(new Error(`${' '.repeat(290)}${token}`));
    expect(text).not.toContain('a1b2c3d4e5f60718');
    expect(text.length).toBeLessThanOrEqual(300);
  });
});
