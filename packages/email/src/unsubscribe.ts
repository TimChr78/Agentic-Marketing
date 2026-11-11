import { Parser } from 'htmlparser2';

// #637 (review, P2): the gate must find an unsubscribe link a reader can actually see and click.
// A link that exists only in the source — inline display:none, an ancestor style, a <template>, an
// empty anchor — is not an unsubscribe link. This predicate is shared by the save validator and
// the publish gate, so both give the same answer.

export type UnsubscribeLinkProblem = 'missing' | 'hidden' | 'empty';

/** Elements whose content is not rendered as visible body content in an e-mail. */
const NOT_BODY = new Set(['template', 'head', 'script', 'style', 'noscript']);

interface ElementInfo {
  name: string;
  attribs: Record<string, string>;
  classes: Set<string>;
  id: string | null;
  declarations: Map<string, string>;
}

interface Candidate {
  /** The link and every open ancestor at the moment it opened. */
  chain: ElementInfo[];
  /** Inside <template>, <head>, <script>, <style> or <noscript>. */
  outsideBody: boolean;
  /** Non-whitespace text directly or indirectly inside the link. */
  text: boolean;
  /** An <img> inside the link with a non-empty alt. */
  imageAlt: boolean;
}

/** A simple class/id selector whose rule hides its target. Complex selectors are not modelled. */
interface HideSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
}

interface HiddenRules {
  display: HideSelector[];
  visibility: HideSelector[];
}

/**
 * True when the rendered HTML has a usable unsubscribe link. `url` is the rendered
 * `unsubscribe_url`, the same value the send gateway puts in the visible link and in
 * `List-Unsubscribe` / `List-Unsubscribe-Post` for marketing mail.
 *
 * Returns null when a visible link exists, otherwise why not: `missing` (no link to that URL),
 * `hidden` (outside the body or hidden by a rule below) or `empty` (no text and no image alt).
 *
 * Hidden when the link or an ancestor has:
 * - `hidden` or `aria-hidden="true"`;
 * - inline `display:none`, `opacity:0`, or `mso-hide:all`;
 * - a zero max-height/height/width together with `overflow:hidden`;
 * - an effective `font-size:0` (the nearest explicit font size, so an MJML wrapper's zero does
 *   not hide a child that sets its own size) or an effective `visibility:hidden` (nearest wins,
 *   so a child may make itself visible again);
 * - inline `color` equal to an explicitly set `background-color`/`background` colour;
 * - a class or id matched by a simple `<style>` rule (outside an at-rule) that sets
 *   `display:none` or `visibility:hidden`.
 *
 * Known limits: a hide rule with a descendant/child/attribute/pseudo selector, inside `@media` or
 * any other at-rule, or coming from an external stylesheet is not evaluated. A later rule that
 * unhides the element is not considered either: a matching display:none rule wins. The
 * `List-Unsubscribe` header still applies in those cases; the visible link is the stricter check.
 */
export function unsubscribeLinkProblem(html: string, url: string): UnsubscribeLinkProblem | null {
  const wanted = url.trim();
  if (!wanted) return 'missing';

  const stack: ElementInfo[] = [];
  const candidates: Candidate[] = [];
  const open: Candidate[] = [];
  let css = '';
  let inStyle = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'style') inStyle++;
        const el = element(name, attribs);
        stack.push(el);
        if (name === 'img' && open.length && attribs.alt?.trim()) {
          for (const c of open) c.imageAlt = true;
        }
        if (name === 'a') {
          const href = attribs.href;
          if (href !== undefined && href.trim() === wanted) {
            const c: Candidate = {
              chain: [...stack],
              outsideBody: stack.some((e) => NOT_BODY.has(e.name)),
              text: false,
              imageAlt: false,
            };
            candidates.push(c);
            open.push(c);
          }
        }
      },
      ontext(text) {
        if (inStyle) {
          css += text;
          return;
        }
        if (open.length && text.trim()) for (const c of open) c.text = true;
      },
      oncomment(text) {
        // A link that was commented out is not a link. It has no element to inspect, so mark the
        // document as holding a hidden one; a usable candidate elsewhere still wins in the scan.
        if (text.includes(wanted)) candidates.push({ chain: [], outsideBody: true, text: false, imageAlt: false });
      },
      onclosetag(name) {
        if (name === 'style' && inStyle > 0) inStyle--;
        if (name === 'a') open.pop();
        let i = stack.length - 1;
        while (i >= 0 && stack[i]!.name !== name) i--;
        if (i >= 0) stack.length = i;
      },
    },
    // Decode entities: the parser then compares the URL a reader would click, not its HTML form.
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const rules = hiddenSelectors(css);
  let sawHidden = false;
  let sawEmpty = false;
  for (const c of candidates) {
    if (c.outsideBody || chainHidden(c.chain, rules)) {
      sawHidden = true;
      continue;
    }
    if (!c.text && !c.imageAlt) {
      sawEmpty = true;
      continue;
    }
    return null;
  }
  if (sawHidden) return 'hidden';
  if (sawEmpty) return 'empty';
  return 'missing';
}

