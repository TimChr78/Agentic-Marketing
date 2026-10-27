import {
  artifactTypes,
  type Brand,
  escapeHtml,
  publishedSingleton,
  publishValidators,
  type ResolvedBrand,
  resolveBrand,
} from '@agentic-marketing/artifacts';
import { defineCommand } from '@agentic-marketing/commands';
import { type Db, schema, type Tx } from '@agentic-marketing/db';
import { renderTemplate, type UnsubscribeLink, type WebLink } from '@agentic-marketing/email';
import { profileForMessage } from '@agentic-marketing/profiles';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

// The public newsletter archive and the per-recipient web version (#100), served on the links
// host next to the hosted pages. Everything here is public except /n/w/<token>, which is signed
// per message and shows that one recipient their own e-mail. Archive issues are re-rendered from
// the template version that was sent with empty personalisation, never from a person's message.

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

export async function archiveForSlug(db: Db, slug: string) {
  const hit = (await publishedBrands(db)).find((b) => b.brand.archive.enabled && b.brand.archive.slug === slug);
  return hit ?? null;
}

/** A URL-safe issue slug: "Signal #42: attribution is…" → "signal-42-attribution-is". */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'issue'
  );
}

const day = (date: Date) => date.toISOString().slice(0, 10);
const plain = (value: string) =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Values for an archived issue: the template's sample data, but never a real profile. */
function archiveVars(t: { sampleData?: Record<string, unknown> }) {
  return {
    ...(t.sampleData ?? {}),
    profile: {},
    event: {},
    unsubscribe_url: '#',
    preferences_url: '#',
    web_url: '#',
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

/** Splits MJML's complete document into the parts that can sit inside our page. */
export function emailParts(html: string): { body: string; styles: string } {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  // The strict CSP already blocks scripts; remove them and event handlers as defence in depth.
  // A 1×1 image is an open-tracking pixel (some templates and relays add one); the web page is
  // not a send, so it is dropped rather than counted.
  const pixel =
    /<img\b[^>]*(?:(?:width\s*=\s*["']?1(?:px)?["']?[\s\S]*?height\s*=\s*["']?1(?:px)?["']?)|(?:height\s*=\s*["']?1(?:px)?["']?[\s\S]*?width\s*=\s*["']?1(?:px)?["']?))[^>]*>/gi;
  return {
    body: body
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(pixel, ''),
    styles,
  };
}

const brandStyles = (brand: ResolvedBrand) => {
  const colors = Object.entries(brand.colors)
    .map(([name, value]) => `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`)
    .join(';');
  return `:root{color-scheme:light;${colors};--radius:${brand.radius}px}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;padding:24px 12px;background:var(--background);color:var(--text);font-family:${brand.fontStack};font-size:16px;line-height:1.55}
main{max-width:46rem;margin:0 auto}
a{color:var(--accent);text-underline-offset:.15em}
a:focus-visible{outline:3px solid var(--text);outline-offset:3px;border-radius:2px}
.brand{display:flex;align-items:center;gap:.75rem;margin:0 0 1.5rem;flex-wrap:wrap}
.logo{display:block;max-width:100%;width:auto}
.site-name{margin:0;font-size:1rem;font-weight:600;color:var(--text)}
h1{margin:0 0 .5rem;font-size:clamp(1.5rem,4.5vw,2rem);line-height:1.2;overflow-wrap:anywhere}
h2{margin:0;font-size:1.1rem;line-height:1.3}
p{margin:0 0 1rem;color:var(--muted);overflow-wrap:anywhere}
.meta{margin:0 0 1.5rem;font-size:.85rem;color:var(--muted)}
.lead{font-size:1.05rem}
.issues{list-style:none;margin:0;padding:0}
.issues li{padding:1.25rem 0;border-top:1px solid var(--border)}
.issues li:first-child{border-top:0;padding-top:0}
.issues h2 a{color:var(--text);text-decoration:none}
.issues h2 a:hover{color:var(--accent);text-decoration:underline}
.issue .email-body{margin:1.5rem 0;overflow-x:auto}
.email-body img{max-width:100%;height:auto}
.email-body table{max-width:100%}
.subscribe{margin:2rem 0 0;padding:1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius)}
.button{display:inline-block;padding:.65rem 1.25rem;border-radius:var(--radius);background:var(--accent);color:var(--accent-text);font-weight:600;text-decoration:none}
footer{margin:2rem 0 0;font-size:.85rem;color:var(--muted)}
.pager{display:flex;gap:1rem;margin:2rem 0 0;font-size:.9rem}
@media (max-width:400px){body{padding:16px 10px}}`;
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
<body><main>${header}${input.body}${footer}</main></body>
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
    ${issue.summary ? `<p>${escapeHtml(issue.summary)}</p>` : ''}
  </article>
</li>`,
        )
        .join('')}</ul>`
    : '<p>No issues have been published yet.</p>';
  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Archive pages">
${current > 1 ? `<a href="${escapeHtml(`${base}/?page=${current - 1}`)}">← Newer</a>` : '<span></span>'}
<span>Page ${current} of ${pages}</span>
${current < pages ? `<a href="${escapeHtml(`${base}/?page=${current + 1}`)}">Older →</a>` : '<span></span>'}
</nav>`
      : '';
  const subscribe = settings.subscribeUrl
    ? `<p class="subscribe"><a class="button" href="${escapeHtml(settings.subscribeUrl)}">Subscribe</a></p>`
    : '';
  return shell({
    brand,
    title,
    description: metaDescription(description, title),
    canonical,
    body: `<h1>${escapeHtml(title)}</h1>${description ? `<p class="lead">${escapeHtml(description)}</p>` : ''}${list}${pager}${subscribe}`,
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
    ? `<p class="subscribe"><a class="button" href="${escapeHtml(settings.subscribeUrl)}">Subscribe</a></p>`
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
<header>
<p class="meta">${escapeHtml(archiveTitle(brand, brandContent))}</p>
<h1>${escapeHtml(issue.subject)}</h1>
<p class="meta"><time datetime="${escapeHtml(dateTime(issue.sentAt))}">${escapeHtml(dateLabel(issue.sentAt, brand))}</time></p>
</header>
<div class="email-body">${body}</div>
</article>
<p><a href="${escapeHtml(`${base}/`)}">← All issues</a></p>${subscribe}`,
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
<header>
<p class="meta">Web version</p>
<h1>${escapeHtml(subject)}</h1>
</header>
<div class="email-body">${body}</div>
</article>
${archiveUrl ? `<p><a href="${escapeHtml(archiveUrl)}">Read the archive</a></p>` : ''}`,
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
  const app = new Hono();
  const notFound = (c: Context) => c.text('Not found.', 404);

  const load = async (slug: string) => {
    const hit = await archiveForSlug(deps.db, slug);
    if (!hit) return null;
    const issues = await deps.db.withWorkspace(hit.workspaceId, (tx) => listArchiveIssues(tx, hit.brand, deps.linksUrl));
    return { ...hit, issues, settings: settingsView(hit.brand, deps.linksUrl) };
  };

  app.get('/n/:slug/feed.xml', async (c) => {
    const archive = await load(c.req.param('slug'));
    if (!archive) return notFound(c);
    const base = `${deps.linksUrl}/n/${archive.settings.slug ?? ''}`;
    return c.body(renderFeed(archive.brand, resolveBrand(archive.brand), archive.settings, archive.issues, base), 200, {
      'content-type': 'application/rss+xml; charset=utf-8',
      ...archiveHeaders(PUBLIC_CACHE),
    });
  });

  app.get('/n/:slug/sitemap.xml', async (c) => {
    const archive = await load(c.req.param('slug'));
    if (!archive) return notFound(c);
    const base = `${deps.linksUrl}/n/${archive.settings.slug ?? ''}`;
    return c.body(renderSitemap(archive.issues, base), 200, {
      'content-type': 'application/xml; charset=utf-8',
      ...archiveHeaders(PUBLIC_CACHE),
    });
  });

  app.get('/n/:slug', async (c) => {
    const archive = await archiveForSlug(deps.db, c.req.param('slug'));
    if (!archive) return notFound(c);
    return c.redirect(`${deps.linksUrl}/n/${archive.brand.archive.slug ?? ''}/`, 301);
  });

  app.get('/n/:slug/', async (c) => {
    const archive = await load(c.req.param('slug'));
    if (!archive) return notFound(c);
    const base = `${deps.linksUrl}/n/${archive.settings.slug ?? ''}`;
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const html = renderArchiveIndex(archive.brand, resolveBrand(archive.brand), archive.settings, archive.issues, base, page);
    return c.html(html, 200, archiveHeaders(PUBLIC_CACHE));
  });

  app.get('/n/:slug/:issue', async (c) => {
    const slug = c.req.param('slug');
    const issueSlug = c.req.param('issue');
    // /n/w/<token> is the signed web version. A workspace archive slug "w" is rejected on publish.
    if (slug === 'w') return webVersion(c, issueSlug);
    const archive = await load(slug);
    if (!archive) return notFound(c);
    const issue = archive.issues.find((i) => i.slug === issueSlug);
    if (!issue) return notFound(c);
    return issuePage(c, archive, issue);
  });

  /** Renders one sent message as its recipient saw it, with live unsubscribe/preferences links. */
  async function webVersion(c: Context, token: string) {
    const link = deps.links.verify<WebLink>(token);
    if (!link || typeof link.w !== 'string' || typeof link.m !== 'string') return notFound(c);
    if (link.x !== undefined && link.x < Date.now()) return c.text('This link has expired.', 410);
    const page = await deps.db.withWorkspace(link.w, async (tx) => {
      const [message] = await tx.select().from(schema.messages).where(eq(schema.messages.id, link.m));
      if (!message) return null;
      if (message.channel !== 'email' || !message.templateId || !message.templateVersion) return null;
      const template = artifactTypes.email_template.content.safeParse(
        await versionContent(tx, message.templateId, message.templateVersion),
      );
      if (!template.success) return null;
      const profile = message.profileId ? await profileForMessage(tx, link.w, message.profileId, deps.kp) : null;
      const unsubscribe = `${deps.linksUrl}/u/${deps.links.sign({
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
          web_url: `${deps.linksUrl}/n/w/${token}`,
        });
      } catch {
        return null;
      }
      const brand = await publishedSingleton(tx, 'brand');
      let archive: string | null = null;
      if (brand?.archive.enabled && message.journeyId) {
        archive = (await listArchiveIssues(tx, brand, deps.linksUrl)).find((i) => i.artifactId === message.journeyId)?.url ?? null;
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
    const base = `${deps.linksUrl}/n/${archive.settings.slug ?? ''}`;
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
    const linksUrl = ctx.services.linksUrl ?? ctx.services.publicUrl ?? '';
    return {
      settings: settingsView(brand, linksUrl),
      issues: brand ? await listArchiveIssues(ctx.tx, brand, linksUrl) : [],
    };
  },
});

export const archiveCommands = [listArchiveIssuesCommand] as const;
