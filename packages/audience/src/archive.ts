import {
  artifactTypes,
  type Brand,
  escapeHtml,
  publishedSingleton,
  publishValidators,
  type ResolvedBrand,
  resolveBrand,
} from '@agentic-marketing/artifacts';
import type { PublicRequest } from '@agentic-marketing/commands';
import { defineCommand } from '@agentic-marketing/commands';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { renderTemplate, type UnsubscribeLink, type WebLink } from '@agentic-marketing/email';
import { profileForMessage } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { type DefaultTreeAdapterTypes, defaultTreeAdapter, parse, serialize, type TreeAdapter } from 'parse5';
import { z } from 'zod';
import { cachedEmailParts } from './emailPartsCache';

export { clearEmailPartsCache, emailPartsCacheStats } from './emailPartsCache';

// The public newsletter archive and the per-recipient web version (#100), served on the links
// host next to the hosted pages. Everything here is public except /n/w/<token>, which is signed
// per message and shows that one recipient their own e-mail. Archive issues are re-rendered from
// the template version that was sent with empty personalisation, never from a person's message.
//
// E-mail HTML is untrusted. Before it reaches a page it passes a linear scanner and, when the
// scanner cannot settle the question, parse5 as the final judge, under depth, attribute, foster,
// stack-read and wall-clock bounds. Any bound that trips fails closed: the page shows the whole
// body as escaped text rather than risk active content. Two consequences are deliberate and not
// bugs. First, the clock bound makes a borderline e-mail's result wall-clock dependent: one
// process may serve the cleaned markup, another the escaped source, and each caches its own answer
// for the life of the process. Second, a malformed e-mail with more than MAX_EMAIL_FOSTER_INSERTS
// genuinely fostered nodes is escaped as source instead of having the stray markup dropped, which
// is a display regression only for input a browser would have rearranged anyway.

const PER_PAGE = 20;

export interface ArchiveIssue {
  artifactId: string;
  name: string;
  slug: string;
  subject: string;
  summary: string;
  sentAt: string;
  url: string;
}

export interface ArchiveSettingsView {
  enabled: boolean;
  title: string | null;
  description: string | null;
  slug: string | null;
  indexUrl: string | null;
  feedUrl: string | null;
  sitemapUrl: string | null;
  subscribeUrl: string | null;
}

/** The workspace whose published brand owns this archive slug, if any. */
async function publishedBrands(db: Db): Promise<{ workspaceId: string; brand: Brand }[]> {
  const { rows } = await db.admin.query<{ workspace_id: string; content: unknown }>(
    `SELECT a.workspace_id, v.content FROM artifacts a
     JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.published_version
     WHERE a.type = 'brand' AND a.archived = false`,
  );
  const brands: { workspaceId: string; brand: Brand }[] = [];
  for (const row of rows) {
    const parsed = artifactTypes.brand.content.safeParse(row.content);
    if (parsed.success) brands.push({ workspaceId: row.workspace_id, brand: parsed.data });
  }
  return brands;
}

export async function archiveForSlug(db: Db, slug: string, workspaceId?: string) {
  const hit = (await publishedBrands(db)).find(
    (b) => (!workspaceId || b.workspaceId === workspaceId) && b.brand.archive.enabled && b.brand.archive.slug === slug,
  );
  return hit ?? null;
}

/** Trims '-' from both ends in one linear pass; `^-+|-+$` backtracks on a long run. */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start++;
  while (end > start && value[end - 1] === '-') end--;
  return value.slice(start, end);
}

/** A URL-safe issue slug: "Signal #42: attribution is…" → "signal-42-attribution-is". */
export function slugify(value: string): string {
  return (
    trimDashes(
      value
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-'),
    ).slice(0, 80) || 'issue'
  );
}

const day = (date: Date) => date.toISOString().slice(0, 10);

/** The text of an HTML fragment, without tags, in one linear scan (the old `/<[^>]*>/g` was
 * quadratic on a long run with no closing ">"). Matching is identical: the first "<" through the
 * first ">" after it becomes a space, and a fragment with no ">" is left alone. */
export const plain = (value: string) => {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const open = value.indexOf('<', i);
    if (open < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, open);
    const close = value.indexOf('>', open + 1);
    if (close < 0) {
      out += value.slice(open);
      break;
    }
    out += ' ';
    i = close + 1;
  }
  return out.replace(/\s+/g, ' ').trim();
};

/** Values for an archived issue: the template's sample data, but never a real profile. */
function archiveVars(t: { sampleData?: Record<string, unknown> }) {
  return {
    ...(t.sampleData ?? {}),
    profile: {},
    event: {},
    unsubscribe_url: '#',
    preferences_url: '#',
    web_url: '#',
    topic_unsubscribe_url: '#',
  };
}

async function versionContent(tx: Tx, artifactId: string, number: number) {
  const [v] = await tx
    .select({ content: schema.artifactVersions.content })
    .from(schema.artifactVersions)
    .where(and(eq(schema.artifactVersions.artifactId, artifactId), eq(schema.artifactVersions.number, number)));
  return v?.content ?? null;
}

/**
 * Published issues of one workspace: sent broadcasts whose *live* version still says
 * `archive.publish`, rendered from the version that was sent so later template edits do not
 * change a published page. Unpublishing a later version removes the issue.
 */
export async function listArchiveIssues(tx: Tx, brand: Brand, linksUrl: string): Promise<ArchiveIssue[]> {
  const settings = brand.archive;
  if (!settings.enabled || !settings.slug) return [];
  const base = `${linksUrl}/n/${settings.slug}`;

  const runs = await tx
    .select({
      broadcastId: schema.broadcastRuns.broadcastId,
      version: schema.broadcastRuns.version,
      sendAt: schema.broadcastRuns.sendAt,
      startedAt: schema.broadcastRuns.startedAt,
      finishedAt: schema.broadcastRuns.finishedAt,
      createdAt: schema.broadcastRuns.createdAt,
      name: schema.artifacts.name,
      publishedVersion: schema.artifacts.publishedVersion,
    })
    .from(schema.broadcastRuns)
    .innerJoin(schema.artifacts, and(eq(schema.artifacts.id, schema.broadcastRuns.broadcastId), eq(schema.artifacts.type, 'broadcast')))
    .where(and(eq(schema.broadcastRuns.status, 'done'), eq(schema.artifacts.archived, false)));

  const issues: ArchiveIssue[] = [];
  for (const run of runs) {
    if (!run.publishedVersion) continue;
    // The live version decides whether the issue is still public.
    const live = artifactTypes.broadcast.content.safeParse(await versionContent(tx, run.broadcastId, run.publishedVersion));
    if (!live.success || !live.data.archive?.publish) continue;
    // The sent version carries the issue's own slug, summary and template.
    const sent = artifactTypes.broadcast.content.safeParse(await versionContent(tx, run.broadcastId, run.version));
    if (!sent.success) continue;

    const [message] = await tx
      .select({ templateVersion: schema.messages.templateVersion })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.journeyId, run.broadcastId),
          eq(schema.messages.channel, 'email'),
          eq(schema.messages.templateId, sent.data.template),
        ),
      )
      .orderBy(asc(schema.messages.createdAt))
      .limit(1);
    let templateVersion = message?.templateVersion ?? null;
    if (!templateVersion) {
      // A run with no recipients has no message to learn the version from; use what is live.
      const [template] = await tx
        .select({ publishedVersion: schema.artifacts.publishedVersion })
        .from(schema.artifacts)
        .where(and(eq(schema.artifacts.id, sent.data.template), eq(schema.artifacts.type, 'email_template')));
      templateVersion = template?.publishedVersion ?? null;
    }
    if (!templateVersion) continue;
    const template = artifactTypes.email_template.content.safeParse(await versionContent(tx, sent.data.template, templateVersion));
    if (!template.success) continue;

    let rendered: Awaited<ReturnType<typeof renderTemplate>>;
    try {
      rendered = await renderTemplate(template.data, archiveVars(template.data));
    } catch {
      // A template that no longer renders is left out rather than taking the whole archive down.
      continue;
    }
    const sentAt = run.finishedAt ?? run.startedAt ?? run.sendAt ?? run.createdAt;
    const subject = rendered.subject || run.name;
    const entry = sent.data.archive;
    issues.push({
      artifactId: run.broadcastId,
      name: run.name,
      slug: entry?.slug ?? `${slugify(subject)}-${day(new Date(sentAt))}`,
      subject,
      summary: entry?.summary ?? rendered.preheader ?? sent.data.description ?? '',
      sentAt: sentAt.toISOString(),
      url: '',
    });
  }

  issues.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  // Two issues can slugify to the same thing (a resend, the same subject twice in a day). Keep the
  // first (newest) URL and give the other a numeric suffix, deterministically.
  const seen = new Set<string>();
  for (const issue of issues) {
    let slug = issue.slug;
    for (let n = 2; seen.has(slug); n++) slug = `${issue.slug}-${n}`;
    seen.add(slug);
    issue.slug = slug;
    issue.url = `${base}/${slug}`;
  }
  return issues;
}

