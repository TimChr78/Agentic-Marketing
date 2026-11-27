import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { segmentCondition } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { hostedAgentTemplate } from '../src/agents/hostedTemplates';
import { commands } from '../src/registry';

// Pure documentation checks: the pilot pages must agree on retention, on the two public-path
// options and on what a plain-HTTP admin URL can serve, and the architecture pages and skills must
// name the commands, key providers and MCP surface the code ships. No server, database or network
// involved: importing the registry builds command definitions only.

const root = fileURLToPath(new URL('../../../', import.meta.url));
const paths = {
  skill: join(root, '.claude/skills/agentic-marketing-implement/SKILL.md'),
  cloudflare: join(root, '.claude/skills/agentic-marketing-implement/references/cloudflare.md'),
  proxy: join(root, '.claude/skills/agentic-marketing-implement/references/cloudflare-worker-proxy.js'),
  pilot: join(root, 'docs/pilots/martechsignal.md'),
};
const read = (path: string) => readFile(path, 'utf8');

const REAL_SEGMENT = 'seg_0123456789abcdef0123456789abcdef';

/**
 * Every balanced `{…}` object in `text` that parses as JSON, with the docs' `seg_…` placeholder
 * replaced by a real id. Parsing the object keeps the checks independent of whitespace and key
 * order; a brace in prose simply fails to parse and is skipped.
 */
function jsonObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(text.slice(start, i + 1).replaceAll('seg_…', REAL_SEGMENT));
            if (value && typeof value === 'object' && !Array.isArray(value)) found.push(value as Record<string, unknown>);
          } catch {
            // Not JSON: a brace in prose, or an example with placeholders of its own.
          }
          break;
        }
      }
    }
  }
  return found;
}

/** The example sunset condition wherever the doc puts it: whitespace and key order do not matter. */
function sunsetCondition(text: string): unknown {
  const condition = jsonObjects(text).find((value) => Array.isArray(value.all));
  if (!condition) throw new Error('the sunset example condition is missing');
  return condition;
}

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

describe('agent spend contract', () => {
  // #1081: the spend class gates the direct paid commands only. Journey AI steps are capped by the
  // provider's monthly token budget, not by a mandate, and the docs must say so where the classes
  // are described; the generated tool catalog carries the same sentence from the command
  // descriptions, so a later edit cannot quietly drop half of it.
  const sentence =
    "The spend class gates the direct commands that call or queue the provider (`prompts.test`, `ai.classify`, `ai.score`); AI steps inside a journey spend the provider's `monthlyTokenBudget` when a participant reaches them and need no spend mandate.";

  it('documents the spend-class boundary for journey AI steps', async () => {
    const autonomy = await read(join(root, 'docs/architecture/agentic-autonomy.md'));
    expect(autonomy).toContain(sentence);
  });

  it('carries the journey part into the enrol and publish descriptions', async () => {
    const tools = await read(join(root, '.claude/skills/agentic-marketing-mcp/references/tools.md'));
    for (const tool of ['journeys.enroll', 'journeys.enrollSegment', 'artifacts.requestPublish']) {
      const row = tools.split('\n').find((line) => line.startsWith(`| \`${tool}\` |`));
      expect(row, `${tool} is missing from the generated catalog`).toBeDefined();
      expect(row).toContain('need no spend mandate');
    }
  });
});

