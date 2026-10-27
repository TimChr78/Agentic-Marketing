/// <reference path="./mjml.d.ts" />
import type { EmailTemplate } from '@agentic-marketing/artifacts';
import { convert } from 'html-to-text';
import { Liquid } from 'liquidjs';
import mjml2html from 'mjml';

// Rendering (ADR-0006): Liquid first, then MJML → HTML, then a text part. Liquid runs sandboxed:
// no file system, no includes, bounded time and output, and every value is HTML-escaped unless
// the template says `| raw`. MJML includes are disabled for the same reason.

const engine = new Liquid({
  outputEscape: 'escape',
  strictFilters: true,
  // Includes and layouts would read files; there are none to read.
  fs: {
    readFileSync: () => {
      throw new Error('includes are not available in templates');
    },
    readFile: async () => {
      throw new Error('includes are not available in templates');
    },
    existsSync: () => false,
    exists: async () => false,
    resolve: (_root: string, file: string) => file,
  },
  relativeReference: false,
  parseLimit: 300_000,
  renderLimit: 1_000,
  memoryLimit: 20_000_000,
});
// `raw` keeps a value unescaped, e.g. a URL that is already safe HTML.
engine.registerFilter('raw', (v: unknown) => v);

export interface RenderVars {
  profile?: Record<string, unknown>;
  event?: Record<string, unknown>;
  unsubscribe_url?: string;
  preferences_url?: string;
  topic_unsubscribe_url?: string;
  [k: string]: unknown;
}

export interface Rendered {
  subject: string;
  preheader?: string;
  html: string;
  text: string;
  warnings: string[];
}

const PLACEHOLDER_UNSUBSCRIBE = 'https://example.invalid/unsubscribe';

/**
 * E-mail clients rarely render SVG. Our assets answer `/a/<id>/<file>.png` with the PNG rendition,
 * so point an asset URL in an e-mail at that path. Only our asset ids match; other URLs stay.
 */
export function pngRenditionUrls(value: string): string {
  return value.replace(/(\/a\/ast_[0-9a-f]{32}\/[A-Za-z0-9._-]+)\.svg\b/gi, '$1.png');
}

/** Problems that make a template unusable, for saving: Liquid that does not parse, MJML that does not compile. */
export function validateTemplate(t: EmailTemplate): string[] {
  const problems: string[] = [];
  for (const [field, src] of [
    ['subject', t.subject],
    ['preheader', t.preheader],
    ['mjml', t.mjml],
    ['text', t.text],
  ] as const) {
    if (!src) continue;
    try {
      engine.parse(src);
    } catch (e) {
      problems.push(`${field}: Liquid error: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (!problems.length) {
    try {
      // Compile with Liquid stripped, so MJML structure errors surface independently of data.
      const r = mjml2html(t.mjml.replace(/\{%[\s\S]*?%\}/g, ''), { validationLevel: 'soft', ignoreIncludes: true, keepComments: false });
      for (const e of r.errors.slice(0, 10)) problems.push(`mjml line ${e.line}: ${e.message}`);
    } catch (e) {
      problems.push(`mjml: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (!/unsubscribe_url/.test(t.mjml) && t.purpose !== 'onboarding' && t.purpose !== 'necessary')
    problems.push('Marketing e-mails need an unsubscribe link: add {{ unsubscribe_url }} to the MJML');
  return problems;
}

export async function renderTemplate(t: EmailTemplate, vars: RenderVars): Promise<Rendered> {
  const scope = { unsubscribe_url: PLACEHOLDER_UNSUBSCRIBE, preferences_url: PLACEHOLDER_UNSUBSCRIBE, ...vars };
  const [subject, preheader, mjmlSrc] = await Promise.all([
    engine.parseAndRender(t.subject, scope),
    t.preheader ? engine.parseAndRender(t.preheader, scope) : undefined,
    engine.parseAndRender(t.mjml, scope),
  ]);
  // The preheader goes in as mj-preview unless the template has its own.
  const withPreview =
    preheader && !/<mj-preview/.test(mjmlSrc)
      ? mjmlSrc.replace(/<mj-head>|<mj-body/, (m: string) =>
          m === '<mj-head>' ? `${m}<mj-preview>${preheader}</mj-preview>` : `<mj-head><mj-preview>${preheader}</mj-preview></mj-head>${m}`,
        )
      : mjmlSrc;
  const out = mjml2html(withPreview, { validationLevel: 'soft', ignoreIncludes: true, minify: false });
  const text = t.text
    ? await engine.parseAndRender(t.text, scope)
    : convert(out.html, {
        wordwrap: 78,
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        ],
      });
  return {
    subject: subject.replace(/\s+/g, ' ').trim(),
    preheader: preheader?.trim() || undefined,
    // The brand logo and template images are assets too; SVG ones must travel as PNG.
    html: pngRenditionUrls(out.html),
    text: pngRenditionUrls(text).trim(),
    warnings: out.errors.map((e) => `mjml line ${e.line}: ${e.message}`),
  };
}
