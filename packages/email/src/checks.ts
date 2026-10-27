import { createHash } from 'node:crypto';
import type { EmailTemplate } from '@agentic-marketing/artifacts';
import { Parser } from 'htmlparser2';
import { type Rendered, type RenderOptions, type RenderVars, renderTemplate } from './render';

// Pre-send checks (#90): a template can be valid MJML/Liquid and still fail in an inbox, so this
// inspects the rendered e-mail (the same output the preview shows, with the sample data) for the
// things a person would otherwise have to spot by hand. Every finding is concrete and stable;
// the only slow part, link reachability, is opt-in and never fetches a personalised URL.

export type Severity = 'blocking' | 'warning' | 'info';
export type Category = 'compliance' | 'links' | 'images' | 'rendering' | 'personalisation' | 'subject';

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  message: string;
  location?: string;
  fix?: string;
}

export interface CheckSummary {
  blocking: number;
  warning: number;
  info: number;
}

export interface CheckResult {
  findings: Finding[];
  checkedAt: string;
  summary: CheckSummary;
}

/** Asset metadata the image checks need; sizes come from the asset table, never from a fetch. */
export interface AssetInfo {
  byteSize: number;
  contentType: string;
  width: number | null;
  height: number | null;
  /** The PNG rendition of an SVG: what e-mail actually loads. */
  renditionByteSize?: number | null;
}

/** A cached link outcome, per URL for an hour. */
export interface LinkCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface EmailCheckOptions {
  /** Marketing e-mail needs an unsubscribe link; transactional mail does not. */
  marketing: boolean;
  /** Channels the purpose declares; undefined when the purpose is unknown. */
  purposeChannels?: string[];
  checkLinks?: boolean;
  /** Our own links (assets, unsubscribe, click tracking, confirm, web version) are never fetched. */
  platformUrl?: (url: string) => boolean;
  /** HEAD, falling back to a ranged GET, under the egress policy. */
  request?: (url: string, method: 'HEAD' | 'GET') => Promise<{ status: number }>;
  /** Asset metadata by id, for the image checks; omitted when there is no asset library to read. */
  assets?: (ids: string[]) => Promise<Map<string, AssetInfo>>;
  cache?: LinkCache;
  now?: () => Date;
  /** How to render, e.g. the resolver for {% block %} tags (#73); a template using blocks can't render without it. */
  render?: RenderOptions;
}

/** At most this many links are fetched per check; the rest stay unverified. */
export const MAX_LINK_CHECKS = 30;
const CACHE_TTL_S = 3600;
/** Gmail clips a message whose HTML is larger than this. */
const CLIPPING_BYTES = 102 * 1024;
/** More image bytes than this is slow on a phone and often clipped by clients. */
const IMAGE_WEIGHT_BYTES = 1024 * 1024;

/**
 * Kept short and literal (#90): each match is one finding that names the phrase, so an author can
 * fix it without guessing. Grown from real spam-filter complaints, not a bought list.
 */
export const SPAM_PHRASES = [
  'act now',
  'buy now',
  'click here',
  'free money',
  'guaranteed',
  'limited time offer',
  'no obligation',
  'risk-free',
];

const SHORTENERS = new Set(['bit.ly', 'buff.ly', 'goo.gl', 'is.gd', 'ow.ly', 'shorturl.at', 't.co', 'tinyurl.com']);

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

class Collector {
  private findings = new Map<string, Finding>();

  add(
    category: Category,
    kind: string,
    severity: Severity,
    message: string,
    extra: { location?: string; fix?: string; key?: string } = {},
  ) {
    const key = extra.key ?? extra.location ?? message;
    const id = `${category}.${kind}:${sha(`${kind}|${key}`)}`;
    if (!this.findings.has(id)) this.findings.set(id, { id, severity, category, message, location: extra.location, fix: extra.fix });
  }

  all(): Finding[] {
    return [...this.findings.values()];
  }
}

interface ScannedLink {
  href: string;
  text: string;
}

interface ScannedImage {
  src: string;
  alt: string | null;
  width: string;
  height: string;
}

