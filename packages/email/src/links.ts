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