function settingsView(brand: Brand | null, linksUrl: string): ArchiveSettingsView {
  const archive = brand?.archive;
  const enabled = !!(archive?.enabled && archive.slug);
  const base = enabled && brand?.archive.slug ? `${linksUrl}/n/${brand.archive.slug}` : null;
  return {
    enabled,
    title: archive?.title ?? null,
    description: archive?.description ?? null,
    slug: archive?.slug ?? null,
    indexUrl: base ? `${base}/` : null,
    feedUrl: base ? `${base}/feed.xml` : null,
    sitemapUrl: base ? `${base}/sitemap.xml` : null,
    subscribeUrl: archive?.subscribeUrl ?? null,
  };
}

const dateLabel = (value: string, brand: ResolvedBrand) => {
  try {
    return new Intl.DateTimeFormat(brand.language, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(
      new Date(value),
    );
  } catch {
    return value.slice(0, 10);
  }
};

const metaDescription = (value: string, fallback: string) => {
  const text = plain(value) || fallback;
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
};

const DANGEROUS_ELEMENTS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'frame',
  'frameset',
  'applet',
  'base',
  // SMIL can retarget an href/xlink:href to javascript: at runtime (#579).
  'animate',
  'set',
  'animatetransform',
  'animatemotion',
  'discard',
]);
/** Dangerous elements whose content is raw text or a nested document, so it goes with the tag. */
const DROPS_CONTENT = new Set(['script', 'iframe', 'object', 'embed']);
/** Elements that never open a nesting level. */
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'data', 'srcset']);

const isWhitespace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isAsciiLetter = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const isTagNameChar = (c: string) => isAsciiLetter(c) || (c >= '0' && c <= '9') || c === ':' || c === '-';
const isAttributeNameChar = (c: string) => !isWhitespace(c) && c !== '=' && c !== '>' && c !== '/' && c !== '"' && c !== "'" && c !== '<';
const isHexDigit = (c: string) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');

const REPLACEMENT = '\uFFFD';

/** A numeric entity code point, or U+FFFD for anything a browser would not accept. */
function safeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(value);
}

/**
 * Decodes the entities a browser resolves before it reads a URL scheme, without ever throwing.
 * The whitespace entities matter for the `http-equiv` check: parse5 decodes all of them and
 * `trim()` then removes the character, so the scanner has to see the same value (#673).
 */
function decodeEntities(value: string): string {
  const named: [string, string][] = [
    ['&colon;', ':'],
    ['&tab;', '\t'],
    ['&Tab;', '\t'],
    ['&newline;', '\n'],
    ['&NewLine;', '\n'],
    ['&nbsp;', '\u00a0'],
    ['&NonBreakingSpace;', '\u00a0'],
    ['&ensp;', '\u2002'],
    ['&emsp;', '\u2003'],
    ['&emsp13;', '\u2004'],
    ['&emsp14;', '\u2005'],
    ['&numsp;', '\u2007'],
    ['&puncsp;', '\u2008'],
    ['&thinsp;', '\u2009'],
    ['&ThinSpace;', '\u2009'],
    ['&VeryThinSpace;', '\u200a'],
    ['&hairsp;', '\u200a'],
    ['&MediumSpace;', '\u205f'],
    ['&ThickSpace;', '\u205f\u200a'],
  ];
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '&') {
      out += value[i];
      i++;
      continue;
    }
    let j = i + 1;
    if (value[j] === '#') {
      j++;
      const hex = value[j] === 'x' || value[j] === 'X';
      if (hex) j++;
      const start = j;
      while (j < value.length && (hex ? isHexDigit(value[j]!) : value[j]! >= '0' && value[j]! <= '9')) j++;
      if (j > start) {
        const digits = value.slice(start, j);
        if (value[j] === ';') j++;
        out += safeCodePoint(Number.parseInt(digits, hex ? 16 : 10));
        i = j;
        continue;
      }
    }
    const match = named.find(([name]) => value.startsWith(name, i));
    if (match) {
      out += match[1];
      i += match[0].length;
      continue;
    }
    out += value[i];
    i++;
  }
  return out;
}

/** The scheme a browser would see: entities decoded, whitespace and controls removed. */
function urlScheme(value: string): string {
  const decoded = decodeEntities(value);
  let out = '';
  for (let i = 0; i < decoded.length; i++) if (decoded.charCodeAt(i) > 0x20) out += decoded[i];
  return out.toLowerCase();
}

/** `javascript:`, `vbscript:` and non-image `data:` URLs never reach the archive page. */
export function activeUrl(value: string): boolean {
  const scheme = urlScheme(value);
  if (scheme.startsWith('javascript:') || scheme.startsWith('vbscript:')) return true;
  return scheme.startsWith('data:') && !scheme.startsWith('data:image/');
}

interface TagAttribute {
  name: string;
  lowerName: string;
  value: string | null;
  /** Whitespace and `/` before the attribute, kept when a tag has to be rebuilt. */
  separator: string;
  /** The attribute's original bytes, from its name through its value. */
  raw: string;
}

interface ParsedTag {
  endTag: boolean;
  name: string;
  lowerName: string;
  attributes: TagAttribute[];
  selfClosing: boolean;
  /** The index just past the closing `>`. */
  end: number;
}

/**
 * Parses one tag at `open`, respecting quotes. Returns `null` when the text is not a tag, or
 * `{ unterminated: true }` when the input ends before the tag does.
 */
function parseTag(body: string, open: number): ParsedTag | { unterminated: true } | null {
  let j = open + 1;
  let endTag = false;
  if (body[j] === '/') {
    endTag = true;
    j++;
  }
  if (!isAsciiLetter(body[j] ?? '')) return null;
  const nameStart = j;
  j++;
  while (j < body.length && isTagNameChar(body[j]!)) j++;
  const name = body.slice(nameStart, j);
  const attributes: TagAttribute[] = [];
  let selfClosing = false;
  while (true) {
    const separatorStart = j;
    while (j < body.length && (isWhitespace(body[j]!) || body[j] === '/')) j++;
    const separator = body.slice(separatorStart, j);
    if (j >= body.length) return { unterminated: true };
    if (body[j] === '>') {
      selfClosing = separator.includes('/');
      j++;
      return { endTag, name, lowerName: name.toLowerCase(), attributes, selfClosing, end: j };
    }
    if (body[j] === '<') return null;
    const attributeStart = j;
    while (j < body.length && isAttributeNameChar(body[j]!)) j++;
    if (j === attributeStart) return null;
    const attributeName = body.slice(attributeStart, j);
    const afterName = j;
    while (j < body.length && isWhitespace(body[j]!)) j++;
    let value: string | null = null;
    if (body[j] === '=') {
      j++;
      while (j < body.length && isWhitespace(body[j]!)) j++;
      if (body[j] === '"' || body[j] === "'") {
        const quote = body[j]!;
        j++;
        const valueStart = j;
        while (j < body.length && body[j] !== quote) j++;
        if (j >= body.length) return { unterminated: true };
        value = body.slice(valueStart, j);
        j++;
      } else {
        const valueStart = j;
        while (j < body.length && !isWhitespace(body[j]!) && body[j] !== '>') {
          if (body[j] === '<') break;
          j++;
        }
        value = body.slice(valueStart, j);
      }
    } else {
      // A valueless attribute: leave the whitespace after it for the next separator.
      j = afterName;
    }
    attributes.push({
      name: attributeName,
      lowerName: attributeName.toLowerCase(),
      value,
      separator,
      raw: body.slice(attributeStart, j),
    });
  }
}

