import { describe, expect, it } from 'vitest';

// The packages project runs with TZ pinned in vitest.config.mts; this fails loudly if that changes.
describe('test environment determinism', () => {
  it('runs in UTC', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(new Date().getTimezoneOffset()).toBe(0);
    expect(new Date('2026-01-15T12:00:00Z').getHours()).toBe(12);
    expect(new Date('2026-07-15T12:00:00Z').getHours()).toBe(12);
  });
});
