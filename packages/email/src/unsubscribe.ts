import { Parser } from 'htmlparser2';

// #637 (review, P2): the gate must find an unsubscribe link a reader can actually see and click.
// A link that exists only in the source — inline display:none, an ancestor style, a <template>, an
// empty anchor, text hidden inside the link, transparent text — is not an unsubscribe link. This
// predicate is shared by the save validator and the publish gate, so both give the same answer.
//
// Visibility is evaluated where the content is, not just at the anchor: one top-down pass carries
// the inherited state (visibility, font-size, colour, background, whether a subtree is hidden
// outright) through every element, and a text node or <img alt> counts only when that state at the
// node is visible. Style rules from <style> are collected in a small first pass and cascaded
// against the inline declarations the way CSS does within the scope described below.

export type UnsubscribeLinkProblem = 'missing' | 'hidden' | 'empty' | 'too_deep';

/**
 * The deepest element nesting the check evaluates. MJML output nests a few dozen levels; deeper
 * documents are rejected, because the HTML parser's own open-element stack is super-linear in the
 * depth (review round 6).
 */
export const MAX_UNSUBSCRIBE_NESTING = 512;

/** The most classes one compound selector may name and still be modelled (review round 6). */
const MAX_SELECTOR_CLASSES = 8;

/** Elements whose content is not rendered as visible body content in an e-mail. */
const NOT_BODY = new Set(['template', 'head', 'script', 'style', 'noscript']);

/** One declaration with the importance CSS needs for the cascade. */
interface Declaration {
  value: string;
  important: boolean;
}

interface ElementInfo {
  name: string;
  attribs: Record<string, string>;
  classes: Set<string>;
  id: string | null;
  declarations: Map<string, Declaration>;
}

interface Candidate {
  /** Inside <template>, <head>, <script>, <style> or <noscript>. */
  outsideBody: boolean;
  /** A non-whitespace text node or an <img alt>, rendered or not. */
  content: boolean;
  /** At least one of those content nodes is visible where it sits. */
  visible: boolean;
}

/** A simple class/id/tag selector whose rule sets display or visibility. */
interface HideSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
}

interface RuleDecl {
  selector: HideSelector;
  value: string;
  important: boolean;
  /** Document order, so the later of two simple rules wins. */
  order: number;
}

/** The latest important and normal rule for one selector key; importance beats document order. */
interface RuleSlot {
  important: RuleDecl | null;
  normal: RuleDecl | null;
}

interface RuleBucket {
  byTag: Map<string, RuleSlot>;
  byId: Map<string, RuleSlot>;
  byClass: Map<string, RuleSlot>;
  compound: RuleDecl[];
}

interface HiddenRules {
  display: RuleBucket;
  visibility: RuleBucket;
  background: RuleBucket;
}

/**
 * Carried down the tree. `hidden` is latched for the subtree (display:none, hidden, aria-hidden,
 * opacity:0, a clipped zero box, mso-hide:all, an off-screen position); the rest are inherited
 * properties whose nearest explicit value wins.
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

const ruleBucket = (): RuleBucket => ({ byTag: new Map(), byId: new Map(), byClass: new Map(), compound: [] });

/** Named colours that matter for the comparisons below; other names compare only verbatim. */
const NAMED_COLOURS: Record<string, string> = { white: '#ffffff', black: '#000000', transparent: '#00000000' };

/** Words that are not colours, even though `isLetters` would accept them. */
const NON_COLOURS = new Set(['none', 'inherit', 'initial', 'unset', 'revert', 'revert-layer', 'currentcolor']);