/** The index just past the first `</name …>` at or after `from`, or the end of the input. */
function findEndTagEnd(body: string, name: string, from: number): number {
  let i = from;
  while (i < body.length) {
    const open = body.indexOf('<', i);
    if (open < 0) return body.length;
    if (body[open + 1] === '/') {
      const nameStart = open + 2;
      let k = 0;
      while (k < name.length && body[nameStart + k]?.toLowerCase() === name[k]) k++;
      if (k === name.length) {
        const after = nameStart + k;
        const boundary = body[after];
        if (boundary === undefined || isWhitespace(boundary) || boundary === '/' || boundary === '>') {
          const close = body.indexOf('>', after);
          return close < 0 ? body.length : close + 1;
        }
      }
    }
    i = open + 1;
  }
  return body.length;
}

function hasRefresh(attributes: TagAttribute[]): boolean {
  return attributes.some(
    (a) => a.lowerName === 'http-equiv' && a.value !== null && decodeEntities(a.value).trim().toLowerCase() === 'refresh',
  );
}

function dropsAttribute(attribute: TagAttribute): boolean {
  if (attribute.lowerName.startsWith('on')) return true;
  return URL_ATTRIBUTES.has(attribute.lowerName) && attribute.value !== null && activeUrl(attribute.value);
}

/** The index just past a comment opened at `from - 4`, or -1 when it runs to the end of input. */
function commentEnd(body: string, from: number): number {
  if (body[from] === '>') return from + 1;
  if (body.startsWith('->', from)) return from + 2;
  // One forward scan to the first terminator, so each comment costs only its own length.
  for (let at = body.indexOf('--', from); at >= 0; at = body.indexOf('--', at + 1)) {
    if (body[at + 2] === '>') return at + 3;
    if (body[at + 2] === '!' && body[at + 3] === '>') return at + 4;
  }
  return -1;
}

/** Bounds the parse5 judge's input (#578). Real e-mail nests to about 40. */
export const MAX_EMAIL_NESTING = 256;
export const MAX_EMAIL_LENGTH = 1_000_000;
// The duplicate-attribute check inside parse5 is quadratic in the attribute count. Real e-mail
// tags have a handful; past this bound the scanner fails closed before parse5 sees the tag.
export const MAX_EMAIL_ATTRIBUTES = 512;
// Foster parenting (stray content inside a <table>) inserts before a sibling, and finding that
// sibling scans the parent's child list, so thousands of fostered nodes cost quadratic time: a
// 900 KB body took 6 s on a CI runner. Real e-mail fosters a handful; past this the judge fails closed.
export const MAX_EMAIL_FOSTER_INSERTS = 512;
// <html> and <body> start tags merge their attributes into the document's own elements, and each
// merge rebuilds a set of every attribute gathered so far; the total is bounded, not the per-tag count.
export const MAX_EMAIL_ADOPTED_ATTRIBUTES = 512;
// The adoption agency (mis-nested formatting end tags) detaches a block's children one by one, and
// each detach scans the parent's child list. Bound the total scanned, not the number of detaches.
export const MAX_EMAIL_DETACH_SCAN = 2_000_000;
// An end tag with no matching open element inserts nothing; parse5 only scans the open-element
// stack, once per level. A deep stack and a long run of end tags therefore cost time without
// touching any adapter insertion hook. Bound the total read, so the work is capped on a fast
// machine too, not only by the clock. A real document reads about depth × tags, far below this.
export const MAX_EMAIL_STACK_READS = 2_000_000;
// A backstop for a whole sanitiser call: the scanner, the tree adapter, the stack reads and the
// node sweep all check it, so a call cannot run much past it. Real newsletters take about 20 ms.
export const MAX_EMAIL_PARSE_MS = 1_000;
// Counting items and checking the clock only every so often keeps the checks off the hot path:
// a `performance.now()` call per tag or per stack read would cost more than the work it bounds.
const BUDGET_CHECK_EVERY = 256;
const STACK_READ_CHECK_EVERY = 4_096;

/** A wall-clock budget for one sanitiser call. Throws like the depth cap, so the caller fails closed. */
type Tick = () => void;

function parseBudget(): Tick {
  const startedAt = performance.now();
  return () => {
    if (performance.now() - startedAt > MAX_EMAIL_PARSE_MS) throw new EmailNestingError();
  };
}

/**
 * Removes active content from e-mail HTML before the public archive and web version embed it.
 * The strict CSP (`default-src 'none'`) already blocks scripts, so this is defence in depth.
 * One linear, quote-aware pass: text is copied unchanged, tags are parsed once, dangerous
 * elements and attributes are dropped, and a tag with nothing to remove keeps its exact bytes.
 * `tick` is the caller's shared budget; it runs every few hundred tags, not on every one.
 */
export function scanEmailBody(body: string, tick: Tick = () => {}): string {
  let out = '';
  let i = 0;
  let steps = 0;
  while (i < body.length) {
    if (++steps % BUDGET_CHECK_EVERY === 0) tick();
    const open = body.indexOf('<', i);
    if (open < 0) {
      out += body.slice(i);
      break;
    }
    out += body.slice(i, open);

    // Comments are opaque: copy them whole so a tag-looking string inside one stays inert. They
    // close where a browser closes them: `<!-->` and `<!--->` are empty comments, and a comment
    // ends at the first `-->` or `--!>`, so markup after an early close is still sanitised.
    if (body.startsWith('<!--', open)) {
      const after = commentEnd(body, open + 4);
      if (after < 0) {
        out += body.slice(open);
        break;
      }
      out += body.slice(open, after);
      i = after;
      continue;
    }
    // Declarations such as <!doctype html> are copied through unchanged.
    if (body[open + 1] === '!') {
      const end = body.indexOf('>', open + 2);
      if (end < 0) {
        // No tag can close after this point; escape the opener and copy the rest once.
        out += '&lt;';
        out += body.slice(open + 1);
        break;
      }
      out += body.slice(open, end + 1);
      i = end + 1;
      continue;
    }

    const tag = parseTag(body, open);
    if (tag === null) {
      out += '<';
      i = open + 1;
      continue;
    }
    if ('unterminated' in tag) {
      // The input ends inside this tag, so no later "<" can start a complete tag either.
      // Escape the opener and copy the remainder once, never rescanning it.
      out += '&lt;';
      out += body.slice(open + 1);
      break;
    }

    // parse5's duplicate-attribute check walks every earlier attribute for each new one, so a tag
    // with tens of thousands of them is quadratic. The scanner already has the count.
    if (tag.attributes.length > MAX_EMAIL_ATTRIBUTES) throw new EmailScanError('too many attributes');

    if (tag.endTag) {
      if (!DANGEROUS_ELEMENTS.has(tag.lowerName)) out += body.slice(open, tag.end);
      i = tag.end;
      continue;
    }
    if (DANGEROUS_ELEMENTS.has(tag.lowerName)) {
      i = DROPS_CONTENT.has(tag.lowerName) ? findEndTagEnd(body, tag.lowerName, tag.end) : tag.end;
      continue;
    }
    if (tag.lowerName === 'meta' && hasRefresh(tag.attributes)) {
      i = tag.end;
      continue;
    }

    const kept = tag.attributes.filter((attribute) => !dropsAttribute(attribute));
    if (kept.length === tag.attributes.length) {
      out += body.slice(open, tag.end);
    } else {
      out += `<${tag.name}`;
      for (const attribute of kept) out += `${attribute.separator || ' '}${attribute.raw}`;
      out += tag.selfClosing ? '/>' : '>';
    }
    i = tag.end;
  }
  return out;
}

// The judge wraps the fragment in <html> and <body>; those two levels are ours, not the e-mail's.
const EMAIL_PARSE_WRAPPER_DEPTH = 2;

/**
 * Thrown by the depth-bounding adapter. It is private to this module, so a caller's own error can
 * never be mistaken for the nesting abort and silently turned into an escaped body.
 */
class EmailNestingError extends Error {}

/** A scanner bound: too many attributes on one tag. sanitiseEmailBody turns it into escaped HTML. */
class EmailScanError extends Error {}

/**
 * parse5 is the authority on how deeply a document nests, not a hand-written approximation: scope
 * rules for tables, templates and foreign content are too subtle to mirror. This adapter records
 * each node's depth as depth(parent) + 1 and throws before the tree can go past `maxDepth`. Every
 * insertion path is covered, including foster parenting and `<template>` content. The parser's
 * open-element stack is then bounded by the cap, so a scope scan costs at most O(cap) and the whole
 * parse is O(input × cap) whatever the markup. `tick` is the caller's budget for the whole sanitise
 * call, shared with the scanner and the sweep.
 */
