import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quietUntil } from '@agentic-marketing/email';
import { describe, expect, it } from 'vitest';

// 0.7.5 delivery/dependency guards (#367, #406). The pure quiet-hours cases live in
// packages/email/test/policy.test.ts; this file repeats the reported spring-forward repro in the
// project the release gate runs, and pins the production dependency remediation so a later bump
// cannot silently bring the unpatched deepmerge back. Static reads only: no provider, no network.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string) => readFile(join(root, name), 'utf8');

describe('#367 quiet hours resolve the real window end across a DST transition', () => {
  it('ends at 08:00 EDT on the New York spring-forward night', () => {
    // 01:30 EST on 2026-03-08; adding 390 wall-clock minutes would land at 09:00 EDT (13:00Z).
    const until = quietUntil(new Date('2026-03-08T06:30:00Z'), { start: '22:00', end: '08:00' }, 'America/New_York');
    expect(until?.toISOString()).toBe('2026-03-08T12:00:00.000Z');
  });
  it('ends a short quiet interval when fall-back crosses its start backwards', () => {
    expect(quietUntil(new Date('2026-11-01T05:45:00Z'), { start: '01:30', end: '02:30' }, 'America/New_York')?.toISOString()).toBe(
      '2026-11-01T06:00:00.000Z',
    );
  });
  it("uses today's end when a rollback remains in the overnight quiet tail", () => {
    expect(quietUntil(new Date('2026-11-01T05:45:00Z'), { start: '01:30', end: '01:15' }, 'America/New_York')?.toISOString()).toBe(
      '2026-11-01T06:15:00.000Z',
    );
  });
});

describe('#406 the production e-mail chain no longer uses the unpatched deepmerge', () => {
  it('pins html-to-text 10.0.1 and does not resolve deepmerge', async () => {
    const pkg = JSON.parse(await read('packages/email/package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies['html-to-text']).toBe('10.0.1');
    // Types have no v10 release; they are compile-time only and the typecheck pins the used API.
    expect(pkg.devDependencies['@types/html-to-text']).toMatch(/^9\./);

    const lock = await read('pnpm-lock.yaml');
    expect(lock).toContain('html-to-text@10.0.1:');
    expect(lock).toContain('deepmerge-ts: 8.0.2');
    expect(lock).not.toMatch(/\bdeepmerge@\d/);
  });

  it('records the advisory disposition rather than hiding it in an audit ignore', async () => {
    const security = await read('SECURITY.md');
    expect(security).toContain('GHSA-gcqx-w48m-w2h4');
    expect(security).toContain('html-to-text` 10.0.1');
    expect(security).toContain('deepmerge-ts` 8.0.2');
    // The only accepted advisory remains the uuid one in the excluded spike.
    expect(security).toContain('GHSA-w5hq-g745-h8pq');
  });
});
