import { createHmac, timingSafeEqual } from 'node:crypto';
import { Parser } from 'htmlparser2';

// Signed, stateless links in e-mails: one-click unsubscribe (RFC 8058) and click tracking.
// The signature stops anyone from unsubscribing others or turning the redirect into an open
// redirect; the payload carries only ids.

export interface LinkSigner {
  sign(payload: object): string;
  verify<T>(token: string): T | null;
}

export function linkSigner(secret: string): LinkSigner {
  const key = createHmac('sha256', secret).update('email-links').digest();
  const mac = (s: string) => createHmac('sha256', key).update(s).digest('base64url').slice(0, 32);
  return {
    sign(payload) {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${body}.${mac(body)}`;
    },
    verify<T>(token: string) {
      const [body, sig] = token.split('.');
      if (!body || !sig) return null;
      const expected = mac(body);
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
      } catch {
        return null;
      }
    },
  };
}

export interface UnsubscribeLink {
  w: string; // workspace
  p: string; // profile
  u: string; // purpose
  m: string; // message
}
/** A topic-level unsubscribe; the purpose stays as it is. */
export interface TopicLink extends UnsubscribeLink {
  topic: string;
}
export interface ClickLink {
  w: string;
  m: string;
  url: string;
}

/** The signed "view this e-mail in the browser" link (#100). `x` is an optional expiry, in ms. */
export interface WebLink {
  w: string;
  m: string;
  x?: number;
}

interface AnchorTag {
  /** Index of `<` in the source. */
  start: number;
  /** Index of `>` closing the opening tag. */
  end: number;
  /** The raw attribute value, with entities exactly as written. */
  href: string;
}

/**
 * The opening `<a>` tags of an HTML document, with their raw hrefs. The same parser the pre-send
 * checks use handles every quoting style (`"…"`, `'…'`, unquoted) and ignores `>` inside a value,
 * so a hand-written link inside `mj-text` is found as reliably as MJML's own output (#638).
 * `decodeEntities: false` keeps the raw value, which is what the rewriters below transform.
 */
function anchorTags(html: string): AnchorTag[] {
  const tags: AnchorTag[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name !== 'a') return;
        const href = attribs.href;
        if (href === undefined) return;
        tags.push({ start: parser.startIndex, end: parser.endIndex, href });
      },
    },
    { decodeEntities: false, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return tags;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Replaces the value of the first `href` attribute in one opening tag, keeping every other byte.
 * A linear scan, not a regex: attribute values can be long and a lazy pattern backtracks. An
 * unquoted value is emitted double-quoted, because the tagged URL contains `=` and `&amp;`, which
 * an unquoted HTML attribute may not carry.
 */
function replaceHref(tag: string, value: string): string | null {
  const n = tag.length;
  let i = 2; // past "<a"
  while (i < n && !isSpace(tag[i]) && tag[i] !== '/' && tag[i] !== '>') i++;
  while (i < n) {
    while (i < n && (isSpace(tag[i]) || tag[i] === '/')) i++;
    if (i >= n || tag[i] === '>') return null;
    const nameStart = i;
    while (i < n && !isSpace(tag[i]) && tag[i] !== '=' && tag[i] !== '>' && tag[i] !== '/') i++;
    if (i === nameStart) {
      i++;
      continue;
    }
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(tag[i])) i++;
    if (tag[i] !== '=') continue;
    i++;
    while (i < n && isSpace(tag[i])) i++;
    let quote: '"' | "'" | null = null;
    if (tag[i] === '"' || tag[i] === "'") {
      quote = tag[i] as '"' | "'";
      i++;
    }
    const valueStart = i;
    if (quote) while (i < n && tag[i] !== quote) i++;
    else while (i < n && !isSpace(tag[i]) && tag[i] !== '>') i++;
    const valueEnd = i;
    if (name === 'href') {
      if (quote === '"') return `${tag.slice(0, valueStart)}${value.replace(/"/g, '&quot;')}${tag.slice(valueEnd)}`;
      if (quote === "'") return `${tag.slice(0, valueStart)}${value.replace(/'/g, '&#39;')}${tag.slice(valueEnd)}`;
      return `${tag.slice(0, valueStart)}"${value.replace(/"/g, '&quot;')}"${tag.slice(valueEnd)}`;
    }
    if (quote) i++;
  }
  return null;
}

/** Rewrites only the hrefs the callback returns a value for; every other byte stays as it was. */
function rewriteAnchors(html: string, rewrite: (href: string) => string | null): string {
  const tags = anchorTags(html);
  let out = html;
  // Right to left, so replacing a later tag cannot invalidate an earlier tag's offsets.
  for (let k = tags.length - 1; k >= 0; k--) {
    const t = tags[k]!;
    const value = rewrite(t.href);
    if (value === null) continue;
    const replaced = replaceHref(out.slice(t.start, t.end + 1), value);
    if (replaced !== null) out = out.slice(0, t.start) + replaced + out.slice(t.end + 1);
  }
  return out;
}

const HTTP_URL = /^https?:\/\//i;

/** Rewrites http(s) links for click tracking, except the unsubscribe and preference links. */
export function trackLinks(html: string, wrap: (url: string) => string, skip: string[]): string {
  return rewriteAnchors(html, (url) => {
    if (!HTTP_URL.test(url)) return null;
    const decoded = url.replace(/&amp;/g, '&');
    if (skip.some((s) => decoded.startsWith(s))) return null;
    return wrap(decoded).replace(/&/g, '&amp;');
  });
}

export interface Utm {
  source: string;
  medium: string;
  campaign?: string;
  /** Only tag links to these hosts (and their subdomains); default: every link. */
  domains?: string[];
}

/**
 * One URL's UTM tags, shared by the HTML and text parts so both agree. Returns null when the
 * link is the platform's own, points elsewhere than `domains`, already carries utm_ parameters
 * or is not a URL (e.g. still holds a Liquid placeholder).
 */
function taggedUrl(raw: string, utm: Utm, skip: string[]): string | null {
  if (skip.some((s) => raw.startsWith(s)) || raw.includes('{{')) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (utm.domains?.length && !utm.domains.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`))) return null;
  if ([...u.searchParams.keys()].some((k) => k.startsWith('utm_'))) return null;
  u.searchParams.set('utm_source', utm.source);
  u.searchParams.set('utm_medium', utm.medium);
  if (utm.campaign) u.searchParams.set('utm_campaign', utm.campaign);
  return u.toString();
}

/**
 * Adds utm_source, utm_medium and utm_campaign to links in the e-mail so the site's analytics
 * (Umami, Matomo…) attributes the visits. Links that already have utm_ parameters, and the
 * platform's own links (unsubscribe, confirmation), are left alone.
 */
export function tagLinks(html: string, utm: Utm, skip: string[]): string {
  return rewriteAnchors(html, (url) => {
    if (!HTTP_URL.test(url)) return null;
    const tagged = taggedUrl(url.replace(/&amp;/g, '&'), utm, skip);
    return tagged === null ? null : tagged.replace(/&/g, '&amp;');
  });
}

/** Sentence punctuation and an unmatched closing bracket after a bare URL are not part of it. */
function trimUrlTail(raw: string): { url: string; tail: string } {
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1];
    if ('.,;:!?'.includes(ch)) {
      end--;
      continue;
    }
    if (ch === ')') {
      const before = raw.slice(0, end);
      const opens = before.split('(').length - 1;
      const closes = before.split(')').length - 1;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return { url: raw.slice(0, end), tail: raw.slice(end) };
}

/**
 * The plain-text sibling of `tagLinks`. It handles bare URLs and the `[https://…]` links that
 * html-to-text produces, and keeps trailing punctuation outside the tagged URL.
 */
export function tagTextLinks(text: string, utm: Utm, skip: string[]): string {
  return text.replace(/https?:\/\/[^\s<>"'`\]]+/gi, (raw: string) => {
    const { url, tail } = trimUrlTail(raw);
    const tagged = taggedUrl(url, utm, skip);
    return tagged === null ? raw : `${tagged}${tail}`;
  });
}