function depthBoundingTreeAdapter(
  maxDepth: number,
  maxFosterInserts: number,
  tick: Tick,
): TreeAdapter<DefaultTreeAdapterTypes.DefaultTreeAdapterMap> {
  const depths = new WeakMap<DefaultTreeAdapterTypes.Node, number>();
  // One budget per parse: every insert-before (element or text) searches the parent's children.
  let fosterInserts = 0;
  let adoptedAttributes = 0;
  let detachScan = 0;
  let stackReads = 0;
  // An end tag with no matching open element inserts nothing, so no insertion hook runs: parse5
  // only asks the adapter for each open element's namespace while it checks scope. Check the clock
  // here too, and bound the total reads, or a deep stack plus a long end-tag run is unbounded work.
  const readStack = () => {
    stackReads += 1;
    if (stackReads > MAX_EMAIL_STACK_READS) throw new EmailNestingError();
    if (stackReads % STACK_READ_CHECK_EVERY === 0) tick();
  };
  const foster = () => {
    tick();
    fosterInserts += 1;
    if (fosterInserts > maxFosterInserts) throw new EmailNestingError();
  };
  const track = (parentNode: DefaultTreeAdapterTypes.ParentNode, newNode: DefaultTreeAdapterTypes.ChildNode) => {
    const depth = (depths.get(parentNode) ?? 0) + 1;
    if (depth > maxDepth) throw new EmailNestingError();
    depths.set(newNode, depth);
    // parse5 calls setTemplateContent before it attaches the template, so the fragment's depth
    // was provisional. Now that the template has a real parent, its content sits one level below.
    if (newNode.nodeName === 'template' && 'content' in newNode) {
      const content = (newNode as DefaultTreeAdapterTypes.Template).content;
      const contentDepth = depth + 1;
      if (contentDepth > maxDepth) throw new EmailNestingError();
      depths.set(content, contentDepth);
    }
  };
  return {
    ...defaultTreeAdapter,
    appendChild(parentNode, newNode) {
      tick();
      track(parentNode, newNode);
      defaultTreeAdapter.appendChild(parentNode, newNode);
    },
    insertBefore(parentNode, newNode, referenceNode) {
      // Foster parenting inserts before a table's current child rather than appending.
      foster();
      track(parentNode, newNode);
      defaultTreeAdapter.insertBefore(parentNode, newNode, referenceNode);
    },
    adoptAttributes(recipient, attrs) {
      tick();
      adoptedAttributes += attrs.length;
      if (adoptedAttributes > MAX_EMAIL_ADOPTED_ATTRIBUTES) throw new EmailNestingError();
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    detachNode(node) {
      tick();
      detachScan += node.parentNode?.childNodes.length ?? 0;
      if (detachScan > MAX_EMAIL_DETACH_SCAN) throw new EmailNestingError();
      defaultTreeAdapter.detachNode(node);
    },
    setTemplateContent(templateElement, contentElement) {
      tick();
      // The content fragment is one level deeper than its <template>.
      const depth = (depths.get(templateElement) ?? 0) + 1;
      if (depth > maxDepth) throw new EmailNestingError();
      depths.set(contentElement, depth);
      defaultTreeAdapter.setTemplateContent(templateElement, contentElement);
    },
    insertText(parentNode, text) {
      tick();
      // Text has no children, so it cannot nest; record it for completeness without bounding it.
      defaultTreeAdapter.insertText(parentNode, text);
      const last = parentNode.childNodes[parentNode.childNodes.length - 1];
      if (last && defaultTreeAdapter.isTextNode(last)) depths.set(last, (depths.get(parentNode) ?? 0) + 1);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      foster();
      defaultTreeAdapter.insertTextBefore(parentNode, text, referenceNode);
      const index = parentNode.childNodes.indexOf(referenceNode);
      const previous = index > 0 ? parentNode.childNodes[index - 1] : undefined;
      if (previous && defaultTreeAdapter.isTextNode(previous)) depths.set(previous, (depths.get(parentNode) ?? 0) + 1);
    },
    getNamespaceURI(element) {
      readStack();
      return defaultTreeAdapter.getNamespaceURI(element);
    },
    getTagName(element) {
      readStack();
      return defaultTreeAdapter.getTagName(element);
    },
  };
}

// A fresh adapter per parse, so the foster budget and depth map never carry over between parses.
const emailParseOptions = (tick: Tick) => ({
  scriptingEnabled: true,
  treeAdapter: depthBoundingTreeAdapter(MAX_EMAIL_NESTING + EMAIL_PARSE_WRAPPER_DEPTH, MAX_EMAIL_FOSTER_INSERTS, tick),
});
// The judge parses a whole document and reads its <body>, which is how the archive page embeds
// the e-mail (a <div> inside <main>). A document parse has no fragment root adoption, so it stays
// linear however many top-level nodes the input has, and a stray </div> or </body> cannot move
// nodes out of view: they stay in the document the sweep walks. A <body> or <html> start tag in
// the input merges its attributes into those elements, exactly as it would on the real page, and
// the sweep checks those attributes too.
function parseEmailDocument(
  markup: string,
  tick: Tick,
): {
  document: DefaultTreeAdapterTypes.Document;
  body: DefaultTreeAdapterTypes.Element | null;
} {
  const document = parse(`<!doctype html><html><head></head><body>${markup}`, emailParseOptions(tick));
  const root = document.childNodes.find((node) => 'tagName' in node && node.tagName === 'html') as
    | DefaultTreeAdapterTypes.Element
    | undefined;
  const body = (root?.childNodes.find((node) => 'tagName' in node && node.tagName === 'body') ??
    null) as DefaultTreeAdapterTypes.Element | null;
  return { document, body };
}

function isActiveElement(element: DefaultTreeAdapterTypes.Element): boolean {
  const name = element.tagName.toLowerCase();
  if (DANGEROUS_ELEMENTS.has(name)) return true;
  return (
    name === 'meta' &&
    element.attrs.some((attribute) => attribute.name.toLowerCase() === 'http-equiv' && attribute.value.trim().toLowerCase() === 'refresh')
  );
}

function dropsParsedAttribute(attribute: { name: string; value: string }): boolean {
  const name = attribute.name.toLowerCase();
  if (name.startsWith('on')) return true;
  return URL_ATTRIBUTES.has(name) && activeUrl(attribute.value);
}

/**
 * Walks a parse5 fragment with the same active-content rules as the scanner, including the
 * content of `<template>`. Checking reports whether anything is active; cleaning rebuilds each
 * child list once, so removing many nodes stays linear. Iterative, so a deeply nested document
 * cannot exhaust the call stack. `tick` is checked as nodes are visited: a 1 MB tree is linear but
 * still worth a periodic clock check when it arrives on a public request.
 */
function sweepFragment(root: DefaultTreeAdapterTypes.ParentNode, clean: boolean, tick: Tick = () => {}): boolean {
  let active = false;
  let visited = 0;
  const check = () => {
    if (++visited % BUDGET_CHECK_EVERY === 0) tick();
  };
  const stack: DefaultTreeAdapterTypes.ParentNode[] = [root];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    if (!clean) {
      for (const node of parent.childNodes) {
        check();
        if (!('tagName' in node)) continue;
        const element = node as DefaultTreeAdapterTypes.Element;
        if (isActiveElement(element) || element.attrs.some(dropsParsedAttribute)) {
          active = true;
          continue;
        }
        stack.push(element);
        if (element.nodeName === 'template') stack.push((element as DefaultTreeAdapterTypes.Template).content);
      }
      continue;
    }
    const kept: DefaultTreeAdapterTypes.ChildNode[] = [];
    for (const node of parent.childNodes) {
      check();
      if (!('tagName' in node)) {
        kept.push(node);
        continue;
      }
      const element = node as DefaultTreeAdapterTypes.Element;
      if (isActiveElement(element)) {
        active = true;
        continue;
      }
      element.attrs = element.attrs.filter((attribute) => !dropsParsedAttribute(attribute));
      kept.push(element);
      stack.push(element);
      if (element.nodeName === 'template') stack.push((element as DefaultTreeAdapterTypes.Template).content);
    }
    parent.childNodes = kept;
  }
  return active;
}

