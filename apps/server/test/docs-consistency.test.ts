import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Pure documentation checks: the pilot pages must agree on retention, on the two public-path
// options and on what a plain-HTTP admin URL can serve. No server, database or network involved.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const paths = {
  skill: join(root, '.claude/skills/agentic-marketing-implement/SKILL.md'),
  cloudflare: join(root, '.claude/skills/agentic-marketing-implement/references/cloudflare.md'),
  pilot: join(root, 'docs/pilots/martechsignal.md'),
};
const read = (path: string) => readFile(path, 'utf8');

describe('pilot documentation', () => {
  it('describes automatic retention instead of manual cleanup', async () => {
    const [skill, pilot] = await Promise.all([read(paths.skill), read(paths.pilot)]);
    for (const doc of [skill, pilot]) {
      expect(doc).not.toMatch(/There is no automatic cleanup yet/i);
      expect(doc).not.toMatch(/retention job \(to do\)/i);
      expect(doc).not.toMatch(/erase stale ones periodically/i);
      expect(doc).toMatch(/RETENTION_UNCONFIRMED_DAYS/);
      expect(doc).toMatch(/RETENTION_LOG_DAYS/);
      expect(doc).toMatch(/scheduler runs(?: retention)? hourly/i);
      expect(doc).toMatch(/without suppression/i);
    }
    expect(pilot).toMatch(/profiles\.erase/);
  });

  it('presents both public-path options and marks option A as the default', async () => {
    const [skill, cloudflare, pilot] = await Promise.all([read(paths.skill), read(paths.cloudflare), read(paths.pilot)]);
    for (const doc of [skill, pilot]) {
      expect(doc).toMatch(/Option A/);
      expect(doc).toMatch(/Option B/);
      expect(doc).toMatch(/Option A[^\n]{0,160}(default|recommended)/i);
      expect(doc).toMatch(/Option B[\s\S]{0,240}(first-party|main domain|phase B)/i);
    }
    expect(skill).not.toMatch(/Public paths go through the site's own domain/i);
    expect(cloudflare).toMatch(/Option A is the default and recommended/i);
  });

  it('makes the form post and CSP guidance option-aware', async () => {
    const [skill, pilot] = await Promise.all([read(paths.skill), read(paths.pilot)]);
    expect(skill).toContain('https://am.<site>/f/<form id>');
    expect(skill).toContain('/am/f/<form id>');
    expect(skill).toMatch(/option A[^\n]{0,240}form-action/i);
    expect(skill).toMatch(/option B[^\n]{0,240}form-action 'self'/i);
    expect(pilot).toContain('https://am.martechsignal.com/f/<form id>');
    expect(pilot).toContain('/am/f/<form id>');
    expect(pilot).toMatch(/form-action[^\n]{0,120}https:\/\/am\.martechsignal\.com/i);
  });

  it('keeps plain-HTTP admin URLs separate from HTTPS-only MCP', async () => {
    const [skill, cloudflare, pilot] = await Promise.all([read(paths.skill), read(paths.cloudflare), read(paths.pilot)]);
    for (const doc of [skill, cloudflare, pilot]) {
      expect(doc).toMatch(/plain[- ]HTTP/i);
      expect(doc).toMatch(/MCP[^\n]{0,200}(?:HTTPS|disabled)/i);
    }
    expect(pilot).toMatch(/admin UI and REST work over a plain-HTTP LAN URL/i);
    expect(cloudflare).not.toMatch(/admin, MCP[^\n]*http:\/\//i);
  });

  it('documents the public-only listener and a traversal-safe tunnel rule', async () => {
    const [skill, cloudflare, pilot] = await Promise.all([read(paths.skill), read(paths.cloudflare), read(paths.pilot)]);
    for (const doc of [skill, cloudflare, pilot]) {
      expect(doc).toContain('PUBLIC_PORT');
      // A path rule is still supported, but only in the strict form where a segment may not start
      // with a dot or percent (link tokens are base64url, so real links keep matching).
      expect(doc).toContain('^/(f|u|c|a|n|hooks)(/[^/.%][^/%]*)+/?$');
      expect(doc).toContain('curl --path-as-is');
      // The old loose prefix rule must be gone: cloudflared matches it against the raw path.
      expect(doc).not.toMatch(/\^\/\(f\|u\|c(?:\|hooks)?\)\//);
      expect(doc).not.toMatch(/path:\s*\^\/\(f\|u\|c/);
    }
    for (const doc of [skill, pilot]) expect(doc).toMatch(/400 or 404/);
  });
});