function element(name: string, attribs: Record<string, string>): ElementInfo {
  return {
    name,
    attribs,
    id: attribs.id ?? null,
    classes: new Set((attribs.class ?? '').split(/\s+/).filter(Boolean)),
    declarations: attribs.style ? parseDeclarations(attribs.style) : new Map(),
  };
}

/**
 * Whether any element in the link's chain hides it. `visibility` and `font-size` are inherited,
 * so the nearest explicit value decides: an MJML wrapper's `font-size:0` does not hide a link
 * whose own container sets 13px. `display`, `opacity`, clipping and aria-hidden hide the subtree
 * regardless of descendants.
 */
function chainHidden(chain: ElementInfo[], rules: HiddenRules): boolean {
  let visibility: 'hidden' | 'visible' | null = null;
  let fontSizeZero: boolean | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const el = chain[i]!;
    const d = el.declarations;
    if ('hidden' in el.attribs) return true;
    if ((el.attribs['aria-hidden'] ?? '').trim().toLowerCase() === 'true') return true;
    if (d.get('display') === 'none' || rules.display.some((s) => selectorMatches(s, el))) return true;
    if (isZero(d.get('opacity'))) return true;
    if ((isZero(d.get('max-height')) || isZero(d.get('height')) || isZero(d.get('width'))) && (d.get('overflow') ?? '').includes('hidden'))
      return true;
    if ((d.get('mso-hide') ?? '') === 'all') return true;
    const colour = colourValue(d.get('color'));
    const background = colourValue(d.get('background-color') ?? d.get('background'));
    if (colour !== null && background !== null && colour === background) return true;

    if (visibility === null) {
      const declared = d.get('visibility');
      if (declared === 'hidden' || declared === 'visible') visibility = declared;
      else if (rules.visibility.some((s) => selectorMatches(s, el))) visibility = 'hidden';
    }
    if (fontSizeZero === null && d.has('font-size')) fontSizeZero = isZero(d.get('font-size'));
  }
  return visibility === 'hidden' || fontSizeZero === true;
}

function selectorMatches(selector: HideSelector, el: ElementInfo): boolean {
  if (selector.tag !== null && selector.tag !== el.name) return false;
  if (selector.id !== null && selector.id !== el.id) return false;
  return selector.classes.every((c) => el.classes.has(c));
}

/** Declarations of one inline style, or of one simple CSS rule body. */
function parseDeclarations(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    const bang = value.lastIndexOf('!');
    if (bang >= 0 && value.slice(bang + 1).trim() === 'important') value = value.slice(0, bang).trim();
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

/** A zero length in any unit (`0`, `0px`, `0.0em`), but not `0.5em`. */
function isZero(value: string | undefined): boolean {
  if (!value) return false;
  let end = 0;
  while (end < value.length) {
    const ch = value[end]!;
    if (ch === '.' || (ch >= '0' && ch <= '9')) end++;
    else break;
  }
  if (end === 0) return false;
  const n = Number(value.slice(0, end));
  return Number.isFinite(n) && n === 0;
}

/** A comparable colour value, or null when the declaration is not a plain colour. */
function colourValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.replace(/\s+/g, '').toLowerCase();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3 && isHex(hex)) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    if (hex.length === 6 && isHex(hex)) return value;
    return null;
  }
  if (value.startsWith('rgb(') || value.startsWith('rgba(') || value.startsWith('hsl(') || value.startsWith('hsla(')) return value;
  if (isLetters(value)) return value;
  return null;
}