describe('architecture pages and skills name the shipped surface', () => {
  // #1290: the action-class table's Examples column is read as the list of commands in each class.
  it('names only registered commands in the action-class examples', async () => {
    const doc = await read(join(root, 'docs/architecture/agentic-autonomy.md'));
    const table = doc.slice(doc.indexOf('| Class | Examples | Reversible? |'));
    const rows = table.slice(0, table.indexOf('\n\n')).split('\n');
    const registered = new Set<string>(commands.map((command) => command.name));
    const documented = rows.flatMap((row) => {
      const examples = row.split('|')[2] ?? '';
      return [...examples.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)`/g)].map((match) => match[1]);
    });
    expect(documented.length).toBeGreaterThan(10);
    expect(documented.filter((name) => !registered.has(name))).toEqual([]);
  });

  // #1291: KEY_PROVIDER accepts local, openbao and aws-kms; there is no GCP KMS or file KEK.
  it('lists only the key providers the configuration accepts', async () => {
    const docs = await Promise.all([
      read(join(root, 'docs/architecture/security-and-privacy.md')),
      read(join(root, 'docs/architecture/tech-stack.md')),
    ]);
    for (const doc of docs) {
      expect(doc).not.toMatch(/GCP|env\/file/i);
      expect(doc).toMatch(/MASTER_KEY/);
      expect(doc).toMatch(/OpenBao/);
      expect(doc).toMatch(/AWS KMS/);
    }
  });

  // #1292: one installation-wide allow-list, not one per workspace. The operator has to learn the
  // scope from the row, so naming the variable is not enough.
  it('describes the egress allow-list as installation-wide', async () => {
    const doc = await read(join(root, 'docs/architecture/security-and-privacy.md'));
    const row = doc.split('\n').find((line) => line.startsWith('| SSRF '));
    expect(row).toBeDefined();
    expect(row).toContain('EGRESS_ALLOWED_HOSTS');
    expect(row).toMatch(/installation[- ]wide/);
    expect(row).toMatch(/every workspace/);
    expect(doc).not.toMatch(/per-workspace allow/i);
  });

  // #1293: the effect comment must list the registry's union, and the resources are the three
  // the server registers.
  it('documents the effect union and resources the MCP server ships', async () => {
    const [page, registry] = await Promise.all([
      read(join(root, 'docs/architecture/agents-and-mcp.md')),
      read(join(root, 'packages/commands/src/registry.ts')),
    ]);
    const union = /export type Effect = ([^;]+);/.exec(registry)?.[1] ?? '';
    const effects = [...union.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
    expect(effects.length).toBe(4);
    const effectLine = page.split('\n').find((line) => line.includes("effect: 'write'"));
    expect(effectLine).toContain(`// ${effects.join(' | ')}`);
    for (const uri of ['agentic-marketing://guide', 'business-context://current', 'learnings://current']) {
      expect(page).toContain(uri);
    }
    // The two workspace resources come from artifacts:read commands; the guide does not.
    expect(page).toMatch(/Business context and learnings[^\n]*artifacts:read/);
  });

  // A provider configured only for `decisions` serves the journey `decision` node and `ai.score`;
  // an `aiDecide` step needs a `journeys` provider and falls back without one.
  it('names the surfaces a decision provider serves', async () => {
    const page = await read(join(root, 'docs/architecture/agents-and-mcp.md'));
    const line = page.split('\n').find((l) => l.includes('**Decision providers**')) ?? '';
    expect(line).toContain('`decision` node');
    expect(line).toContain('`ai.score`');
    expect(line).toContain('`aiDecide`');
    expect(line).toContain('"journeys"');
    expect(line).toContain('decision-models.md');
  });

  // People-only commands are never MCP tools for an agent, whatever its scopes: every command the
  // tool list names must be a registered, agent-callable tool, and every command the people-only
  // paragraph names must be people-only. Checked against the registry, not a fixed set.
  it('classifies every command the MCP inventory names', async () => {
    const page = await read(join(root, 'docs/architecture/agents-and-mcp.md'));
    const toolsAt = page.indexOf('**Tools** (grouped');
    const peopleAt = page.indexOf('- **People-only commands');
    const tools = page.slice(toolsAt, peopleAt);
    const peopleOnlyText = page.slice(peopleAt, page.indexOf('- **Resources:**'));
    expect(tools.length).toBeGreaterThan(200);

    const named = (text: string) => [...text.matchAll(/`([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)`/g)].map((match) => match[1]!);
    const byName = new Map(commands.map((command) => [String(command.name), command] as const));

    const toolsNamed = named(tools);
    expect(toolsNamed.length).toBeGreaterThan(30);
    for (const name of toolsNamed) {
      const command = byName.get(name);
      expect(command, `${name} is not a registered command`).toBeDefined();
      expect(command!.humansOnly ?? false, `${name} is people-only, so not a tool`).toBe(false);
      expect(command!.permission, `${name} has no permission, so it is not an MCP tool`).toBeTruthy();
    }

    const peopleNamed = named(peopleOnlyText);
    expect(peopleNamed.length).toBeGreaterThan(8);
    for (const name of peopleNamed) {
      const command = byName.get(name);
      expect(command, `${name} is not a registered command`).toBeDefined();
      expect(command!.humansOnly ?? false, `${name} is not people-only`).toBe(true);
    }
    expect(peopleNamed).toContain('approvals.approve');
    // #1293 review: this read returns everything held about a person, so it is people-only.
    expect(peopleNamed).toContain('profiles.export');
    // ...and a hosted agent may delete the notes its own runs wrote, so this one is a tool.
    expect(toolsNamed).toContain('agents.memory.delete');
  });

  // #1294: only the remote target and a scaled ClickHouse backup remain open.
  it('does not call backup verification open', async () => {
    const doc = await read(join(root, 'docs/architecture/deployment-and-scaling.md'));
    expect(doc).toContain('am backup --verify');
    expect(doc).not.toMatch(/integrity checks are still open/i);
  });

  // #1287, #1288, #1289: recipes an agent follows must be calls its principal may make.
  it('keeps the audience recipes callable by the agent principal', async () => {
    const [skill, recipes] = await Promise.all([
      read(join(root, '.claude/skills/agentic-marketing-mcp/SKILL.md')),
      read(join(root, '.claude/skills/agentic-marketing-mcp/references/recipes.md')),
    ]);
    const audienceRow = skill.split('\n').find((line) => line.startsWith('| Audiences |'));
    expect(audienceRow).toContain('people only');
    expect(recipes).not.toMatch(/email_opened|email_clicked/);
    const curator = recipes.slice(recipes.indexOf('## Audience curator'));

    // Sizing a published segment is a metric-layer read: analytics.query with segment.members needs
    // only artifacts:read, whereas segments.preview needs profiles:read and returns sample ids.
    expect(curator).toMatch(/1\. \*\*Sizes\.\*\* [^\n]*publishedVersion/);
    expect(curator).toContain('analytics.query');
    expect(curator).toContain('segment.members');
    // A segment with no published version is a draft with no live audience.
    expect(curator).toMatch(/publishedVersion`[^\n]*null[^\n]*skip|publishedVersion[^\n]*`null`[^\n]*skip/i);
    // A condition that is not saved has no members: it is drafted and submitted, and the person
    // reviewing it previews the size.
    expect(curator).toMatch(/artifacts\.create/);
    expect(curator).toMatch(/artifacts\.requestPublish/);

    // Parse the sunset condition against the shipped schema instead of pinning its JSON text: it
    // must intersect the intended segment and count e-mail clicks, not clicks on every channel.
    const condition = segmentCondition.parse(sunsetCondition(curator));
    expect(condition).toEqual({
      all: [{ segment: REAL_SEGMENT }, { not: { message: 'clicked', within: 'P180D', channel: 'email' } }],
    });

    // The hosted curator template must carry the same workflow without person-level scopes.
    const template = hostedAgentTemplate('audience_curator')!;
    expect(template.scopes).not.toContain('profiles:read');
    expect(template.instructions).toContain('analytics.query');
    expect(template.instructions).toContain('publishedVersion');
    expect(template.instructions).toMatch(/publishedVersion[^\n]*null[^\n]*skip/i);
    expect(segmentCondition.parse(sunsetCondition(template.instructions))).toEqual(condition);
    for (const name of ['analytics.query', 'artifacts.get', 'artifacts.create']) {
      expect(template.scopes, name).toContain(commands.find((command) => command.name === name)?.permission);
    }
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
      // Removing unconfirmed signups is paused since 0.15.0 (#978 part 2): the docs must say so
      // instead of promising a removal that does not happen (#1056).
      expect(doc).toMatch(/paused/i);
      expect(doc).not.toMatch(/are removed after `RETENTION_UNCONFIRMED_DAYS`/);
      expect(doc).not.toMatch(/until retention removes it/i);
    }
    const smoke = await read(join(root, 'docs/deployment/smoke.md'));
    expect(smoke).not.toMatch(/retention[^.;]*removes (it|profiles)/i);
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

  it('lets the first-party proxy reach every public path (#1162)', async () => {
    const { AM_PUBLIC } = (await import(pathToFileURL(paths.proxy).href)) as { AM_PUBLIC: RegExp };
    for (const path of [
      '/f/form_id',
      '/f/confirm/token',
      '/u/token',
      '/u/p/token',
      '/u/t/token',
      '/c/token',
      '/n/slug/',
      '/n/slug/feed.xml',
      '/a/ast_00000000000000000000000000000000/logo.png',
      '/.well-known/am-domain/token',
      '/v1/batch',
      '/v1/decide',
      '/v1/consent/purposes',
      '/v1/push/config',
      '/v1/push/subscribe',
      '/v1/push/unsubscribe',
    ]) {
      expect(AM_PUBLIC.test(path), path).toBe(true);
    }
    for (const path of ['/', '/mcp', '/api/auth/get-session', '/v1/workspace.get', '/v1/push/other']) {
      expect(AM_PUBLIC.test(path), path).toBe(false);
    }
  });
});
