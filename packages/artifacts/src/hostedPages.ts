import type { Brand, BrandCopy, BrandOverride } from './types';

// The pages a subscriber sees on the links host (#37): double opt-in confirm, its result, the
// expired link, unsubscribe and its result. They are plain HTML with inline CSS (no scripts), so
// the same module renders them for the public routes and for the admin preview. Every interpolated
// value is escaped: brand content comes from artifacts, which agents may draft.

export const HOSTED_PAGE_KINDS = ['confirm', 'confirmed', 'expired', 'unsubscribe', 'unsubscribed'] as const;
export type HostedPageKind = (typeof HOSTED_PAGE_KINDS)[number];

export const DEFAULT_BRAND_COLORS = {
  background: '#ffffff',
  surface: '#f6f7f9',
  text: '#111827',
  muted: '#4b5563',
  accent: '#1d4ed8',
  accentText: '#ffffff',
  border: '#d1d5db',
} as const;
export type BrandColor = keyof typeof DEFAULT_BRAND_COLORS;

export const DEFAULT_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

export const DEFAULT_BRAND_COPY = {
  confirmTitle: 'Confirm your subscription',
  confirmBody: 'One click and you are in.',
  confirmButton: 'Yes, subscribe me',
  confirmedTitle: 'You are subscribed',
  confirmedBody: 'Your subscription is confirmed.',
  expiredTitle: 'Link expired',
  expiredBody: 'This link has expired. Please sign up again; we will send you a new link.',
  unsubscribeTitle: 'Unsubscribe',
  unsubscribeBody: 'You will no longer receive these e-mails.',
  unsubscribeButton: 'Unsubscribe',
  unsubscribedTitle: 'Unsubscribed',
  unsubscribedBody: 'You are unsubscribed. It can take a moment before running campaigns notice.',
  backToSite: 'Back to {site}',
} as const;
export type ResolvedCopy = { -readonly [K in keyof typeof DEFAULT_BRAND_COPY]: string };

function mergeCopy(...sources: (Partial<BrandCopy> | null | undefined)[]): ResolvedCopy {
  const copy: ResolvedCopy = { ...DEFAULT_BRAND_COPY };
  for (const source of sources) {
    if (!source) continue;
    for (const key of Object.keys(DEFAULT_BRAND_COPY) as (keyof ResolvedCopy)[]) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) copy[key] = value;
    }
  }
  return copy;
}

/** A brand with every value resolved, ready to render. */
export interface ResolvedBrand {
  siteName: string | null;
  siteUrl: string | null;
  logoUrl: string | null;
  logoAlt: string | null;
  logoHeight: number;
  colors: Record<BrandColor, string>;
  fontStack: string;
  radius: number;
  language: string;
  copy: ResolvedCopy;
}

export interface HostedPageContext {
  /** Where "Back to …" points when the brand has no siteUrl (the form's origin on expired pages). */
  fallbackSiteUrl?: string | null;
  /** Admin preview: primary buttons are disabled, so nothing can be submitted. */
  preview?: boolean;
  /** Copy overrides for one rendering (e.g. "this signup is no longer available"). */
  copy?: Partial<BrandCopy>;
}

/** Merges a published brand and an optional form override, filling safe defaults. */
export function resolveBrand(brand?: Brand | null, override?: BrandOverride | null): ResolvedBrand {
  const colors: Record<BrandColor, string> = { ...DEFAULT_BRAND_COLORS };
  for (const source of [brand?.colors, override?.colors]) {
    if (!source) continue;
    for (const key of Object.keys(DEFAULT_BRAND_COLORS) as BrandColor[]) {
      const value = source[key];
      if (typeof value === 'string') colors[key] = value;
    }
  }
  return {
    siteName: override?.siteName ?? brand?.siteName ?? null,
    siteUrl: override?.siteUrl ?? brand?.siteUrl ?? null,
    logoUrl: override?.logoUrl ?? brand?.logoUrl ?? null,
    logoAlt: override?.logoAlt ?? brand?.logoAlt ?? null,
    logoHeight: override?.logoHeight ?? brand?.logoHeight ?? 32,
    colors,
    fontStack: override?.fontStack ?? brand?.fontStack ?? DEFAULT_FONT_STACK,
    radius: override?.radius ?? brand?.radius ?? 8,
    language: override?.language ?? brand?.language ?? 'en',
    copy: mergeCopy(brand?.copy, override?.copy),
  };
}

/** The first allowed origin, else the origin of an absolute success URL (issue #37's fallback). */
export function originOfUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

function siteLabel(brand: ResolvedBrand, siteUrl: string | null): string {
  if (brand.siteName?.trim()) return brand.siteName.trim();
  if (siteUrl) {
    try {
      return new URL(siteUrl).hostname.replace(/^www\./, '');
    } catch {
      // not a URL; fall through
    }
  }
  return 'the site';
}