const isSpace = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';

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
 * - `display:none`, `opacity:0`, or `mso-hide:all`;
 * - a zero max-height/height/width together with `overflow:hidden`;
 * - an effective `font-size:0` or `visibility:hidden`;
 * - an effective text colour that is transparent, has zero alpha, or equals the effective
 *   background colour (a semi-transparent background is composited over a known ancestor one);
 * - an off-screen box: a `text-indent` of at most -1000px with hidden overflow, an absolutely
 *   positioned `left`/`top` of at most -1000px, `clip: rect(0,0,0,0)`, or a `clip-path` of
 *   `inset(50%)`/`inset(100%)`/`circle(0)`;
 * - a class or id matched by a simple `<style>` rule (outside an at-rule) that sets display,
 *   visibility or a background, cascaded with the inline style.
 *
 * Cascade scope: declarations in one style attribute or one rule use the last value, except that
 * `!important` beats a later value without it. `background` and `background-color` are one
 * property for this purpose, so the later of the two wins. Inline wins over a simple rule unless
 * the rule is `!important` and the inline value is not; between simple rules an important rule
 * wins, then the later rule. Specificity beyond tag/class/id is not modelled.
 *
 * The `bgcolor` attribute sets an element's background when no CSS background applies, and a
 * `<font color>` attribute sets its text colour when no CSS colour does (CSS wins). A `background`
 * shorthand contributes the last top-level token that is a colour, so a gradient or url() before
 * it is ignored.
 *
 * Known limits: selectors with combinators, attributes or pseudo-classes, rules inside `@media` or
 * any other at-rule, compound (tag/class/id) rules past the first 64 per kind, selectors naming
 * more than 8 classes, and external
 * stylesheets are not evaluated (a matching `display:none` rule
 * wins over any later non-important rule that would unhide it). Colour parsing is small: white,
 * black and transparent are normalised, hex and `rgb()`/`rgba()` are compared, but other named
 * colours and nonzero-alpha `hsl()` are not converted (and cannot be composited). Off-screen
 * handling covers only the simple forms above, not transforms, em/rem/percent offsets or other
 * clip shapes. The `List-Unsubscribe` header still applies in those cases; the visible link is the
 * stricter check.
 */
export function unsubscribeLinkProblem(html: string, url: string): UnsubscribeLinkProblem | null {
  const wanted = url.trim();
  if (!wanted) return 'missing';
  const css = styleText(html);
  if (css === null) return 'too_deep';
  const rules = hiddenRules(css);
  let tooDeep = false;

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
        if (stack.length > MAX_UNSUBSCRIBE_NESTING) {
          tooDeep = true;
          parser.pause();
          return;
        }
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
  if (tooDeep) return 'too_deep';
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

/**
 * The style text of every <style> block, collected before the evaluation pass, or null when the
 * document nests deeper than MAX_UNSUBSCRIBE_NESTING (the parse stops there).
 */
function styleText(html: string): string | null {
  let css = '';
  let inStyle = 0;
  let depth = 0;
  let tooDeep = false;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === 'style') inStyle++;
        if (++depth > MAX_UNSUBSCRIBE_NESTING) {
          tooDeep = true;
          parser.pause();
        }
      },
      ontext(text) {
        if (inStyle > 0) css += text;
      },
      onclosetag(name) {
        if (name === 'style' && inStyle > 0) inStyle--;
        if (depth > 0) depth--;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  if (tooDeep) return null;
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
  const display = cascade(d.get('display'), matchRule(rules.display, el));
  const visibilityDecl = cascade(d.get('visibility'), matchRule(rules.visibility, el));
  const visibility =
    visibilityDecl === 'hidden' || visibilityDecl === 'collapse' ? 'hidden' : visibilityDecl === 'visible' ? 'visible' : parent.visibility;

  const overflow = declaredValue(d, 'overflow') ?? '';
  const clipped =
    (isZero(declaredValue(d, 'max-height')) || isZero(declaredValue(d, 'height')) || isZero(declaredValue(d, 'width'))) &&
    overflow.includes('hidden');
  const hidden =
    parent.hidden ||
    'hidden' in el.attribs ||
    (el.attribs['aria-hidden'] ?? '').trim().toLowerCase() === 'true' ||
    display === 'none' ||
    isZero(declaredValue(d, 'opacity')) ||
    clipped ||
    (declaredValue(d, 'mso-hide') ?? '') === 'all' ||
    isOffscreen(d);

  const ownColour = d.has('color') ? colourValue(declaredValue(d, 'color')) : el.name === 'font' ? colourValue(el.attribs.color) : null;
  const backgroundDecl = cascade(d.get('background'), matchRule(rules.background, el));
  // The bgcolor attribute is a presentational hint: only when no CSS background applies.
  const ownBackground = backgroundDecl === undefined ? colourValue(el.attribs.bgcolor) : backgroundColour(backgroundDecl);

  return {
    hidden,
    forbidden: parent.forbidden + (NOT_BODY.has(el.name) ? 1 : 0),
    visibility,
    fontSizeZero: d.has('font-size') ? isZero(declaredValue(d, 'font-size')) : parent.fontSizeZero,
    color: ownColour ?? parent.color,
    // A transparent background shows the ancestor's, and a semi-transparent one is composited
    // over a known ancestor background.
    background: compositeBackground(ownBackground, parent.background),
  };
}