function containsActiveContent(markup: string, tick: Tick = () => {}): boolean {
  return sweepFragment(parseEmailDocument(markup, tick).document, false, tick);
}

function cleanActiveContent(markup: string, tick: Tick = () => {}): string {
  const { document, body } = parseEmailDocument(markup, tick);
  sweepFragment(document, true, tick);
  // Serializing is one linear pass over the tree this parse already bounded (1 MB of input, depth
  // cap, stack-read cap), so it needs no clock check of its own; the sweep above is where the
  // many-node cost sits. The output cannot outgrow the input by more than the markup parse5 adds.
  return body ? serialize(body) : '';
}

/**
 * The scanner above is fast and keeps benign bytes, but it is a hand-written HTML parser. A
 * spec-compliant parse is the final judge: if the scanner's output still contains active
 * content (a stray quote, an unterminated opener, a script splitting a tag name, `</noscript>`),
 * remove it from the parse5 tree, serialize, and check the serialization again. If one cleaning
 * round cannot make it inert (mutation XSS), escape the whole body and fail closed.
 */
export function sanitiseEmailBody(body: string, isActive?: (html: string) => boolean): string {
  // Avoid even scanning input past the budget; the scan can also expand unterminated "<" to "&lt;".
  if (body.length > MAX_EMAIL_LENGTH) return escapeHtml(body);
  // One budget for the whole call: the scan, every parse and the sweep share it, so the work a
  // public request can trigger is bounded by one clock, not one per stage (#673).
  const tick = parseBudget();
  const active = isActive ?? ((html: string) => containsActiveContent(html, tick));
  try {
    const scanned = scanEmailBody(body, tick);
    // A cheap early exit for the common hostile shape; the tree adapter below is the real bound, so
    // this scan may undercount without risking the judge (#578).
    if (scanned.length > MAX_EMAIL_LENGTH || exceedsNestingCap(scanned, MAX_EMAIL_NESTING, tick)) return escapeHtml(body);
    if (!active(scanned)) return scanned;
    const cleaned = cleanActiveContent(scanned, tick);
    if (!active(cleaned)) return cleaned;
    return escapeHtml(body);
  } catch {
    // Fail closed on every parser and scanner failure (depth sentinel, attribute bound, RangeError
    // from a pathological tree): a public page must never return a 500 for crafted content.
    return escapeHtml(body);
  }
}

/**
 * Elements whose content a browser reads as raw text, not as markup. The pre-scan must skip to the
 * matching end tag, or a literal `<div>` inside a `<style>` would be counted as nesting.
 */
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'noscript',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
]);

/**
 * A linear, best-effort early exit over the scanner's output. It is not the authority on HTML
 * scope: table, template and foreign-content rules are subtle enough that any rule here can
 * disagree with parse5. The depth-bounding tree adapter is the real bound; this scan only catches
 * the common hostile shapes before parse5 starts. Undercounting is therefore safe, and where a
 * choice is cheap we overcount so pathological input fails closed earlier.
 *
 * Raw text is skipped only when the markup contains no foreign content: `<svg><style>` and
 * `<math><style>` look like raw text here but are not to a browser, and the divs after them are
 * real nesting.
 */
const FOREIGN_CONTENT = /<(?:svg|math)(?:[\s/>]|$)/i;

