import { Parser } from 'htmlparser2';

// #637 (review, P2): the gate must find an unsubscribe link a reader can actually see and click.
// A link that exists only in the source — inline display:none, an ancestor style, a <template>, an
// empty anchor, or text hidden inside the link — is not an unsubscribe link. This predicate is
// shared by the save validator and the publish gate, so both give the same answer.
//
// Visibility is evaluated where the content is, not just at the anchor: a single top-down pass
// carries the inherited state (visibility, font-size, colour, background, whether a subtree is
// hidden outright) through every element, and a text node or <img alt> counts only when that
// state at the node is visible. The CSS rules from <style> are collected in a small first pass,
// so the evaluation pass knows them before it reaches the body.

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
  /** Inside <template>, <head>, <script>, <style> or <noscript>. */
  outsideBody: boolean;
  /** A non-whitespace text node or an <img alt>, rendered or not. */
  content: boolean;
  /** At least one of those content nodes is visible where it sits. */
  visible: boolean;
}

/** A simple class/id selector whose rule hides its target. Complex selectors are not modelled. */
interface HideSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
}

interface HiddenRules {
  display: RuleIndex;
  visibility: RuleIndex;
}

/** Style rules indexed for a constant-time match in the evaluation pass. */
interface RuleIndex {
  byTag: Set<string>;
  byId: Set<string>;
  byClass: Set<string>;
  compound: HideSelector[];
}

const ruleIndex = (): RuleIndex => ({ byTag: new Set(), byId: new Set(), byClass: new Set(), compound: [] });

/**
 * Carried down the tree. `hidden` is latched for the subtree (display:none, hidden, aria-hidden,
 * opacity:0, a clipped zero box, mso-hide:all); the rest are inherited properties whose nearest
 * explicit value wins.
 */
interface VisibilityState {
  hidden: boolean;
  forbidden: number;
  visibility: 'hidden' | 'visible' | null;
  fontSizeZero: boolean | null;
  color: string | null;
  background: string | null;
}

interface OpenElement {
  name: string;
  state: VisibilityState;
}

const INITIAL: VisibilityState = {
  hidden: false,
  forbidden: 0,
  visibility: null,
  fontSizeZero: null,
  color: null,
  background: null,
};

