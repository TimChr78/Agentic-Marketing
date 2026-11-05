import { describe, expect, it } from 'vitest';
import { checkDomainRecords, quietUntil } from '../src';

describe('quiet hours', () => {
  const window = { start: '21:00', end: '08:00' };
  it('waits until the window ends in local time, across midnight', () => {
    // 22:30 in Copenhagen (UTC+2 in October) → 08:00 local = 06:00 UTC next day.
    expect(quietUntil(new Date('2026-10-22T20:30:00Z'), window, 'Europe/Copenhagen')?.toISOString()).toBe('2026-10-23T06:00:00.000Z');
    // 06:15 local → 08:00 the same day.
    expect(quietUntil(new Date('2026-10-23T04:15:00Z'), window, 'Europe/Copenhagen')?.toISOString()).toBe('2026-10-23T06:00:00.000Z');
  });
  it('lets messages through outside the window', () => {
    expect(quietUntil(new Date('2026-10-22T10:00:00Z'), window, 'Europe/Copenhagen')).toBeNull();
    expect(quietUntil(new Date('2026-10-22T19:00:00Z'), window, 'UTC')).toBeNull();
    expect(quietUntil(new Date('2026-10-22T12:30:00Z'), { start: '12:00', end: '13:00' }, 'UTC')?.toISOString()).toBe(
      '2026-10-22T13:00:00.000Z',
    );
  });
});