/** The inherited state decides whether text (or an image's alt) is visible where it sits. */
function contentVisible(state: VisibilityState): boolean {
  if (state.hidden || state.visibility === 'hidden' || state.fontSizeZero === true) return false;
  if (state.color !== null && isInvisibleColour(state.color)) return false;
  return !(state.color !== null && state.background !== null && state.color === state.background);
}

/**
 * The winning value of an inline declaration against the winning simple rule. Inline wins unless
 * the rule is `!important` and the inline value is not; an inline `!important` also wins.
 */
function cascade(inline: Declaration | undefined, rule: RuleDecl | null): string | undefined {
  if (rule && (!inline || (rule.important && !inline.important))) return rule.value;
  return inline?.value;
}

/** The latest matching important rule, else the latest matching normal rule. */
function matchRule(bucket: RuleBucket, el: ElementInfo): RuleDecl | null {
  let important: RuleDecl | null = null;
  let normal: RuleDecl | null = null;
  const consider = (rule: RuleDecl | null | undefined) => {
    if (!rule) return;
    if (rule.important) {
      if (!important || rule.order > important.order) important = rule;
    } else if (!normal || rule.order > normal.order) {
      normal = rule;
    }
  };
  if (el.id !== null) considerSlot(bucket.byId.get(el.id), consider);
  for (const c of el.classes) considerSlot(bucket.byClass.get(c), consider);
  considerSlot(bucket.byTag.get(el.name), consider);
  for (const rule of bucket.compound) if (selectorMatches(rule.selector, el)) consider(rule);
  return important ?? normal;
}

function considerSlot(slot: RuleSlot | undefined, consider: (rule: RuleDecl | null | undefined) => void): void {
  if (!slot) return;
  consider(slot.important);
  consider(slot.normal);
}

function selectorMatches(selector: HideSelector, el: ElementInfo): boolean {
  if (selector.tag !== null && selector.tag !== el.name) return false;
  if (selector.id !== null && selector.id !== el.id) return false;
  return selector.classes.every((c) => el.classes.has(c));
}

function addRule(bucket: RuleBucket, rule: RuleDecl): void {
  const { tag, id, classes } = rule.selector;
  if (tag === null && id === null && classes.length === 1) {
    addToSlot(bucket.byClass, classes[0]!, rule);
  } else if (tag === null && id !== null && classes.length === 0) {
    addToSlot(bucket.byId, id, rule);
  } else if (tag !== null && id === null && classes.length === 0) {
    addToSlot(bucket.byTag, tag, rule);
  } else if (bucket.compound.length < MAX_COMPOUND_RULES) {
    // Compound selectors are matched against every element, so their number is capped to keep the
    // check linear in the document (review round 5). Normal templates have a handful; rules past
    // the cap are a stated limit, like complex selectors.
    bucket.compound.push(rule);
  }
}

/** The most compound (tag/class/id) rules modelled per bucket; see addRule. */
const MAX_COMPOUND_RULES = 64;

function addToSlot(map: Map<string, RuleSlot>, key: string, rule: RuleDecl): void {
  const slot = map.get(key) ?? { important: null, normal: null };
  if (rule.important) slot.important = rule;
  else slot.normal = rule;
  map.set(key, slot);
}

/** Declarations of one style attribute or rule body: last wins, but `!important` beats later. */
function parseDeclarations(style: string): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const rawName = part.slice(0, colon).trim().toLowerCase();
    if (!rawName) continue;
    // The shorthand and the longhand are one property for the cascade: the later one wins.
    const name = rawName === 'background-color' ? 'background' : rawName;
    let value = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    let important = false;
    const bang = value.lastIndexOf('!');
    if (bang >= 0 && value.slice(bang + 1).trim() === 'important') {
      important = true;
      value = value.slice(0, bang).trim();
    }
    const previous = out.get(name);
    if (!previous?.important || important) out.set(name, { value, important });
  }
  return out;
}

function declaredValue(d: Map<string, Declaration>, name: string): string | undefined {
  return d.get(name)?.value;
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

/**
 * Pixels in a simple length (`-9999px`, `0`, `12.5px`), or null for another unit. Percentages,
 * em/rem and calc() are stated limits.
 */
function lengthPx(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  let i = 0;
  let sign = 1;
  if (s[i] === '-') {
    sign = -1;
    i++;
  } else if (s[i] === '+') i++;
  const start = i;
  let digits = 0;
  let dot = false;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch >= '0' && ch <= '9') {
      digits++;
      i++;
    } else if (ch === '.' && !dot) {
      dot = true;
      i++;
    } else break;
  }
  if (digits === 0) return null;
  const unit = s.slice(i).trim();
  if (unit !== '' && unit !== 'px') return null;
  const n = Number(s.slice(start, i)) * sign;
  return Number.isFinite(n) ? n : null;
}