function exceedsNestingCap(markup: string, cap: number, tick: Tick = () => {}): boolean {
  const hasForeignContent = FOREIGN_CONTENT.test(markup);
  let depth = 0;
  let steps = 0;
  const open = new Map<string, number>();
  let i = 0;
  while (i < markup.length) {
    if (++steps % BUDGET_CHECK_EVERY === 0) tick();
    const at = markup.indexOf('<', i);
    if (at < 0) break;
    i = at + 1;
    if (markup.startsWith('<!--', at)) {
      const after = commentEnd(markup, at + 4);
      if (after < 0) break;
      i = after;
      continue;
    }
    if (markup[at + 1] === '!') {
      const end = markup.indexOf('>', at + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    const tag = parseTag(markup, at);
    if (tag === null) continue;
    if ('unterminated' in tag) break;
    i = tag.end;
    if (tag.endTag) {
      const count = open.get(tag.lowerName) ?? 0;
      if (count > 0) {
        open.set(tag.lowerName, count - 1);
        depth--;
      }
      continue;
    }
    if (VOID_ELEMENTS.has(tag.lowerName)) continue;
    // Raw-text content is not markup to a browser. Skip the whole element; its end tag closes it,
    // so the element itself adds no net level. Only safe when no foreign content could turn one
    // of these names into an ordinary SVG/MathML element.
    if (!hasForeignContent && RAW_TEXT_ELEMENTS.has(tag.lowerName)) {
      i = findEndTagEnd(markup, tag.lowerName, tag.end);
      continue;
    }
    open.set(tag.lowerName, (open.get(tag.lowerName) ?? 0) + 1);
    depth++;
    if (depth > cap) return true;
  }
  return false;
}

interface EmailExtraction {
  styles: string[];
  bodyStart: number;
  bodyEnd: number;
  pixels: { start: number; end: number }[];
}

/** A 1×1 image is an open-tracking pixel: width and height, either order, each "1" or "1px". */
function isTrackingPixel(attributes: readonly TagAttribute[]): boolean {
  let width = false;
  let height = false;
  for (const attribute of attributes) {
    if (attribute.value === null) continue;
    const value = attribute.value.toLowerCase();
    if (value !== '1' && value !== '1px') continue;
    if (attribute.lowerName === 'width') width = true;
    else if (attribute.lowerName === 'height') height = true;
  }
  return width && height;
}

/** Removes non-overlapping ranges from `text` in one pass, keeping every other byte. */
function removeRanges(text: string, ranges: readonly (readonly [number, number])[]): string {
  if (ranges.length === 0) return text;
  let out = '';
  let last = 0;
  for (const [start, end] of ranges) {
    if (start < last) continue;
    if (start > last) out += text.slice(last, start);
    last = end;
  }
  return out + text.slice(last);
}

/**
 * Lower-cases only ASCII `A`–`Z`, so every offset in the result is the same offset in the input.
 * JavaScript `toLowerCase()` is not length-preserving (`İ` becomes two code units), so its offsets
 * must never be used to slice the original string (#748).
 */
function asciiLower(input: string): string {
  return input.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/**
 * One linear, quote-aware pass over the rendered e-mail, collecting the `<style>` bodies, the
 * `<body>` content and the 1×1 images. Each tag is parsed once and every search pointer moves
 * only forward, so repeated openers with no close cannot make the extraction quadratic (#574,
 * #577).
 */
function extractEmailParts(html: string): EmailExtraction {
  // ASCII-only: a length-changing Unicode case fold would shift every offset used on `html`.
  const lower = asciiLower(html);
  const styles: string[] = [];
  const pixels: { start: number; end: number }[] = [];
  let bodyStart = -1;
  let bodyEnd = -1;
  let styleClose = lower.indexOf('</style>');
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open < 0) break;
    i = open + 1;
    // Comments are deliberately not special here: the old extraction regexes searched them too,
    // and MJML puts some of its <style> elements inside MSO conditional comments.
    const tag = parseTag(html, open);
    if (tag === null) continue;
    if ('unterminated' in tag) break;
    i = tag.end;
    if (tag.endTag) {
      if (bodyStart >= 0 && bodyEnd < 0 && tag.lowerName === 'body') bodyEnd = open;
      continue;
    }
    while (styleClose >= 0 && styleClose < open) styleClose = lower.indexOf('</style>', styleClose + 1);
    if (tag.lowerName === 'style' && styleClose >= tag.end) {
      styles.push(html.slice(tag.end, styleClose));
      i = styleClose + '</style>'.length;
      styleClose = lower.indexOf('</style>', i);
      continue;
    }
    if (bodyStart < 0 && tag.lowerName === 'body') bodyStart = tag.end;
    if (tag.lowerName === 'img' && isTrackingPixel(tag.attributes)) pixels.push({ start: open, end: tag.end });
  }
  return { styles, bodyStart, bodyEnd, pixels };
}

/** Splits MJML's complete document into the parts that can sit inside our page. */
function computeEmailParts(html: string): { body: string; styles: string } {
  const { styles, bodyStart, bodyEnd, pixels } = extractEmailParts(html);
  const hasBody = bodyStart >= 0 && bodyEnd >= bodyStart;
  const offset = hasBody ? bodyStart : 0;
  const rawBody = hasBody ? html.slice(bodyStart, bodyEnd) : html;
  // The pixel is removed before sanitising, so the parser judges the final bytes: a removal
  // afterwards could join the pieces around it into new markup (`<me<img …>ta …>`).
  const body = removeRanges(
    rawBody,
    pixels
      .filter((pixel) => (hasBody ? pixel.start >= bodyStart && pixel.end <= bodyEnd : true))
      .map((pixel) => [pixel.start - offset, pixel.end - offset] as const),
  );
  return {
    body: sanitiseEmailBody(body),
    // The styles go back into the page's own <style>. CSS reads `\3c ` as `<`, so escaping every
    // `<` keeps the rules while making `</style>` (and anything after it) impossible to inject.
    styles: styles.join('\n').replace(/</g, '\\3c '),
  };
}

/**
 * The public archive's entry point for rendered e-mail parts, memoised by a SHA-256 of the HTML.
 * Every archive and web-version request re-renders stored content, so a repeat of the same issue
 * costs one hash and one lookup instead of a parse. The cache is bounded by entries and bytes, and
 * the first unseen input is still parsed once under the size, attribute and depth bounds above.
 */
export function emailParts(html: string): { body: string; styles: string } {
  return cachedEmailParts(html, computeEmailParts);
}

const brandStyles = (brand: ResolvedBrand) => {
  const colors = Object.entries(brand.colors)
    .map(([name, value]) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(';');
  return `:root{color-scheme:light;${colors};--radius:${brand.radius}px;--font-stack:${brand.fontStack};--measure:40rem}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{margin:0}
body{min-height:100vh;padding:32px 16px;background:var(--background);color:var(--text);font-family:var(--font-stack);font-size:1rem;line-height:1.55}
.skip{position:absolute;left:-9999px;top:0;padding:.5rem .75rem;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius)}
.skip:focus{left:1rem;top:1rem}
.page{width:100%;max-width:var(--measure);margin:0 auto}
a{color:var(--accent);text-underline-offset:.15em}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.brand{display:flex;align-items:center;gap:.75rem;margin:0 0 1.5rem;flex-wrap:wrap}
.logo{display:block;max-width:100%;width:auto;max-height:96px}
.site-name{margin:0;font-size:1rem;font-weight:600;color:var(--text);overflow-wrap:anywhere}
h1{margin:0 0 .5rem;font-size:clamp(1.5rem,4.5vw,2rem);line-height:1.25;letter-spacing:-.01em;overflow-wrap:anywhere}
h2{margin:0;font-size:1.1rem;line-height:1.35;overflow-wrap:anywhere}
p{margin:0 0 1rem;color:var(--text);overflow-wrap:anywhere}
p:last-child{margin-bottom:0}
.meta{margin:0 0 .75rem;font-size:.85rem;color:var(--muted)}
.lead{font-size:1.05rem;margin:0 0 2rem;color:var(--text)}
.issues{list-style:none;margin:0;padding:0}
.issues li{padding:1.5rem 0;border-top:1px solid var(--border)}
.issues li:first-child{border-top:0;padding-top:0}
.issues h2 a{color:var(--text);text-decoration:none}
.issues h2 a:hover{color:var(--accent);text-decoration:underline}
.summary{margin:.5rem 0 0}
.empty{padding:1rem;border:1px dashed var(--border);border-radius:var(--radius)}
.issue .email-body{margin:2rem 0;overflow-x:auto}
.email-body img{max-width:100%;height:auto}
.email-body table{max-width:100%}
.subscribe{margin:2rem 0 0;padding:1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.subscribe h2{margin:0 0 .25rem}
.subscribe p{margin:0 0 1rem}
.button{display:inline-block;min-height:44px;padding:.7rem 1.25rem;border-radius:var(--radius);background:var(--accent);color:var(--accent-text);font-weight:600;text-decoration:none}
.button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
footer{margin:2rem 0 0;padding:1.5rem 0 0;border-top:1px solid var(--border);font-size:.9rem;color:var(--muted)}
.feed{margin:1.5rem 0 0;font-size:.9rem}
.pager{display:flex;flex-wrap:wrap;gap:1rem;justify-content:space-between;align-items:center;margin:2rem 0 0;font-size:.95rem}
.issue-nav{margin:2rem 0 0}
@media (max-width:480px){body{padding:16px}.subscribe{padding:1rem}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;
};

interface ShellInput {
  brand: ResolvedBrand;
  title: string;
  description: string;
  body: string;
  noindex?: boolean;
  canonical?: string | null;
  ogType?: 'website' | 'article';
  publishedAt?: string;
  jsonLd?: unknown;
  extraStyles?: string[];
}

function shell(input: ShellInput): string {
  const { brand } = input;
  const siteUrl = brand.siteUrl;
  const logo = brand.logoUrl
    ? `<img class="logo" src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.logoAlt ?? brand.siteName ?? '')}" height="${brand.logoHeight}" style="height:${brand.logoHeight}px">`
    : '';
  const header = brand.logoUrl
    ? `<header class="brand">${logo}${brand.siteName && siteUrl ? `<a class="site-name" href="${escapeHtml(siteUrl)}">${escapeHtml(brand.siteName)}</a>` : brand.siteName ? `<p class="site-name">${escapeHtml(brand.siteName)}</p>` : ''}</header>`
    : brand.siteName
      ? `<header class="brand">${siteUrl ? `<a class="site-name" href="${escapeHtml(siteUrl)}">${escapeHtml(brand.siteName)}</a>` : `<p class="site-name">${escapeHtml(brand.siteName)}</p>`}</header>`
      : '';
  const footer = siteUrl
    ? `<footer><a href="${escapeHtml(siteUrl)}">${escapeHtml(brand.siteName ?? new URL(siteUrl).hostname)}</a></footer>`
    : '';
  const image = brand.logoUrl ? `<meta property="og:image" content="${escapeHtml(brand.logoUrl)}">` : '';
  const social = `
<meta property="og:type" content="${input.ogType ?? 'website'}">
<meta property="og:title" content="${escapeHtml(input.title)}">
<meta property="og:description" content="${escapeHtml(input.description)}">
${input.canonical ? `<meta property="og:url" content="${escapeHtml(input.canonical)}">` : ''}
${brand.siteName ? `<meta property="og:site_name" content="${escapeHtml(brand.siteName)}">` : ''}
${input.publishedAt ? `<meta property="article:published_time" content="${escapeHtml(input.publishedAt)}">` : ''}
${image}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(input.title)}">
<meta name="twitter:description" content="${escapeHtml(input.description)}">`;
  const jsonLd = input.jsonLd ? `<script type="application/ld+json">${JSON.stringify(input.jsonLd).replace(/</g, '\\u003c')}</script>` : '';
  return `<!doctype html>
<html lang="${escapeHtml(brand.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${escapeHtml(input.description)}">
<meta name="robots" content="${input.noindex ? 'noindex,nofollow' : 'index,follow'}">
${input.canonical ? `<link rel="canonical" href="${escapeHtml(input.canonical)}">` : ''}
<title>${escapeHtml(input.title)}</title>
${social}
${jsonLd}
<style>${brandStyles(brand)}${(input.extraStyles ?? []).map((s) => `\n${s}`).join('')}</style>
</head>
<body><a class="skip" href="#main">Skip to content</a><div class="page">${header}<main id="main">${input.body}</main>${footer}</div></body>
</html>`;
}

function archiveHeaders(cache: string) {
  return {
    'content-security-policy':
      "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': cache,
  };
}

const PUBLIC_CACHE = 'public, max-age=300, stale-while-revalidate=600';
const PRIVATE_CACHE = 'private, no-store';

function archiveTitle(brand: ResolvedBrand, brandContent: Brand): string {
  return brandContent.archive.title?.trim() || (brand.siteName ? `${brand.siteName} archive` : 'Newsletter archive');
}

function dateTime(value: string) {
  return new Date(value).toISOString();
}