/** Links and images of the rendered HTML, with their text and attributes. */
export function scanHtml(html: string): { links: ScannedLink[]; images: ScannedImage[] } {
  const links: ScannedLink[] = [];
  const images: ScannedImage[] = [];
  let current: ScannedLink | null = null;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'a') {
          const href = attribs.href;
          if (href !== undefined) current = { href, text: '' };
        } else if (name === 'img') {
          images.push({
            src: attribs.src ?? '',
            alt: attribs.alt === undefined ? null : attribs.alt,
            width: attribs.width ?? '',
            height: attribs.height ?? '',
          });
          // An image inside a link is its text, when it has alt text.
          if (current && attribs.alt) current.text += attribs.alt;
        }
      },
      ontext(text) {
        if (current) current.text += text;
      },
      onclosetag(name) {
        if (name === 'a' && current) {
          links.push(current);
          current = null;
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return { links, images };
}

const memCache = new Map<string, { at: number; value: string }>();

/** The memory cache used when no Valkey is configured (tests, single-process installs). */
export const memoryLinkCache: LinkCache = {
  async get(key) {
    const hit = memCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_S * 1000) {
      memCache.delete(key);
      return null;
    }
    return hit.value;
  },
  async set(key, value) {
    memCache.set(key, { at: Date.now(), value });
  },
};

/** For tests: forget cached link results. */
export const clearLinkCache = () => memCache.clear();

interface LinkOutcome {
  status?: number;
  error?: string;
}

async function linkOutcome(
  url: string,
  deps: { request: NonNullable<EmailCheckOptions['request']>; cache: LinkCache },
): Promise<LinkOutcome> {
  const key = `checks:link:${sha(url)}`;
  const cached = await deps.cache.get(key);
  if (cached) {
    try {
      return JSON.parse(cached) as LinkOutcome;
    } catch {
      // A corrupt cache entry is just a miss.
    }
  }
  let outcome: LinkOutcome;
  try {
    let res = await deps.request(url, 'HEAD');
    // Plenty of servers refuse HEAD outright; one small ranged GET answers the same question.
    if (res.status === 403 || res.status === 405 || res.status === 501) res = await deps.request(url, 'GET');
    outcome = { status: res.status };
  } catch (e) {
    outcome = { error: (e as Error).message.split('\n')[0].slice(0, 200) };
  }
  await deps.cache.set(key, JSON.stringify(outcome), CACHE_TTL_S);
  return outcome;
}

/** Runs `fn` over `items` with at most `n` in flight, so 30 links do not open 30 sockets at once. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** The sample data, with every string replaced by a marker: a link that changes is personalised. */
function markerVars(vars: RenderVars): RenderVars {
  let n = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return `zzcheck${++n}zz`;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out: RenderVars = {};
  for (const [k, v] of Object.entries(vars)) {
    if (k === 'unsubscribe_url' || k === 'preferences_url') continue;
    out[k] = walk(v);
  }
  return out;
}

/** Hrefs that change when the data changes carry someone's details: never fetch those. */
async function personalisedHrefs(t: EmailTemplate, vars: RenderVars, hrefs: string[]): Promise<Set<string>> {
  const probe = scanHtml((await renderTemplate(t, markerVars(vars))).html).links.map((l) => l.href.trim());
  if (probe.length !== hrefs.length) return new Set(hrefs);
  return new Set(hrefs.filter((h, i) => h !== probe[i]));
}

function checkCompliance(t: EmailTemplate, opts: EmailCheckOptions, c: Collector) {
  if (opts.marketing && !/unsubscribe_url/.test(t.mjml))
    c.add('compliance', 'unsubscribe', 'blocking', 'A marketing e-mail must contain an unsubscribe link, and this one does not.', {
      location: 'mjml',
      fix: 'Add {{ unsubscribe_url }} to the footer, usually as an “Unsubscribe” link.',
    });
  // A physical address in the footer is a warning, but there is no workspace or brand field to
  // compare against, so there is nothing concrete to report; skip it rather than guess.
  if (opts.purposeChannels && !opts.purposeChannels.includes('email'))
    c.add('compliance', 'purpose', 'info', `The purpose “${t.purpose}” is not marked for the e-mail channel.`, {
      location: `purpose: ${t.purpose}`,
      fix: 'Pick a purpose whose channels include e-mail, or add e-mail to this purpose.',
    });
}

