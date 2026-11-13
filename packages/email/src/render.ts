/// <reference path="./mjml.d.ts" />
import type { EmailBlockParam, EmailTemplate } from '@agentic-marketing/artifacts';
import { AppError } from '@agentic-marketing/core';
import { convert } from 'html-to-text';
import { type Context, Hash, Liquid, LiquidError, RenderError, Tag, type TagToken, type TopLevelToken, toPromise } from 'liquidjs';
import mjml2html from 'mjml';
import { isAllowedBlockUrl, parseBlockTagArgs } from './blockTags';
import { unsubscribeLinkProblem, unsubscribeProblemMessage } from './unsubscribe';

// Rendering (ADR-0006): Liquid first, then MJML → HTML, then a text part. Liquid runs sandboxed:
// no file system, no includes, bounded time and output, and every value is HTML-escaped unless
// the template says `| raw`. MJML includes are disabled for the same reason.

/** An `html` block parameter: inserted as-is, unlike every other value. */
class RawHtml {
  constructor(readonly value: string) {}
}

/**
 * An expected render failure (#885): the template, a block or the data passed to them is wrong, so
 * the person who wrote it is the one who can fix it. Anything else a render can throw (a database
 * error from the block resolver, a bug) is not this, propagates, and the executor answers it as the
 * sanitised internal failure rather than echoing its text.
 */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** The first line of a message: library errors append a stack or an excerpt after it. */