export function renderArchiveIndex(
  brandContent: Brand,
  brand: ResolvedBrand,
  settings: ArchiveSettingsView,
  issues: ArchiveIssue[],
  base: string,
  page: number,
): string {
  const title = archiveTitle(brand, brandContent);
  const description = brandContent.archive.description?.trim() || `Every issue of the ${brand.siteName ?? 'newsletter'}, on the web.`;
  const pages = Math.max(1, Math.ceil(issues.length / PER_PAGE));
  const current = Math.min(Math.max(1, page), pages);
  const slice = issues.slice((current - 1) * PER_PAGE, current * PER_PAGE);
  const canonical = current === 1 ? `${base}/` : `${base}/?page=${current}`;
  const list = slice.length
    ? `<ul class="issues">${slice
        .map(
          (issue) => `<li>
  <article>
    <h2><a href="${escapeHtml(issue.url)}">${escapeHtml(issue.subject)}</a></h2>
    <p class="meta"><time datetime="${escapeHtml(dateTime(issue.sentAt))}">${escapeHtml(dateLabel(issue.sentAt, brand))}</time></p>
    ${issue.summary ? `<p class="summary">${escapeHtml(issue.summary)}</p>` : ''}
  </article>
</li>`,
        )
        .join('')}</ul>`
    : '<p class="empty">No issues have been published yet.</p>';
  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Archive pages">
${current > 1 ? `<a href="${escapeHtml(`${base}/?page=${current - 1}`)}">← Newer</a>` : '<span></span>'}
<span aria-current="page">Page ${current} of ${pages}</span>
${current < pages ? `<a href="${escapeHtml(`${base}/?page=${current + 1}`)}">Older →</a>` : '<span></span>'}
</nav>`
      : '';
  const subscribe = settings.subscribeUrl
    ? `<section class="subscribe" aria-labelledby="subscribe-title">
<h2 id="subscribe-title">Subscribe</h2>
<p>Get the next issue by e-mail.</p>
<a class="button" href="${escapeHtml(settings.subscribeUrl)}">Subscribe</a>
</section>`
    : '';
  const feed = `<p class="feed"><a href="${escapeHtml(`${base}/feed.xml`)}">RSS feed</a></p>`;
  return shell({
    brand,
    title,
    description: metaDescription(description, title),
    canonical,
    body: `<h1>${escapeHtml(title)}</h1>${description ? `<p class="lead">${escapeHtml(description)}</p>` : ''}${list}${pager}${subscribe}${feed}`,
  });
}

export function renderArchiveIssue(
  brandContent: Brand,
  brand: ResolvedBrand,
  settings: ArchiveSettingsView,
  issue: ArchiveIssue,
  emailHtml: string,
  base: string,
): string {
  const title = `${issue.subject} · ${archiveTitle(brand, brandContent)}`;
  const description = metaDescription(issue.summary, issue.subject);
  const { body, styles } = emailParts(emailHtml);
  const subscribe = settings.subscribeUrl
    ? `<section class="subscribe" aria-labelledby="subscribe-title">
<h2 id="subscribe-title">Subscribe</h2>
<p>Get the next issue by e-mail.</p>
<a class="button" href="${escapeHtml(settings.subscribeUrl)}">Subscribe</a>
</section>`
    : '';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: issue.subject,
    description,
    datePublished: issue.sentAt,
    url: issue.url,
    mainEntityOfPage: issue.url,
    ...(brand.siteName ? { publisher: { '@type': 'Organization', name: brand.siteName } } : {}),
  };
  return shell({
    brand,
    title,
    description,
    canonical: issue.url,
    ogType: 'article',
    publishedAt: issue.sentAt,
    jsonLd,
    extraStyles: [styles],
    body: `<article class="issue">
<header class="issue-header">
<p class="meta">${escapeHtml(archiveTitle(brand, brandContent))}</p>
<h1>${escapeHtml(issue.subject)}</h1>
<p class="meta"><time datetime="${escapeHtml(dateTime(issue.sentAt))}">${escapeHtml(dateLabel(issue.sentAt, brand))}</time></p>
</header>
<div class="email-body">${body}</div>
</article>
<nav class="issue-nav" aria-label="Archive navigation"><a href="${escapeHtml(`${base}/`)}">← All issues</a></nav>${subscribe}`,
  });
}

export function renderWebVersion(brand: ResolvedBrand, subject: string, archiveUrl: string | null, emailHtml: string): string {
  const { body, styles } = emailParts(emailHtml);
  return shell({
    brand,
    title: subject,
    description: `${subject} — web version`,
    noindex: true,
    extraStyles: [styles],
    body: `<article class="issue">
<header class="issue-header">
<p class="meta">Web version</p>
<h1>${escapeHtml(subject)}</h1>
</header>
<div class="email-body">${body}</div>
</article>
${archiveUrl ? `<nav class="issue-nav" aria-label="Archive navigation"><a href="${escapeHtml(archiveUrl)}">Read the archive</a></nav>` : ''}`,
  });
}

const xmlEscape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

export function renderFeed(brandContent: Brand, brand: ResolvedBrand, settings: ArchiveSettingsView, issues: ArchiveIssue[], base: string) {
  const title = archiveTitle(brand, brandContent);
  const description = brandContent.archive.description?.trim() || `Every issue of the ${brand.siteName ?? 'newsletter'}.`;
  const items = issues
    .slice(0, 20)
    .map(
      (issue) => `    <item>
      <title>${xmlEscape(issue.subject)}</title>
      <link>${xmlEscape(issue.url)}</link>
      <guid isPermaLink="true">${xmlEscape(issue.url)}</guid>
      <pubDate>${new Date(issue.sentAt).toUTCString()}</pubDate>
      <description>${xmlEscape(issue.summary)}</description>
    </item>`,
    )
    .join('\n');
  const last = issues[0]?.sentAt ?? new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(title)}</title>
    <link>${xmlEscape(settings.indexUrl ?? `${base}/`)}</link>
    <description>${xmlEscape(description)}</description>
    <language>${xmlEscape(brand.language)}</language>
    <lastBuildDate>${new Date(last).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

export function renderSitemap(issues: ArchiveIssue[], base: string): string {
  const entries = [{ loc: `${base}/`, lastmod: issues[0]?.sentAt }, ...issues.map((i) => ({ loc: i.url, lastmod: i.sentAt }))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${xmlEscape(e.loc)}</loc>
    ${e.lastmod ? `<lastmod>${day(new Date(e.lastmod))}</lastmod>` : ''}
  </url>`,
  )
  .join('\n')}
