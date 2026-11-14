import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

const COMMAND_FILES = new Set(['.md', '.sh', '.mjs', '.js']);

async function commandFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await commandFiles(path)));
    else if (COMMAND_FILES.has(path.slice(path.lastIndexOf('.')))) found.push(path);
  }
  return found;
}

interface CurlCommand {
  file: string;
  line: number;
  text: string;
}

/** Every shell curl example, with backslash continuations joined into one command. */
async function curlCommands(): Promise<CurlCommand[]> {
  const files = [
    join(root, 'README.md'),
    ...(await commandFiles(join(root, 'docs'))),
    ...(await commandFiles(join(root, '.claude/skills'))),
    ...(await commandFiles(join(root, 'scripts'))),
  ];
  const commands: CurlCommand[] = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/\bcurl\b/.test(lines[i])) continue;
      const line = i + 1;
      let text = lines[i];
      while (text.trimEnd().endsWith('\\') && i + 1 < lines.length) {
        i += 1;
        text = `${text.slice(0, text.lastIndexOf('\\'))} ${lines[i]}`;
      }
      commands.push({ file: relative(root, file), line, text });
    }
  }
  return commands;
}

describe('documented commands', () => {
  // Since the 0.14.16 CSRF work a cookie-authenticated write needs an Origin that matches
  // PUBLIC_URL/TRUSTED_ORIGINS, or Better Auth answers 403 MISSING_OR_NULL_ORIGIN (#929).
  // Bearer-token examples do not, because a page does not attach the token.
  it('sends Origin on every cookie-authenticated curl write', async () => {
    const violations = (await curlCommands())
      .filter((command) => {
        const sendsCookie = /(?:^|\s)(?:-b|--cookie)\b/.test(command.text) || /\bcookie\s*:/i.test(command.text);
        const writes =
          /(?:^|\s)(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(command.text) ||
          /(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?)\b/.test(command.text);
        const targetsApi = /\/api\/auth\/|\/v1\//.test(command.text);
        const hasOrigin =
          /(?:^|\s)(?:-H|--header)\s+['"]?origin\s*:/i.test(command.text) ||
          /(?:^|\s)origin\s*:/i.test(command.text) ||
          /sec-fetch-site\s*:\s*same-origin/i.test(command.text);
        return sendsCookie && writes && targetsApi && !hasOrigin;
      })
      .map((command) => `${command.file}:${command.line}`);
    expect(violations).toEqual([]);
  });
});

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