function checkLinks(links: ScannedLink[], c: Collector) {
  const seen = new Set<string>();
  for (const { href, text } of links) {
    const raw = href.trim();
    if (!raw) {
      c.add('links', 'empty', 'warning', 'A link has no address.', { location: 'an empty href' });
      continue;
    }
    if (raw.includes('{{')) continue; // Unresolved Liquid; reported under personalisation.
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
    if (scheme === 'mailto' || scheme === 'tel') continue;
    if (scheme && scheme !== 'http' && scheme !== 'https') {
      // javascript: is a real hazard; other schemes simply do not work in most inboxes.
      const isScript = scheme === 'javascript' || scheme === 'vbscript';
      c.add(
        'links',
        isScript ? 'script' : 'scheme',
        isScript ? 'blocking' : 'warning',
        `A link uses the “${scheme}:” scheme, which e-mail clients refuse to open.`,
        { location: raw.slice(0, 200), fix: 'Link to an https:// address instead.' },
      );
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      c.add('links', 'malformed', 'warning', `“${raw.slice(0, 120)}” is not a valid URL.`, {
        location: raw.slice(0, 200),
        fix: 'Use a full address starting with https://.',
      });
      continue;
    }
    if (!url.hostname.includes('.') && url.hostname !== 'localhost')
      c.add('links', 'malformed', 'warning', `“${url.hostname}” does not look like a complete host.`, {
        location: raw.slice(0, 200),
        fix: 'Use a full address starting with https://.',
      });
    if (SHORTENERS.has(url.hostname.toLowerCase()))
      c.add('links', 'shortener', 'warning', `${url.hostname} is a link shortener, which filters distrust.`, {
        location: raw.slice(0, 200),
        fix: 'Link to the full address instead of a shortener.',
      });
    if (!text.trim() && !seen.has(raw))
      c.add('links', 'text', 'warning', 'A link has no text, so it is read as nothing or as its bare address.', {
        location: raw.slice(0, 200),
        fix: 'Give the link a few words of text, e.g. “Read the issue”.',
      });
    seen.add(raw);
  }
}