export const firstLine = (message: string) => message.split('\n')[0];

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeOutput(value: unknown): string {
  if (value instanceof RawHtml) return value.value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(escapeOutput).join('');
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** A block as the renderer needs it: the published fragment and its parameter schema. */
export interface BlockDefinition {
  id: string;
  mjml: string;
  params: EmailBlockParam[];
}
export type BlockResolver = (id: string) => Promise<BlockDefinition | null> | BlockDefinition | null;
export interface RenderOptions {
  /** Where {% block … %} looks up published blocks; without it the tag is a render error. */
  blocks?: BlockResolver;
}

// Scope keys that must stay invisible to templates, so a block cannot reach the resolver or
// call itself through one.
const BLOCK_RESOLVER = Symbol('blockResolver');
const IN_BLOCK = Symbol('inBlock');

const engine = new Liquid({
  outputEscape: escapeOutput,
  strictFilters: true,
  // Includes and layouts would read files; there are none to read.
  fs: {
    readFileSync: () => {
      throw new TemplateError('includes are not available in templates');
    },
    readFile: async () => {
      throw new TemplateError('includes are not available in templates');
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

/**
 * Values pass the block's type checks before Liquid sees them: required ones must be there, URL
 * and image parameters must be http(s) or asset links, and html is marked for raw insertion.
 */
function blockScope(block: BlockDefinition, passed: Record<string, unknown>): Record<string, string | RawHtml> {
  const declared = new Map(block.params.map((p) => [p.key, p]));
  for (const key of Object.keys(passed))
    if (!declared.has(key))
      throw new TemplateError(
        `Block ${block.id} has no parameter "${key}". It accepts ${[...declared.keys()].join(', ') || 'no parameters'}.`,
      );
  const out: Record<string, string | RawHtml> = {};
  for (const p of block.params) {
    const raw = passed[p.key] ?? p.default;
    if (raw === undefined || raw === null || raw === '') {
      if (p.required) throw new TemplateError(`Block ${block.id} needs the parameter "${p.key}"${p.label ? ` (${p.label})` : ''}.`);
      out[p.key] = p.type === 'html' ? new RawHtml('') : '';
      continue;
    }
    const value = String(raw);
    if (p.maxLength && value.length > p.maxLength)
      throw new TemplateError(`Block ${block.id}: "${p.key}" is longer than ${p.maxLength} characters.`);
    if ((p.type === 'url' || p.type === 'image') && !isAllowedBlockUrl(value))
      throw new TemplateError(`Block ${block.id}: "${p.key}" must be an http(s) or asset URL, not "${value.slice(0, 80)}".`);
    out[p.key] = p.type === 'html' ? new RawHtml(value) : value;
  }
  return out;
}

/** `{% block 'blk_…', title: 'This week' %}` inlines the block's published MJML at render time. */
class BlockTag extends Tag {
  private readonly id: string;
  private readonly hash: Hash | null;
  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid);
    const parsed = parseBlockTagArgs(token.args);
    this.id = parsed.id;
    this.hash = parsed.params ? new Hash(parsed.params) : null;
  }
  render(ctx: Context) {
    return (async () => {
      const env = ctx.environments as Record<PropertyKey, unknown>;
      if (env[IN_BLOCK]) throw new TemplateError('Blocks cannot use other blocks in v1.');
      const resolve = env[BLOCK_RESOLVER] as BlockResolver | undefined;
      if (!resolve) throw new TemplateError(`Block ${this.id} cannot be rendered here: blocks are not available.`);
      const block = await resolve(this.id);
      if (!block)
        throw new TemplateError(`Block ${this.id} is not published or does not exist. Publish it before the templates that use it.`);
      const passed = this.hash ? ((await toPromise(this.hash.render(ctx))) as Record<string, unknown>) : {};
      const scope = { ...ctx.environments, block: blockScope(block, passed), [IN_BLOCK]: true };
      return await engine.parseAndRender(block.mjml, scope);
    })();
  }
}
engine.registerTag('block', BlockTag);

/** The MJML of a block with its params and normal variables resolved; used by blocks.preview. */
export async function renderBlockFragment(block: BlockDefinition, params: Record<string, unknown>, vars: RenderVars = {}): Promise<string> {
  const scope = { ...vars, block: blockScope(block, params), [IN_BLOCK]: true };
  return (await engine.parseAndRender(block.mjml, scope)) as string;
}

/**
 * MJML → HTML with our asset URL fix; shared by templates and block previews. Async since mjml 5,
 * which validates and renders in a promise.
 */
export async function compileMjml(mjml: string): Promise<{ html: string; warnings: string[] }> {
  let out: Awaited<ReturnType<typeof mjml2html>>;
  try {
    out = await mjml2html(mjml, { validationLevel: 'soft', ignoreIncludes: true, minify: false });
  } catch (e) {
    // MJML compiling is pure: it has no I/O, so a failure is the document's own (a malformed tag
    // or nesting), not the platform's (#885).
    throw new TemplateError(firstLine((e as Error).message));
  }
  return { html: pngRenditionUrls(out.html), warnings: out.errors.map((e) => `mjml line ${e.line}: ${e.message}`) };
}

/**
 * The expected cause inside a Liquid error chain: Liquid's own parse complaint, a render complaint
 * it raised itself, or our TemplateError for a block's parameters. Liquid wraps whatever a tag
 * throws, so the chain is followed: a block resolver's database error is wrapped just the same and
 * is *not* expected (#885).
 */
function expectedCause(err: unknown, depth = 0): Error | null {
  if (depth > 6) return null;
  if (err instanceof TemplateError) return err;
  if (err instanceof LiquidError) {
    // Liquid's aggregate of several render errors: expected only if every one of them is.
    const many = (err as { errors?: unknown }).errors;
    if (Array.isArray(many) && many.length) {
      const causes = many.map((inner) => expectedCause(inner, depth + 1));
      return causes.every((cause) => cause) ? (causes[0] ?? null) : null;
    }
    if (err instanceof RenderError) {
      // RenderError wraps whatever the template threw. No cause of its own means Liquid raised it
      // (an undefined filter, a bad operand), which is the template's; with a cause, judge the cause.
      const inner = (err as { originalError?: unknown }).originalError;
      return inner ? expectedCause(inner, depth + 1) : err;
    }
    // TokenizationError, ParseError, UndefinedVariableError: the template's syntax, not the platform.
    return err;
  }
  return null;
}

/**
 * The AppError an expected render failure deserves, or null when the failure is not the content's
 * fault (#885). Only a Liquid syntax/render error or a TemplateError qualifies, so the caller can
 * rethrow anything else (a database error from the block resolver, a bug) for the executor to
 * answer and audit as the sanitised internal failure.
 */
export function templateRenderError(err: unknown, prefix: string): AppError | null {
  const cause = expectedCause(err);
  if (!cause) return null;
  return new AppError('invalid_input', `${prefix}: ${firstLine(cause.message)}`);
}

export interface RenderVars {
  profile?: Record<string, unknown>;
  event?: Record<string, unknown>;
  unsubscribe_url?: string;
  preferences_url?: string;
  /** Signed "view in browser" link; a harmless placeholder in previews. */
  web_url?: string;
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
const PLACEHOLDER_WEB = 'https://example.invalid/web';

/**
 * The unsubscribe URL a render with `vars` uses. The same value must be found as an `<a href>` in
 * the rendered HTML, both at save and at publish (#637).
 */
export function unsubscribeUrlFor(vars: RenderVars): string {
  const value = vars.unsubscribe_url;
  return value === undefined || value === null || value === '' ? PLACEHOLDER_UNSUBSCRIBE : String(value);
}

/**
 * True when the source inlines a reusable `{% block … %}`. Such a template can only be rendered
 * with a block resolver, which a content validator does not have; the publish gate resolves the
 * block and decides compliance from the real footer.
 */
function usesBlockTag(src: string): boolean {
  let i = 0;
  for (;;) {
    const open = src.indexOf('{%', i);
    if (open < 0) return false;
    let j = open + 2;
    if (src[j] === '-') j++;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j++;
    if (src.startsWith('block', j)) {
      const after = src[j + 5];
      if (after === undefined || !/[A-Za-z0-9_]/.test(after)) return true;
    }
    i = open + 2;
  }
}

/**
 * E-mail clients rarely render SVG. Our assets answer `/a/<id>/<file>.png` with the PNG rendition,
 * so point an asset URL in an e-mail at that path. Only our asset ids match; other URLs stay.
 */
export function pngRenditionUrls(value: string): string {
  return value.replace(/(\/a\/ast_[0-9a-f]{32}\/[A-Za-z0-9._-]+)\.svg\b/gi, '$1.png');
}

/** Problems that make a template unusable, for saving: Liquid that does not parse, MJML that does not compile. */
/**
 * The text without Liquid tags (`{% … %}`), in one linear scan: a lazy regex over user MJML
 * backtracks badly on input with many unclosed `{%` (CodeQL js/polynomial-redos).
 */
export function stripLiquidTags(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{%', i);
    if (open < 0) break;
    const close = src.indexOf('%}', open + 2);
    if (close < 0) break;
    out += src.slice(i, open);
    i = close + 2;
  }
  return out + src.slice(i);
}

export async function validateTemplate(t: EmailTemplate): Promise<string[]> {
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
      const r = await mjml2html(stripLiquidTags(t.mjml), {
        validationLevel: 'soft',
        ignoreIncludes: true,
        keepComments: false,
      });
      for (const e of r.errors.slice(0, 10)) problems.push(`mjml line ${e.line}: ${e.message}`);
    } catch (e) {
      problems.push(`mjml: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (t.purpose !== 'onboarding' && t.purpose !== 'necessary') {
    // Decide from the rendered e-mail, not the source: a footer supplied by a block is a real
    // link (#637), and the characters "unsubscribe_url" in prose are not.
    const vars = (t.sampleData ?? {}) as RenderVars;
    let rendered: Rendered | null = null;
    try {
      rendered = await renderTemplate(t, vars);
    } catch {
      // Liquid or MJML that does not render is reported above (or by the publish gate). A block
      // footer is the expected failure here: only the publish gate can resolve it.
    }
    if (rendered) {
      const problem = unsubscribeLinkProblem(rendered.html, unsubscribeUrlFor(vars));
      if (problem) problems.push(unsubscribeProblemMessage(problem));
    } else if (!usesBlockTag(t.mjml) && !/unsubscribe_url/.test(t.mjml)) {
      problems.push(unsubscribeProblemMessage('missing'));
    }
  }
  return problems;
}

/** Parse a subject on its own, for a broadcast subject test (the same Liquid rules as the template). */
export function validateSubject(subject: string): string | null {
  try {
    engine.parse(subject);
    return null;
  } catch (e) {
    return `Liquid error: ${(e as Error).message.split('\n')[0]}`;
  }
}

/** Render a subject override with the same sandbox and scope as the template's own subject. */
export async function renderSubject(subject: string, vars: RenderVars): Promise<string> {
  const scope = { unsubscribe_url: PLACEHOLDER_UNSUBSCRIBE, preferences_url: PLACEHOLDER_UNSUBSCRIBE, web_url: PLACEHOLDER_WEB, ...vars };
  return (await engine.parseAndRender(subject, scope)).replace(/\s+/g, ' ').trim();
}

export async function renderTemplate(t: EmailTemplate, vars: RenderVars, options: RenderOptions = {}): Promise<Rendered> {
  const scope = {
    unsubscribe_url: PLACEHOLDER_UNSUBSCRIBE,
    preferences_url: PLACEHOLDER_UNSUBSCRIBE,
    web_url: PLACEHOLDER_WEB,
    ...vars,
    ...(options.blocks ? { [BLOCK_RESOLVER]: options.blocks } : {}),
  };
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
  const out = await compileMjml(withPreview);
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
    html: out.html,
    text: pngRenditionUrls(text).trim(),
    warnings: out.warnings,
  };
}