function isHex(s: string): boolean {
  for (const ch of s) {
    if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false;
  }
  return true;
}

function isLetters(s: string): boolean {
  if (!s) return false;
  for (const ch of s) {
    if (!((ch >= 'a' && ch <= 'z') || ch === '-')) return false;
  }
  return true;
}

/**
 * Simple `display:none` / `visibility:hidden` rules, skipping comments and every at-rule block.
 * The two declarations are kept apart because one hides a subtree outright and the other is
 * inherited and can be reversed by a nearer `visibility:visible`.
 */
function hiddenSelectors(css: string): HiddenRules {
  const text = stripCssComments(css);
  const rules: HiddenRules = { display: [], visibility: [] };
  let i = 0;
  while (i < text.length) {
    const brace = text.indexOf('{', i);
    if (brace < 0) break;
    const prelude = text.slice(i, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(brace + 1, depth === 0 ? j - 1 : j);
    // An at-rule (notably @media) may hold rules this predicate does not resolve; skip it whole.
    if (!prelude.startsWith('@')) {
      const declarations = parseDeclarations(body);
      const hides: (keyof HiddenRules)[] = [];
      if (declarations.get('display') === 'none') hides.push('display');
      if (declarations.get('visibility') === 'hidden') hides.push('visibility');
      for (const part of prelude.split(',')) {
        const selector = parseSimpleSelector(part.trim());
        if (selector === null) continue;
        for (const kind of hides) rules[kind].push(selector);
      }
    }
    i = j;
  }
  return rules;
}

/**
 * One class/id/tag compound selector, or null for anything this predicate does not model:
 * combinators, attribute selectors and pseudo-classes.
 */
function parseSimpleSelector(raw: string): HideSelector | null {
  if (!raw) return null;
  for (const ch of raw) {
    if (
      ch === '.' ||
      ch === '#' ||
      ch === '-' ||
      ch === '_' ||
      (ch >= 'a' && ch <= 'z') ||
      (ch >= 'A' && ch <= 'Z') ||
      (ch >= '0' && ch <= '9')
    )
      continue;
    return null;
  }
  let i = 0;
  while (i < raw.length && raw[i] !== '.' && raw[i] !== '#') i++;
  const tag = i > 0 ? raw.slice(0, i).toLowerCase() : null;
  let id: string | null = null;
  const classes: string[] = [];
  while (i < raw.length) {
    const kind = raw[i];
    let j = i + 1;
    while (j < raw.length && raw[j] !== '.' && raw[j] !== '#') j++;
    const name = raw.slice(i + 1, j);
    if (!name) return null;
    if (kind === '.') classes.push(name);
    else id = name;
    i = j;
  }
  return { tag, id, classes };
}

function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const start = css.indexOf('/*', i);
    if (start < 0) return out + css.slice(i);
    out += css.slice(i, start);
    const end = css.indexOf('*/', start + 2);
    if (end < 0) return out;
    i = end + 2;
  }
}

/** The author-facing reason, shared by the save validator and the publish gate. */
export function unsubscribeProblemMessage(problem: UnsubscribeLinkProblem): string {
  if (problem === 'hidden')
    return 'The unsubscribe link is hidden, so readers cannot see or click it. Make it a visible link in the message body.';
  if (problem === 'empty')
    return 'The unsubscribe link has no text, so readers cannot see it. Give it a few words, or an image with alt text.';
  return 'A marketing e-mail must contain an unsubscribe link, and this one does not.';
}