describe('quiet hours across daylight-saving transitions', () => {
  const overnight = { start: '22:00', end: '08:00' };
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  it('ends at 08:00 EDT on the New York spring-forward night, not an hour of wall-clock minutes later', () => {
    // #367: 01:30 EST + 390 wall-clock minutes is 09:00 EDT; the window really ends at 08:00.
    expect(iso(quietUntil(new Date('2026-03-08T06:30:00Z'), overnight, 'America/New_York'))).toBe('2026-03-08T12:00:00.000Z');
    // 01:59:59 EST is still inside; seconds do not move the end.
    expect(iso(quietUntil(new Date('2026-03-08T06:59:59Z'), overnight, 'America/New_York'))).toBe('2026-03-08T12:00:00.000Z');
  });

  it('ends at 08:00 EST on the New York fall-back night', () => {
    // 01:30 EDT is still quiet; the window ends after the repeated hour, at 08:00 EST.
    expect(iso(quietUntil(new Date('2026-11-01T05:30:00Z'), overnight, 'America/New_York'))).toBe('2026-11-01T13:00:00.000Z');
  });

  it('uses the earliest end when the end reading repeats in a fall-back fold', () => {
    const window = { start: '22:00', end: '01:30' };
    // 01:00 EDT (first occurrence) waits for 01:30 EDT = 05:30Z.
    expect(iso(quietUntil(new Date('2026-11-01T05:00:00Z'), window, 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
    // 01:10 EST (second occurrence) waits for 01:30 EST = 06:30Z, not the past first occurrence.
    expect(iso(quietUntil(new Date('2026-11-01T06:10:00Z'), window, 'America/New_York'))).toBe('2026-11-01T06:30:00.000Z');
  });

  it('ends at the spring-forward jump when the end reading is skipped', () => {
    const window = { start: '22:00', end: '02:30' };
    // 01:30 and 01:59 EST both wait for 03:00 EDT, the first instant past the skipped 02:30.
    expect(iso(quietUntil(new Date('2026-03-08T06:30:00Z'), window, 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(quietUntil(new Date('2026-03-08T06:59:00Z'), window, 'America/New_York'))).toBe('2026-03-08T07:00:00.000Z');
  });

  it('handles a half-hour transition (Lord Howe Island)', () => {
    // DST starts 2026-10-04 02:00 +10:30 -> 02:30 +11:00.
    expect(iso(quietUntil(new Date('2026-10-03T14:00:00Z'), overnight, 'Australia/Lord_Howe'))).toBe('2026-10-03T21:00:00.000Z');
    // An end inside the 30-minute gap ends at the jump (02:30 +11:00 = 15:30Z).
    expect(iso(quietUntil(new Date('2026-10-03T14:00:00Z'), { start: '22:00', end: '02:15' }, 'Australia/Lord_Howe'))).toBe(
      '2026-10-03T15:30:00.000Z',
    );
    // DST ends 2026-04-05 02:00 +11:00 -> 01:30 +10:30; 01:45 repeats, so the earlier one wins.
    expect(iso(quietUntil(new Date('2026-04-04T14:00:00Z'), { start: '22:00', end: '01:45' }, 'Australia/Lord_Howe'))).toBe(
      '2026-04-04T14:45:00.000Z',
    );
  });

  it('ends when a rollback crosses the start backwards, before the nominal end', () => {
    expect(iso(quietUntil(new Date('2026-11-01T05:45:00Z'), { start: '01:30', end: '02:30' }, 'America/New_York'))).toBe(
      '2026-11-01T06:00:00.000Z',
    );
    expect(iso(quietUntil(new Date('2026-11-01T05:45:00Z'), { start: '01:30', end: '01:00' }, 'America/New_York'))).toBe(
      '2026-11-01T06:00:00.000Z',
    );
    expect(iso(quietUntil(new Date('2026-04-04T14:50:00Z'), { start: '01:45', end: '02:30' }, 'Australia/Lord_Howe'))).toBe(
      '2026-04-04T15:00:00.000Z',
    );
  });

  it("re-resolves today's overnight end after a rollback stays inside quiet hours", () => {
    expect(iso(quietUntil(new Date('2026-11-01T05:45:00Z'), { start: '01:30', end: '01:15' }, 'America/New_York'))).toBe(
      '2026-11-01T06:15:00.000Z',
    );
    expect(iso(quietUntil(new Date('2026-04-04T14:50:00Z'), { start: '01:45', end: '01:40' }, 'Australia/Lord_Howe'))).toBe(
      '2026-04-04T15:10:00.000Z',
    );
  });

  it('does not end inside quiet hours when a date-line jump skips the end date', () => {
    expect(iso(quietUntil(new Date('2011-12-30T09:00:00Z'), overnight, 'Pacific/Apia'))).toBe('2011-12-30T18:00:00.000Z');
  });

  it('uses the same wall-clock end in a zone without daylight saving', () => {
    // 05:00 JST on 2026-03-09 -> 08:00 JST = 2026-03-08T23:00Z.
    expect(iso(quietUntil(new Date('2026-03-08T20:00:00Z'), overnight, 'Asia/Tokyo'))).toBe('2026-03-08T23:00:00.000Z');
  });

  it('keeps ordinary boundaries and equal start/end semantics', () => {
    expect(quietUntil(new Date('2026-10-22T21:59:00Z'), overnight, 'UTC')).toBeNull(); // before the window
    expect(iso(quietUntil(new Date('2026-10-22T22:00:00Z'), overnight, 'UTC'))).toBe('2026-10-23T08:00:00.000Z'); // start is quiet
    expect(quietUntil(new Date('2026-10-23T08:00:00Z'), overnight, 'UTC')).toBeNull(); // end is not quiet
    expect(quietUntil(new Date('2026-03-08T12:00:00Z'), { start: '09:00', end: '09:00' }, 'UTC')).toBeNull();
  });

  it('rejects an invalid time zone instead of guessing an offset', () => {
    expect(() => quietUntil(new Date('2026-03-08T06:30:00Z'), overnight, 'Not/A_Zone')).toThrow(RangeError);
  });

  it('rounds the deferred instant up to a whole minute', () => {
    const until = quietUntil(new Date('2026-10-22T20:30:30Z'), { start: '21:00', end: '08:00' }, 'Europe/Copenhagen');
    expect(iso(until)).toBe('2026-10-23T06:00:00.000Z');
    expect((until?.getTime() ?? 0) % 60_000).toBe(0);
  });
});

describe('domain check', () => {
  const dns = (records: Record<string, string[]>) => ({
    resolveTxt: async (name: string) => {
      if (!records[name]) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return records[name].map((r) => [r]);
    },
  });

  it('passes a domain with SPF for the provider, DKIM and DMARC', async () => {
    const r = await checkDomainRecords(
      'martechsignal.com',
      'ses',
      ['abc123'],
      dns({
        'martechsignal.com': ['google-site-verification=x', 'v=spf1 include:amazonses.com ~all'],
        'abc123._domainkey.martechsignal.com': ['p=MIGfMA0GCSqGSIb3DQEB'],
        '_dmarc.martechsignal.com': ['v=DMARC1; p=quarantine; rua=mailto:d@martechsignal.com'],
      }),
    );
    expect(r).toMatchObject({
      ok: true,
      spf: { ok: true },
      dkim: [{ selector: 'abc123', ok: true }],
      dmarc: { ok: true, policy: 'quarantine', advice: null },
    });
  });

  it('says what to add', async () => {
    const r = await checkDomainRecords(
      'example.com',
      'postmark',
      ['20240101pm'],
      dns({ 'example.com': ['v=spf1 include:_spf.google.com ~all'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.spf.advice).toContain('include:spf.mtasv.net');
    expect(r.dkim[0].ok).toBe(false);
    expect(r.dmarc.advice).toContain('_dmarc.example.com');
  });
});
