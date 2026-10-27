import { createHmac, timingSafeEqual } from 'node:crypto';

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

/** Rewrites http(s) links for click tracking, except the unsubscribe and preference links. */
export function trackLinks(html: string, wrap: (url: string) => string, skip: string[]): string {
  return html.replace(/(<a\b[^>]*?\bhref=")(https?:\/\/[^"]+)(")/gi, (all, pre: string, url: string, post: string) => {
    const decoded = url.replace(/&amp;/g, '&');
    if (skip.some((s) => decoded.startsWith(s))) return all;
    return `${pre}${wrap(decoded).replace(/&/g, '&amp;')}${post}`;
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
  return html.replace(/(<a\b[^>]*?\bhref=")(https?:\/\/[^"]+)(")/gi, (all, pre: string, url: string, post: string) => {
    const tagged = taggedUrl(url.replace(/&amp;/g, '&'), utm, skip);
    if (tagged === null) return all;
    return `${pre}${tagged.replace(/&/g, '&amp;')}${post}`;
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