async function checkImages(images: ScannedImage[], opts: EmailCheckOptions, c: Collector) {
  const referenced = new Map<string, ScannedImage[]>();
  for (const img of images) {
    const src = img.src.trim();
    const asset = /\/a\/(ast_[0-9a-f]{32})\/([^/?#"']+)/i.exec(src);
    if (asset) {
      const id = asset[1].toLowerCase();
      referenced.set(id, [...(referenced.get(id) ?? []), img]);
    }
    // Empty alt is right for a purely decorative spacer, and wrong everywhere else.
    const spacer = Number(img.width) > 0 && Number(img.width) <= 2 && Number(img.height) > 0 && Number(img.height) <= 2;
    if ((img.alt === null || !img.alt.trim()) && !spacer)
      c.add('images', 'alt', 'warning', 'An image has no alt text, so it is invisible to screen readers and when images are blocked.', {
        location: src ? src.slice(0, 200) : 'an <img> without src',
        fix: 'Describe the image in the alt text, or upload it with alt text in the asset library.',
      });
    if (/\.svg(\?|#|$)/i.test(src) && !asset)
      c.add('images', 'svg', 'warning', 'E-mail clients rarely render SVG; this one is not an asset with a PNG rendition.', {
        location: src.slice(0, 200),
        fix: 'Upload the image to the asset library, which serves a PNG rendition for e-mail.',
      });
  }
  if (!referenced.size || !opts.assets) return;
  const meta = await opts.assets([...referenced.keys()]);
  let total = 0;
  for (const [id, imgs] of referenced) {
    const info = meta.get(id);
    if (!info) {
      c.add('images', 'missing', 'blocking', 'An image points at an asset that does not exist (or was deleted).', {
        location: imgs[0].src.slice(0, 200),
        fix: 'Upload the image again, or pick it from the asset library.',
        key: id,
      });
      continue;
    }
    const isRendition = /\.png$/i.test(imgs[0].src) && info.contentType === 'image/svg+xml';
    total += (isRendition ? (info.renditionByteSize ?? info.byteSize) : info.byteSize) || 0;
  }
  if (total > IMAGE_WEIGHT_BYTES)
    c.add('images', 'weight', 'warning', `The images weigh ${(total / 1024 / 1024).toFixed(1)} MB; over 1 MB is slow on a phone.`, {
      location: 'images',
      fix: 'Compress them or use smaller renditions.',
    });
}

function checkRendering(t: EmailTemplate, rendered: Rendered, c: Collector) {
  const bytes = Buffer.byteLength(rendered.html, 'utf8');
  if (bytes > CLIPPING_BYTES)
    c.add('rendering', 'size', 'warning', `The HTML is ${Math.round(bytes / 1024)} KB; Gmail clips messages over 102 KB.`, {
      location: 'html',
      fix: 'Shorten the content, or put the long part behind a link.',
    });
  if (!t.preheader)
    c.add('rendering', 'preheader', 'info', 'There is no preheader, so inboxes show the first line of the body instead.', {
      location: 'preheader',
      fix: 'Add a preheader: the line inboxes show after the subject.',
    });
  // The plain-text part is always generated when the template omits it, so there is nothing to report.
}

/** The value at a dotted path, or undefined. */
function valueAt(vars: RenderVars, path: string): unknown {
  let v: unknown = vars;
  for (const part of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[part];
  }
  return v;
}

function checkPersonalisation(t: EmailTemplate, vars: RenderVars, rendered: Rendered, c: Collector) {
  const sources: [string, string | undefined][] = [
    ['subject', t.subject],
    ['mjml', t.mjml],
    ['text', t.text],
  ];
  const reported = new Set<string>();
  for (const [field, src] of sources) {
    if (!src) continue;
    for (const m of src.matchAll(/\{\{([^{}]*)\}\}/g)) {
      const expr = m[1].trim();
      if (!expr || expr.startsWith('#') || /\bdefault\s*:/.test(expr)) continue;
      const path = /^([A-Za-z_][\w.]*)/.exec(expr)?.[1];
      if (!path || reported.has(path)) continue;
      // The platform always provides these two while rendering.
      if (path === 'unsubscribe_url' || path === 'preferences_url') continue;
      const value = valueAt(vars, path);
      if (value !== undefined && value !== null && value !== '') continue;
      reported.add(path);
      c.add('personalisation', 'unresolved', 'info', `“${path}” is empty with the sample data, so readers may see a gap.`, {
        location: `${field}: {{ ${path} }}`,
        fix: `Use a fallback, e.g. {{ ${path} | default: 'there' }}, or add the value to the sample data.`,
        key: path,
      });
    }
  }
  for (const [field, value] of [
    ['subject', rendered.subject],
    ['html', rendered.html],
    ['text', rendered.text],
  ] as const)
    if (/\{\{|\{%/.test(value))
      c.add('personalisation', 'liquid', 'info', `The rendered ${field} still contains Liquid markup, which readers would see.`, {
        location: field,
        fix: 'Check the Liquid syntax; a tag inside a tag is rendered literally.',
      });
}

function checkSubject(subject: string, c: Collector) {
  if (subject.length > 70)
    c.add('subject', 'length', 'info', `The subject is ${subject.length} characters; phones cut it after about 40 and inboxes after 70.`, {
      location: 'subject',
      fix: 'Move the detail into the preheader.',
    });
  const caps = (subject.match(/\b[A-Z]{3,}\b/g) ?? []).filter((w) => !/^(URL|HTML|RSVP|FAQ|PDF|CEO|CTO|HTTP|HTTPS)$/.test(w));
  if (caps.length > 2)
    c.add(
      'subject',
      'caps',
      'warning',
      `${caps.length} words are ALL CAPS (${[...new Set(caps)].slice(0, 4).join(', ')}), which filters treat as shouting.`,
      {
        location: 'subject',
        fix: 'Use sentence case, keeping capitals for names and acronyms.',
      },
    );
  if (/!{3,}/.test(subject) || /\${3,}/.test(subject))
    c.add('subject', 'punctuation', 'warning', 'The subject overuses “!!!” or “$$$”, which spam filters penalise.', {
      location: 'subject',
      fix: 'Use one exclamation mark at most.',
    });
  const lower = subject.toLowerCase();
  for (const phrase of SPAM_PHRASES)
    if (lower.includes(phrase))
      c.add('subject', 'phrase', 'warning', `The subject contains the spam phrase “${phrase}”.`, {
        location: 'subject',
        fix: 'Say the same thing in plain words.',
        key: phrase,
      });
}

function summaryOf(findings: Finding[]): CheckSummary {
  return {
    blocking: findings.filter((f) => f.severity === 'blocking').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

/** Checks a template version the way the preview renders it: with its sample data. */
export async function checkEmailTemplate(t: EmailTemplate, opts: EmailCheckOptions): Promise<CheckResult> {
  const vars = { ...(t.sampleData ?? {}) } as RenderVars;
  const rendered = await renderTemplate(t, vars, opts.render);
  const c = new Collector();
  checkCompliance(t, opts, c);
  const { links, images } = scanHtml(rendered.html);
  checkLinks(links, c);
  await checkImages(images, opts, c);
  checkRendering(t, rendered, c);
  checkPersonalisation(t, vars, rendered, c);
  checkSubject(rendered.subject, c);

  if (opts.checkLinks && opts.request) {
    // example.invalid is the placeholder render uses for links only a real send can build.
    const skip = (url: string) => /(^|\.)invalid([/:]|$)/i.test(url) || (opts.platformUrl?.(url) ?? false);
    const candidates = [...new Set(links.map((l) => l.href.trim()))].filter((h) => {
      if (!/^https?:\/\//i.test(h) || h.includes('{{') || skip(h)) return false;
      try {
        new URL(h);
        return true;
      } catch {
        return false;
      }
    });
    const personalised = await personalisedHrefs(
      t,
      vars,
      links.map((l) => l.href.trim()),
    );
    const fetchable = candidates.filter((h) => !personalised.has(h)).slice(0, MAX_LINK_CHECKS);
    if (candidates.filter((h) => !personalised.has(h)).length > MAX_LINK_CHECKS)
      c.add('links', 'truncated', 'info', `Only the first ${MAX_LINK_CHECKS} links were checked; the rest were not fetched.`, {
        location: 'links',
      });
    const cache = opts.cache ?? memoryLinkCache;
    const outcomes = await pool(fetchable, 4, (url) => linkOutcome(url, { request: opts.request!, cache }));
    for (const [i, url] of fetchable.entries()) {
      const o = outcomes[i];
      const location = url.slice(0, 200);
      if (o.error)
        c.add('links', 'unreachable', 'warning', `The link could not be reached: ${o.error}`, {
          location,
          fix: 'Check the address, or try again later if the site was briefly down.',
        });
      else if (o.status === 404 || o.status === 410 || (o.status !== undefined && o.status >= 500))
        c.add('links', 'broken', 'warning', `The link returned HTTP ${o.status}, so readers land on an error or a missing page.`, {
          location,
          fix: 'Update the address or remove the link.',
        });
      else if (o.status === 401 || o.status === 403 || o.status === 405)
        c.add('links', 'unverified', 'info', `The link answered HTTP ${o.status}; it may still work in a browser.`, { location });
    }
  }

  const findings = c.all();
  return { findings, checkedAt: (opts.now?.() ?? new Date()).toISOString(), summary: summaryOf(findings) };
}

/**
 * The publish gate: only blocking findings stop a publish. Link reachability is not part of it
 * (a slow external check must not make publishing flaky); warnings and notes never block.
 */
export async function emailPublishProblems(
  t: EmailTemplate,
  opts: Omit<EmailCheckOptions, 'checkLinks' | 'request' | 'cache'>,
): Promise<string[]> {
  try {
    const result = await checkEmailTemplate(t, { ...opts, checkLinks: false });
    return result.findings.filter((f) => f.severity === 'blocking').map((f) => f.message);
  } catch (e) {
    return [`the template could not be rendered for its checks: ${(e as Error).message.split('\n')[0]}`];
  }
}

/** Fills a summary in for a result built elsewhere (e.g. by an older cached caller). */
export const summaryOfFindings = summaryOf;