/** The simple off-screen forms: an indented first line, a far absolute offset, a zero clip box. */
function isOffscreen(d: Map<string, Declaration>): boolean {
  const overflow = declaredValue(d, 'overflow') ?? '';
  const indent = lengthPx(declaredValue(d, 'text-indent'));
  if (indent !== null && indent <= -1000 && (overflow.includes('hidden') || overflow.includes('clip'))) return true;

  const position = declaredValue(d, 'position');
  if (position === 'absolute' || position === 'fixed') {
    const left = lengthPx(declaredValue(d, 'left'));
    const top = lengthPx(declaredValue(d, 'top'));
    if ((left !== null && left <= -1000) || (top !== null && top <= -1000)) return true;
  }

  const clip = declaredValue(d, 'clip');
  if (clip !== undefined && zeroRect(clip)) return true;
  const clipPath = declaredValue(d, 'clip-path');
  if (clipPath !== undefined && zeroClipPath(clipPath)) return true;
  return false;
}

function zeroRect(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value.startsWith('rect(') || !value.endsWith(')')) return false;
  const parts = value.slice(5, -1).split(',');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const n = lengthPx(part.trim());
    return n !== null && n === 0;
  });
}

function zeroClipPath(raw: string): boolean {
  const value = raw.replace(/\s+/g, '').toLowerCase();
  return value === 'inset(50%)' || value === 'inset(100%)' || value === 'circle(0)' || value === 'circle(0px)';
}

/**
 * A comparable colour. Hex, `rgb()`/`rgba()` and the named colours that matter are normalised;
 * transparent and zero-alpha colours become `#rrggbb00`. Other names compare verbatim, and a
 * nonzero-alpha `hsl()` is not converted.
 */
function colourValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (!isHex(hex)) return null;
    if (hex.length === 3) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    if (hex.length === 4) {
      const expanded = `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
      return expanded.endsWith('ff') ? expanded.slice(0, 7) : expanded;
    }
    if (hex.length === 6) return `#${hex}`;
    if (hex.length === 8) return hex.endsWith('ff') ? `#${hex.slice(0, 6)}` : `#${hex}`;
    return null;
  }
  if (value.startsWith('rgb(') || value.startsWith('rgba(')) return rgbValue(value);
  if (value.startsWith('hsl(') || value.startsWith('hsla(')) {
    const alpha = alphaOf(value);
    if (alpha === 0) return '#00000000';
    return value.replace(/\s+/g, '');
  }
  if (NON_COLOURS.has(value)) return null;
  return NAMED_COLOURS[value] ?? (isLetters(value) ? value : null);
}

/**
 * The colour of a `background` shorthand: the value itself when it is one colour, else the last
 * top-level token that is a colour. Tokens inside parentheses (url(), gradients) are ignored.
 */
function backgroundColour(raw: string): string | null {
  const direct = colourValue(raw);
  if (direct !== null) return direct;
  let depth = 0;
  let start = -1;
  let last: string | null = null;
  for (let i = 0; i <= raw.length; i++) {
    const ch = i < raw.length ? raw[i]! : ' ';
    if (depth === 0 && isSpace(ch)) {
      if (start >= 0) {
        last = colourToken(raw.slice(start, i)) ?? last;
        start = -1;
      }
      continue;
    }
    if (start < 0) start = i;
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
  }
  return last;
}

