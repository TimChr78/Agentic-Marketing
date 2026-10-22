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