/**
 * Strict headers for every hosted page: no scripts, no framing, no caching, no referrer leak.
 * `form-action` also governs the redirects that follow a form submission (CSP3, enforced by
 * Chromium), so a page whose POST answers with a redirect to another site must list that site's
 * origin (#115). Pass only origins from `originOfUrl`; anything else is dropped.
 */
export function hostedPageHeaders(redirectOrigins: (string | null | undefined)[] = []) {
  const extra = [...new Set(redirectOrigins.filter((o): o is string => !!o && originOfUrl(o) === o))];
  return {
    'content-security-policy': `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; form-action ${["'self'", ...extra].join(' ')}; frame-ancestors 'none'; base-uri 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
}

/** The headers for pages whose forms post back to the links host and are answered in place. */
export const HOSTED_PAGE_HEADERS = hostedPageHeaders();

const BUTTON_PAGES: ReadonlySet<HostedPageKind> = new Set(['confirm', 'unsubscribe']);
const BACK_LINK_PAGES: ReadonlySet<HostedPageKind> = new Set(['expired', 'confirmed', 'unsubscribe', 'unsubscribed']);

/**
 * A complete hosted page as one HTML document. `kind` picks the copy and the primary action;
 * confirm and unsubscribe render a POST form, the other pages a back link when a site is known.
 */
export function renderHostedPage(kind: HostedPageKind, brand: ResolvedBrand, ctx: HostedPageContext = {}): string {
  const copy: ResolvedCopy = mergeCopy(brand.copy, ctx.copy);
  const siteUrl = brand.siteUrl ?? ctx.fallbackSiteUrl ?? null;
  const site = siteLabel(brand, siteUrl);
  const text = (value: string) => escapeHtml(value.replaceAll('{site}', site));

  const pages: Record<HostedPageKind, { title: string; body: string; button?: string }> = {
    confirm: { title: copy.confirmTitle, body: copy.confirmBody, button: copy.confirmButton },
    confirmed: { title: copy.confirmedTitle, body: copy.confirmedBody },
    expired: { title: copy.expiredTitle, body: copy.expiredBody },
    unsubscribe: { title: copy.unsubscribeTitle, body: copy.unsubscribeBody, button: copy.unsubscribeButton },
    unsubscribed: { title: copy.unsubscribedTitle, body: copy.unsubscribedBody },
  };
  const page = pages[kind];

  const colors = Object.entries(brand.colors)
    .map(([name, value]) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(';');
  const logo = brand.logoUrl
    ? `<img class="logo" src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.logoAlt ?? brand.siteName ?? '')}" height="${brand.logoHeight}" style="height:${brand.logoHeight}px">`
    : '';
  const header =
    logo || brand.siteName
      ? `<header class="brand">${logo}${brand.siteName ? `<p class="site-name">${escapeHtml(brand.siteName)}</p>` : ''}</header>`
      : '';

  const action = BUTTON_PAGES.has(kind)
    ? `<form method="post"><button type="submit"${ctx.preview ? ' disabled aria-disabled="true"' : ''}>${text(page.button ?? '')}</button></form>`
    : '';
  const back =
    BACK_LINK_PAGES.has(kind) && siteUrl ? `<p class="back"><a href="${escapeHtml(siteUrl)}">${text(copy.backToSite)}</a></p>` : '';

  return `<!doctype html>
<html lang="${escapeHtml(brand.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${text(page.title)}</title>
<style>
:root{color-scheme:light;${colors};--radius:${brand.radius}px}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;padding:24px 12px;background:var(--background);color:var(--text);font-family:${brand.fontStack};font-size:16px;line-height:1.5}
main{max-width:32rem;margin:0 auto}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:clamp(20px,6vw,32px)}
.brand{margin:0 0 1.25rem}
.logo{display:block;max-width:100%;width:auto;margin:0 0 .75rem}
.site-name{margin:0;font-size:.95rem;font-weight:600;color:var(--muted);overflow-wrap:anywhere}
h1{margin:0 0 .5rem;font-size:clamp(1.35rem,4.5vw,1.6rem);line-height:1.25;overflow-wrap:anywhere}
p{margin:0 0 1.25rem;color:var(--muted);white-space:pre-line;overflow-wrap:anywhere}
button{font:inherit;font-weight:600;min-height:44px;padding:.65rem 1.25rem;border:1px solid var(--accent);border-radius:var(--radius);background:var(--accent);color:var(--accentText);cursor:pointer}
button:hover{filter:brightness(.94)}
button:focus-visible{outline:3px solid var(--text);outline-offset:3px}
button[disabled]{cursor:not-allowed}
.back{margin:1.5rem 0 0;font-size:.95rem}
a{color:var(--accent);text-underline-offset:.15em}
a:focus-visible{outline:3px solid var(--text);outline-offset:3px;border-radius:2px}
@media (max-width:400px){body{padding:16px 10px}.card{padding:20px 16px}}
</style>
</head>
<body><main class="card">${header}<h1>${text(page.title)}</h1><p>${text(page.body)}</p>${action}${back}</main></body>
</html>`;
}