/** A shorthand token counts only if it is plainly a colour; background keywords are not. */
function colourToken(token: string): string | null {
  const value = token.trim().toLowerCase();
  if (
    value.startsWith('#') ||
    value.startsWith('rgb(') ||
    value.startsWith('rgba(') ||
    value.startsWith('hsl(') ||
    value.startsWith('hsla(')
  )
    return colourValue(value);
  return NAMED_COLOURS[value] ?? null;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A canonical hex colour as channels, or null for a named colour we cannot decompose. */
function rgbaOf(colour: string): Rgba | null {
  if (!colour.startsWith('#')) return null;
  const hex = colour.slice(1);
  if (!isHex(hex) || (hex.length !== 6 && hex.length !== 8)) return null;
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

/**
 * The background a reader sees: an own transparent background keeps the parent's; a
 * semi-transparent one is composited over a known parent background, and an unknown parent is
 * kept as unknown (so a colour is never invented from no backdrop).
 */
function compositeBackground(own: string | null, parent: string | null): string | null {
  if (own === null) return parent;
  const o = rgbaOf(own);
  if (o === null) return own;
  if (o.a <= 0) return parent;
  if (o.a >= 1) return own;
  const p = parent === null ? null : rgbaOf(parent);
  if (p === null) return parent;
  const alpha = o.a + p.a * (1 - o.a);
  if (alpha <= 0) return parent;
  const mix = (os: number, ps: number) => Math.round((os * o.a + ps * p.a * (1 - o.a)) / alpha);
  const hex = `#${byteHex(mix(o.r, p.r))}${byteHex(mix(o.g, p.g))}${byteHex(mix(o.b, p.b))}`;
  return alpha >= 1 ? hex : `${hex}${byteHex(Math.round(alpha * 255))}`;
}

/** `rgb()`/`rgba()`, with comma or space syntax and an optional `/ alpha`. */
function rgbValue(raw: string): string {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close <= open) return raw.replace(/\s+/g, '');
  let body = raw.slice(open + 1, close);
  let alphaPart: string | undefined;
  const slash = body.indexOf('/');
  if (slash >= 0) {
    alphaPart = body.slice(slash + 1).trim();
    body = body.slice(0, slash);
  }
  const parts = body.split(/[,\s]+/).filter(Boolean);
  if (parts.length < 3) return raw.replace(/\s+/g, '');
  const channels = parts.slice(0, 3).map(channelValue);
  if (channels.some((c) => c === null)) return raw.replace(/\s+/g, '');
  if (alphaPart === undefined && parts.length >= 4) alphaPart = parts[3];
  const alpha = alphaPart === undefined ? 1 : alphaNumber(alphaPart);
  if (alpha === null) return raw.replace(/\s+/g, '');
  const hex = `#${channels.map((c) => byteHex(c!)).join('')}`;
  if (alpha <= 0) return `${hex}00`;
  if (alpha >= 1) return hex;
  return `${hex}${byteHex(Math.round(alpha * 255))}`;
}

function channelValue(raw: string): number | null {
  const value = raw.trim();
  const n = value.endsWith('%') ? (Number(value.slice(0, -1)) * 255) / 100 : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(255, Math.max(0, Math.round(n)));
}

/** The alpha of an `hsl()`/`hsla()` or the `/ alpha` of an `rgb()`, 0–1; null when unreadable. */
function alphaOf(raw: string): number | null {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const body = raw.slice(open + 1, close);
  const slash = body.indexOf('/');
  if (slash >= 0) return alphaNumber(body.slice(slash + 1).trim());
  const parts = body.split(/[,\s]+/).filter(Boolean);
  return parts.length >= 4 ? alphaNumber(parts[3]!) : 1;
}

function alphaNumber(raw: string): number | null {
  const value = raw.trim();
  const n = value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value);
  return Number.isFinite(n) ? n : null;
}

function byteHex(n: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(n)));
  return clamped.toString(16).padStart(2, '0');
}

function isInvisibleColour(colour: string): boolean {
  if (colour === '#00000000') return true;
  return colour.length === 9 && colour.startsWith('#') && colour.endsWith('00');
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
 * Simple display/visibility rules in document order, skipping comments and every at-rule block.
 * A rule that sets `display:block` is kept too, so it can override an earlier hide.
 */
function hiddenRules(css: string): HiddenRules {
  const text = stripCssComments(css);
  const rules: HiddenRules = { display: ruleBucket(), visibility: ruleBucket(), background: ruleBucket() };
  let i = 0;
  let order = 0;
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
      order++;
      const declarations = parseDeclarations(body);
      for (const property of ['display', 'visibility', 'background'] as const) {
        const declaration = declarations.get(property);
        if (!declaration) continue;
        for (const part of prelude.split(',')) {
          const selector = parseSimpleSelector(part.trim());
          if (selector === null) continue;
          addRule(rules[property], { selector, value: declaration.value, important: declaration.important, order });
        }
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
    if (kind === '.') {
      // A selector naming many classes is matched class by class against every candidate element;
      // past a few it is a stated limit, which keeps matching linear (review round 6).
      if (classes.length >= MAX_SELECTOR_CLASSES) return null;
      classes.push(name);
    } else id = name;
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
  if (problem === 'too_deep')
    return `The e-mail nests elements more than ${MAX_UNSUBSCRIBE_NESTING} levels deep, so the unsubscribe link cannot be checked. Simplify the layout.`;
  if (problem === 'empty')
    return 'The unsubscribe link has no text, so readers cannot see it. Give it a few words, or an image with alt text.';
  return 'A marketing e-mail must contain an unsubscribe link, and this one does not.';
}