/**
 * True when the rendered HTML has a usable unsubscribe link. `url` is the rendered
 * `unsubscribe_url`, the same value the send gateway puts in the visible link and in
 * `List-Unsubscribe` / `List-Unsubscribe-Post` for marketing mail.
 *
 * Returns null when a visible link exists, otherwise why not: `missing` (no link to that URL),
 * `hidden` (outside the body, or it has content but none of it is visible) or `empty` (no text
 * and no image alt at all).
 *
 * A content node is hidden when it, or any element on the path up to the body, has:
 * - `hidden` or `aria-hidden="true"`;
 * - inline `display:none`, `opacity:0`, or `mso-hide:all`;
 * - a zero max-height/height/width together with `overflow:hidden`;
 * - an effective `font-size:0`, `visibility:hidden`, or text colour equal to the effective
 *   background colour, with the nearest explicit value on the path winning for the inherited ones;
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
  const rules = hiddenRules(styleText(html));

  const stack: OpenElement[] = [];
  const candidates: Candidate[] = [];
  const anchors: (Candidate | null)[] = [];

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const parent = stack.length > 0 ? stack[stack.length - 1]!.state : INITIAL;
        const el = element(name, attribs);
        const state = nextState(el, parent, rules);
        let candidate: Candidate | null = null;
        if (name === 'a') {
          if (attribs.href !== undefined && attribs.href.trim() === wanted) {
            candidate = { outsideBody: state.forbidden > 0, content: false, visible: false };
            candidates.push(candidate);
          }
          anchors.push(candidate);
        }
        stack.push({ name, state });
        // The image itself is the content node, so judge it in its own state (its alt is visible
        // only if the image is).
        if (name === 'img' && attribs.alt?.trim()) {
          const c = anchors.length > 0 ? anchors[anchors.length - 1] : null;
          if (c && state.forbidden === 0) {
            c.content = true;
            if (contentVisible(state)) c.visible = true;
          }
        }
      },
      ontext(text) {
        if (!text.trim() || anchors.length === 0) return;
        const state = stack.length > 0 ? stack[stack.length - 1]!.state : INITIAL;
        if (state.forbidden > 0) return;
        const c = anchors[anchors.length - 1];
        if (!c) return;
        c.content = true;
        if (contentVisible(state)) c.visible = true;
      },
      oncomment(text) {
        // A link that was commented out is not a link. It has no element to inspect, so mark a
        // hidden candidate; a usable candidate elsewhere still wins.
        if (text.includes(wanted)) candidates.push({ outsideBody: true, content: true, visible: false });
      },
      onclosetag(name) {
        if (name === 'a') anchors.pop();
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

  let sawHidden = false;
  let sawEmpty = false;
  for (const c of candidates) {
    if (c.visible) return null;
    if (c.outsideBody || c.content) sawHidden = true;
    else sawEmpty = true;
  }
  if (sawHidden) return 'hidden';
  if (sawEmpty) return 'empty';
  return 'missing';
}

/** The style text of every <style> block, collected before the evaluation pass. */
function styleText(html: string): string {
  let css = '';
  let inStyle = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === 'style') inStyle++;
      },
      ontext(text) {
        if (inStyle > 0) css += text;
      },
      onclosetag(name) {
        if (name === 'style' && inStyle > 0) inStyle--;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return css;
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

/** The state for one element, from its parent's inherited state and its own attributes/rules. */
function nextState(el: ElementInfo, parent: VisibilityState, rules: HiddenRules): VisibilityState {
  const d = el.declarations;
  const clipped =
    (isZero(d.get('max-height')) || isZero(d.get('height')) || isZero(d.get('width'))) && (d.get('overflow') ?? '').includes('hidden');
  const hidden =
    parent.hidden ||
    'hidden' in el.attribs ||
    (el.attribs['aria-hidden'] ?? '').trim().toLowerCase() === 'true' ||
    d.get('display') === 'none' ||
    ruleMatches(rules.display, el) ||
    isZero(d.get('opacity')) ||
    clipped ||
    (d.get('mso-hide') ?? '') === 'all';

  const declaredVisibility = d.get('visibility');
  const visibility =
    declaredVisibility === 'hidden' || declaredVisibility === 'visible'
      ? declaredVisibility
      : ruleMatches(rules.visibility, el)
        ? 'hidden'
        : parent.visibility;

  const ownColour = d.has('color') ? colourValue(d.get('color')) : null;
  const backgroundDeclaration = d.has('background-color') ? d.get('background-color') : d.get('background');
  const ownBackground = backgroundDeclaration === undefined ? null : colourValue(backgroundDeclaration);

  return {
    hidden,
    forbidden: parent.forbidden + (NOT_BODY.has(el.name) ? 1 : 0),
    visibility,
    fontSizeZero: d.has('font-size') ? isZero(d.get('font-size')) : parent.fontSizeZero,
    color: ownColour ?? parent.color,
    background: ownBackground ?? parent.background,
  };
}

/** The inherited state decides whether text (or an image's alt) is visible where it sits. */
function contentVisible(state: VisibilityState): boolean {
  if (state.hidden || state.visibility === 'hidden' || state.fontSizeZero === true) return false;
  return !(state.color !== null && state.background !== null && state.color === state.background);
}

function selectorMatches(selector: HideSelector, el: ElementInfo): boolean {
  if (selector.tag !== null && selector.tag !== el.name) return false;
  if (selector.id !== null && selector.id !== el.id) return false;
  return selector.classes.every((c) => el.classes.has(c));
}

/** A constant-time check for the common selectors, with a small fallback for compounds. */
function ruleMatches(index: RuleIndex, el: ElementInfo): boolean {
  if (el.id !== null && index.byId.has(el.id)) return true;
  for (const c of el.classes) if (index.byClass.has(c)) return true;
  if (index.byTag.has(el.name)) return true;
  return index.compound.some((s) => selectorMatches(s, el));
}

function addRule(index: RuleIndex, selector: HideSelector): void {
  if (selector.tag === null && selector.id === null && selector.classes.length === 1) {
    index.byClass.add(selector.classes[0]!);
  } else if (selector.tag === null && selector.id !== null && selector.classes.length === 0) {
    index.byId.add(selector.id);
  } else if (selector.tag !== null && selector.id === null && selector.classes.length === 0) {
    index.byTag.add(selector.tag);
  } else {
    index.compound.push(selector);
  }
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
function hiddenRules(css: string): HiddenRules {
  const text = stripCssComments(css);
  const rules: HiddenRules = { display: ruleIndex(), visibility: ruleIndex() };
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
        for (const kind of hides) addRule(rules[kind], selector);
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