</urlset>`;
}

export interface ArchiveRouteDeps {
  db: Db;
  kp: KeyProvider;
  links: { sign(payload: object): string; verify<T>(token: string): T | null };
  linksUrl: string;
}

/** Public archive and web-version routes, mounted on the links host next to /u and /f. */
export function archiveRoutes(deps: ArchiveRouteDeps) {
  const app = new Hono<{ Variables: { publicRequest?: PublicRequest } }>();
  const notFound = (c: Context) => c.text('Not found.', 404);
  // The brand host this request arrived on (#185): its links stay on that host, and an archive
  // slug or web token from another workspace is not served here.
  const requestOf = (c: Context) => c.get('publicRequest');
  const linksBase = (c: Context) => requestOf(c)?.linksUrl ?? deps.linksUrl;
  const workspaceOf = (c: Context) => requestOf(c)?.workspaceId ?? undefined;
  const crossBrand = (c: Context, workspaceId: string) => {
    const request = requestOf(c);
    return !!request?.workspaceId && request.workspaceId !== workspaceId;
  };

  const load = async (c: Context, slug: string) => {
    const hit = await archiveForSlug(deps.db, slug, workspaceOf(c));
    if (!hit) return null;
    const base = linksBase(c);
    const issues = await deps.db.withWorkspace(hit.workspaceId, (tx) => listArchiveIssues(tx, hit.brand, base));
    return { ...hit, issues, settings: settingsView(hit.brand, base) };
  };

  app.get('/n/:slug/feed.xml', async (c) => {
    const archive = await load(c, c.req.param('slug'));
    if (!archive) return notFound(c);
    const base = `${linksBase(c)}/n/${archive.settings.slug ?? ''}`;
    return c.body(renderFeed(archive.brand, resolveBrand(archive.brand), archive.settings, archive.issues, base), 200, {
      'content-type': 'application/rss+xml; charset=utf-8',
      ...archiveHeaders(PUBLIC_CACHE),
    });
  });

  app.get('/n/:slug/sitemap.xml', async (c) => {
    const archive = await load(c, c.req.param('slug'));
    if (!archive) return notFound(c);
    const base = `${linksBase(c)}/n/${archive.settings.slug ?? ''}`;
    return c.body(renderSitemap(archive.issues, base), 200, {
      'content-type': 'application/xml; charset=utf-8',
      ...archiveHeaders(PUBLIC_CACHE),
    });
  });

  app.get('/n/:slug', async (c) => {
    const archive = await archiveForSlug(deps.db, c.req.param('slug'), workspaceOf(c));
    if (!archive) return notFound(c);
    return c.redirect(`${linksBase(c)}/n/${archive.brand.archive.slug ?? ''}/`, 301);
  });

  app.get('/n/:slug/', async (c) => {
    const archive = await load(c, c.req.param('slug'));
    if (!archive) return notFound(c);
    const base = `${linksBase(c)}/n/${archive.settings.slug ?? ''}`;
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const html = renderArchiveIndex(archive.brand, resolveBrand(archive.brand), archive.settings, archive.issues, base, page);
    return c.html(html, 200, archiveHeaders(PUBLIC_CACHE));
  });

  app.get('/n/:slug/:issue', async (c) => {
    const slug = c.req.param('slug');
    const issueSlug = c.req.param('issue');
    // /n/w/<token> is the signed web version. A workspace archive slug "w" is rejected on publish.
    if (slug === 'w') return webVersion(c, issueSlug);
    const archive = await load(c, slug);
    if (!archive) return notFound(c);
    const issue = archive.issues.find((i) => i.slug === issueSlug);
    if (!issue) return notFound(c);
    return issuePage(c, archive, issue);
  });

  /** Renders one sent message as its recipient saw it, with live unsubscribe/preferences links. */
  async function webVersion(c: Context, token: string) {
    const link = deps.links.verify<WebLink>(token);
    if (!link || typeof link.w !== 'string' || typeof link.m !== 'string') return notFound(c);
    if (crossBrand(c, link.w)) return notFound(c);
    if (link.x !== undefined && link.x < Date.now()) return c.text('This link has expired.', 410);
    const base = linksBase(c);
    const page = await deps.db.withWorkspace(link.w, async (tx) => {
      const [message] = await tx.select().from(schema.messages).where(eq(schema.messages.id, link.m));
      if (!message) return null;
      if (message.channel !== 'email' || !message.templateId || !message.templateVersion) return null;
      const template = artifactTypes.email_template.content.safeParse(
        await versionContent(tx, message.templateId, message.templateVersion),
      );
      if (!template.success) return null;
      const profile = message.profileId ? await profileForMessage(tx, link.w, message.profileId, deps.kp) : null;
      const unsubscribe = `${base}/u/${deps.links.sign({
        w: link.w,
        p: message.profileId ?? '',
        u: message.purpose,
        m: message.id,
      } satisfies UnsubscribeLink)}`;
      let rendered: Awaited<ReturnType<typeof renderTemplate>>;
      try {
        rendered = await renderTemplate(template.data, {
          ...message.data,
          profile: profile?.vars ?? {},
          unsubscribe_url: unsubscribe,
          preferences_url: unsubscribe,
          web_url: `${base}/n/w/${token}`,
        });
      } catch {
        return null;
      }
      const brand = await publishedSingleton(tx, 'brand');
      let archive: string | null = null;
      if (brand?.archive.enabled && message.journeyId) {
        archive = (await listArchiveIssues(tx, brand, base)).find((i) => i.artifactId === message.journeyId)?.url ?? null;
      }
      return { brand: resolveBrand(brand), subject: rendered.subject, html: rendered.html, archive };
    });
    if (!page) return notFound(c);
    return c.html(renderWebVersion(page.brand, page.subject, page.archive, page.html), 200, archiveHeaders(PRIVATE_CACHE));
  }

  async function issuePage(c: Context, archive: Awaited<ReturnType<typeof load>> & object, issue: ArchiveIssue) {
    // Re-render the sent template with empty personalisation for the public page; the web version
    // above is the only place a recipient's own data appears.
    const html = await deps.db.withWorkspace(archive.workspaceId, async (tx) => {
      const runs = await tx
        .select({ version: schema.broadcastRuns.version })
        .from(schema.broadcastRuns)
        .where(and(eq(schema.broadcastRuns.broadcastId, issue.artifactId), eq(schema.broadcastRuns.status, 'done')))
        .limit(1);
      const run = runs[0];
      if (!run) return null;
      const sent = artifactTypes.broadcast.content.safeParse(await versionContent(tx, issue.artifactId, run.version));
      if (!sent.success) return null;
      const [message] = await tx
        .select({ templateVersion: schema.messages.templateVersion })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.journeyId, issue.artifactId),
            eq(schema.messages.channel, 'email'),
            eq(schema.messages.templateId, sent.data.template),
          ),
        )
        .orderBy(asc(schema.messages.createdAt))
        .limit(1);
      let templateVersion = message?.templateVersion ?? null;
      if (!templateVersion) {
        const [template] = await tx
          .select({ publishedVersion: schema.artifacts.publishedVersion })
          .from(schema.artifacts)
          .where(eq(schema.artifacts.id, sent.data.template));
        templateVersion = template?.publishedVersion ?? null;
      }
      if (!templateVersion) return null;
      const template = artifactTypes.email_template.content.safeParse(await versionContent(tx, sent.data.template, templateVersion));
      if (!template.success) return null;
      try {
        return (await renderTemplate(template.data, archiveVars(template.data))).html;
      } catch {
        return null;
      }
    });
    if (!html) return notFound(c);
    const base = `${linksBase(c)}/n/${archive.settings.slug ?? ''}`;
    return c.html(
      renderArchiveIssue(archive.brand, resolveBrand(archive.brand), archive.settings, issue, html, base),
      200,
      archiveHeaders(PUBLIC_CACHE),
    );
  }

  return app;
}

// A brand may not use "w": /n/w/<token> is the web version on the same links host.
publishValidators.set('brand', async (content, tx) => {
  const brand = content as Brand;
  if (!brand.archive.enabled) return [];
  const problems: string[] = [];
  if (!brand.archive.slug) problems.push('The newsletter archive needs a slug (archive.slug).');
  else if (brand.archive.slug === 'w') problems.push('The archive slug "w" is reserved for web versions; choose another.');
  else {
    // Slugs are unique per links host, i.e. across workspaces. This transaction sees only its own
    // workspace, so it asks one narrow function (migration 0036) instead of reading other tenants.
    const { rows } = await tx.execute<{ taken: boolean }>(sql`SELECT archive_slug_taken(${brand.archive.slug}) AS taken`);
    if (rows[0]?.taken)
      problems.push(
        `The archive slug "${brand.archive.slug}" is already used by another workspace on this links host. Choose a different slug.`,
      );
  }
  return problems;
});

export const listArchiveIssuesCommand = defineCommand({
  name: 'archive.issues',
  title: 'Newsletter archive issues',
  description:
    'The workspace’s public newsletter archive settings and its published issues, newest first, with their URLs on the links host. Includes only broadcasts that were sent and whose live version says archive.publish; drafts never appear. Use it to check a broadcast’s archive URL or to link the live archive.',
  input: z.object({}),
  output: z.object({
    settings: z.object({
      enabled: z.boolean(),
      title: z.string().nullable(),
      description: z.string().nullable(),
      slug: z.string().nullable(),
      indexUrl: z.string().nullable().describe('Live archive index on the links host, when enabled'),
      feedUrl: z.string().nullable(),
      sitemapUrl: z.string().nullable(),
      subscribeUrl: z.string().nullable(),
    }),
    issues: z.array(
      z.object({
        artifactId: z.string().describe('The broadcast id'),
        name: z.string(),
        slug: z.string(),
        subject: z.string(),
        summary: z.string(),
        sentAt: z.string(),
        url: z.string(),
      }),
    ),
  }),
  permission: 'artifacts:read',
  effect: 'read',
  handler: async (_input, ctx) => {
    const brand = await publishedSingleton(ctx.tx, 'brand');
    const linksUrl = ctx.services.linksUrlFor
      ? await ctx.services.linksUrlFor(ctx.principal.workspaceId)
      : (ctx.services.linksUrl ?? ctx.services.publicUrl ?? '');
    return {
      settings: settingsView(brand, linksUrl),
      issues: brand ? await listArchiveIssues(ctx.tx, brand, linksUrl) : [],
    };
  },
});

export const archiveCommands = [listArchiveIssuesCommand] as const;
