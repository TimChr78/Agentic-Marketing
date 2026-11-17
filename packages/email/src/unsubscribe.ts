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

export type UnsubscribeLinkProblem = 'missing' | 'hidden' | 'empty' | 'too_complex';

/**
 * The longest the check may run on one document. Normal e-mails take a few milliseconds; past the
 * budget the check stops and rejects, so no input can make a save or publish slow (review round 8).
 */
export const MAX_UNSUBSCRIBE_CHECK_MS = 1_000;

/**
 * The deepest element nesting the check evaluates. MJML output nests a few dozen levels; deeper
 * documents are rejected, because the HTML parser's own open-element stack is super-linear in the
 * depth (review round 6).
 */
export const MAX_UNSUBSCRIBE_NESTING = 512;

/** The most classes one compound selector may name and still be modelled (review round 6). */
const MAX_SELECTOR_CLASSES = 8;

/**
 * Elements whose content is not rendered as visible body content in an e-mail. `noembed`,
 * `noframes` and `iframe` hold fallback markup no client shows; htmlparser2 12 parses them as raw
 * text, so without them here their text would count as visible link content (0.14.9 review).
 */
// SVG `title`, `desc` and `metadata` are never drawn either; parser 12 exposes anchors inside an
// SVG `title` as elements (0.14.9 review round 2). An HTML `title` belongs in `head`, already listed.
// Inline SVG and MathML are not a reliable way to show a link in e-mail (Gmail and others strip
// inline SVG), and much of their content is never drawn (defs, symbol, clipPath, mask, title,
// annotation, foreign textarea …). Nothing inside them counts as a visible unsubscribe link
// (0.14.9 review round 3).
const NOT_BODY = new Set([
  'template',
  'head',
  'script',
  'style',
  'noscript',
  'noembed',
  'noframes',
  'iframe',
  'title',
  'desc',
  'metadata',
  'svg',
  'math',
]);

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

/** A simple class/id/tag selector whose rule sets a visibility-relevant property. */
interface HideSelector {
  tag: string | null;
  id: string | null;
  /** How many times the id is named: `#a#a` counts twice toward specificity, as in CSS. */
  idCount: number;
  classes: string[];
}

interface RuleDecl {
  selector: HideSelector;
  value: string;
  important: boolean;
  /** The one declaration every selector of a comma list shares, so parsing is cached per declaration. */
  declaration: Declaration;
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
  opacity: RuleBucket;
  'font-size': RuleBucket;
  color: RuleBucket;
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
 * - a class, id or tag matched by a simple `<style>` rule (outside an at-rule) that sets display,
 *   visibility, opacity, font-size, colour or a background, cascaded with the inline style.
 *
 * Cascade scope: declarations in one style attribute or one rule use the last value, except that
 * `!important` beats a later value without it. `background` and `background-color` are one
 * property for this purpose, so the later of the two wins. Inline wins over a simple rule unless
 * the rule is `!important` and the inline value is not; between simple rules an important rule
 * wins, then the rule with the higher specificity (id, then class, then tag), then the later rule.
 * Specificity beyond simple tag/class/id compounds is not modelled.
 *
 * The `bgcolor` attribute sets an element's background when no CSS background applies, and a
 * `<font color>` attribute sets its text colour when no CSS colour does (CSS wins). A `background`
 * shorthand contributes the last top-level token that is a colour, so a gradient or url() before
 * it is ignored.
 *
 * Rules are ordered as CSS does: importance, then specificity (id, class, tag), then document order.
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
  const startedAt = performance.now();
  const overBudget = () => performance.now() - startedAt > MAX_UNSUBSCRIBE_CHECK_MS;
  const css = styleText(html, overBudget);
  if (css === null) return 'too_complex';
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
        if (stack.length > MAX_UNSUBSCRIBE_NESTING || overBudget()) {
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
        // Entity decoding can split one text run into many calls, so the budget is checked here
        // too, not only at opening tags (review round 9).
        if (overBudget()) {
          tooDeep = true;
          parser.pause();
          return;
        }
        if (anchors.length === 0) return;
        const c = anchors[anchors.length - 1];
        if (!c || c.visible || !text.trim()) return;
        const state = stack.length > 0 ? stack[stack.length - 1]!.state : INITIAL;
        if (state.forbidden > 0) return;
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
  if (tooDeep) return 'too_complex';
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
 * document nests deeper than MAX_UNSUBSCRIBE_NESTING or the check runs past its time budget
 * (the parse stops there).
 */
function styleText(html: string, overBudget: () => boolean): string | null {
  const chunks: string[] = [];
  let inStyle = 0;
  let depth = 0;
  let tooDeep = false;
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === 'style') inStyle++;
        if (++depth > MAX_UNSUBSCRIBE_NESTING || overBudget()) {
          tooDeep = true;
          parser.pause();
        }
      },
      ontext(text) {
        if (inStyle > 0) chunks.push(text);
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
  // Joined flat, not built as a rope: both passes index the result character by character, and a
  // deeply nested cons string makes that quadratic on a large stylesheet (#872).
  return chunks.join('');
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

  // Opacity applies to the element itself (the subtree inherits the latched `hidden`), so the
  // winning declaration only has to say whether it is zero.
  const opacity = cascadeDeclaration(d.get('opacity'), matchRule(rules.opacity, el));
  const opacityZero = opacity !== null && declarationIsZero(opacity);

  const overflow = declaredValue(d, 'overflow') ?? '';
  const clipped =
    (isZero(declaredValue(d, 'max-height')) || isZero(declaredValue(d, 'height')) || isZero(declaredValue(d, 'width'))) &&
    overflow.includes('hidden');
  const hidden =
    parent.hidden ||
    'hidden' in el.attribs ||
    (el.attribs['aria-hidden'] ?? '').trim().toLowerCase() === 'true' ||
    display === 'none' ||
    opacityZero ||
    clipped ||
    (declaredValue(d, 'mso-hide') ?? '') === 'all' ||
    isOffscreen(d);

  // Font-size and colour are inherited: an element without a winning declaration keeps its
  // parent's resolved value, and a child's own declaration replaces it (so font-size:0 on an
  // ancestor does not hide text that resets the size).
  const fontSize = cascadeDeclaration(d.get('font-size'), matchRule(rules['font-size'], el));
  const colour = cascadeDeclaration(d.get('color'), matchRule(rules.color, el));
  const ownColour = colour !== null ? declarationColour(colour) : el.name === 'font' ? colourValue(el.attribs.color) : null;
  const inlineBackground = d.get('background');
  const backgroundRule = matchRule(rules.background, el);
  const ruleWins = backgroundRule !== null && (!inlineBackground || (backgroundRule.important && !inlineBackground.important));
  // The bgcolor attribute is a presentational hint: only when no CSS background applies. A rule's
  // background is parsed once per rule, not once per matching element (review round 7).
  const ownBackground = ruleWins
    ? ruleBackgroundColour(backgroundRule)
    : inlineBackground
      ? backgroundColour(inlineBackground.value)
      : colourValue(el.attribs.bgcolor);

  return {
    hidden,
    forbidden: parent.forbidden + (NOT_BODY.has(el.name) ? 1 : 0),
    visibility,
    fontSizeZero: fontSize !== null ? declarationIsZero(fontSize) : parent.fontSizeZero,
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
 * The winning declaration of an inline declaration against the winning simple rule. Inline wins
 * unless the rule is `!important` and the inline value is not; an inline `!important` also wins.
 * The declaration is returned rather than its value so a rule's value can be parsed once and
 * cached by declaration (review rounds 7 and 8).
 */
function cascadeDeclaration(inline: Declaration | undefined, rule: RuleDecl | null): Declaration | null {
  if (rule && (!inline || (rule.important && !inline.important))) return rule.declaration;
  return inline ?? null;
}

/** The winning value, for properties whose value is compared directly. */
function cascade(inline: Declaration | undefined, rule: RuleDecl | null): string | undefined {
  return cascadeDeclaration(inline, rule)?.value;
}

/** The latest matching important rule, else the latest matching normal rule. */
/**
 * A simple selector's specificity as one comparable number: ids, then classes, then the tag. A
 * compound selector has at most one id, MAX_SELECTOR_CLASSES classes and one tag, so the weights
 * never overlap.
 */
function specificity(selector: HideSelector): number {
  return selector.idCount * 10_000 + selector.classes.length * 100 + (selector.tag !== null ? 1 : 0);
}

/**
 * Whether `rule` wins over `current` in the CSS cascade at the same importance: higher specificity
 * first, then the later rule (#775; the colour, opacity and font-size buckets made a later broad
 * rule able to flip a visible footer to hidden, 0.14.10 review).
 */
function beats(rule: RuleDecl, current: RuleDecl | null): boolean {
  if (!current) return true;
  const a = specificity(rule.selector);
  const b = specificity(current.selector);
  return a !== b ? a > b : rule.order > current.order;
}

function matchRule(bucket: RuleBucket, el: ElementInfo): RuleDecl | null {
  let important: RuleDecl | null = null;
  let normal: RuleDecl | null = null;
  const consider = (rule: RuleDecl | null | undefined) => {
    if (!rule) return;
    if (rule.important) {
      if (beats(rule, important)) important = rule;
    } else if (beats(rule, normal)) {
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
  } else if (tag === null && id !== null && rule.selector.idCount === 1 && classes.length === 0) {
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
/**
 * The longest normalised colour kept. Parsed colours become short hex; only values kept verbatim
 * (unparsed rgb/hsl, unknown names) can be long, and those are compared on every text node, so a
 * longer one is treated as unknown (review rounds 9 and 10). The input itself is not capped: valid
 * CSS such as `rgba(0,0,0,   0)` may be long and still parse.
 */
const MAX_COLOUR_LENGTH = 64;

function colourValue(raw: string | undefined): string | null {
  const colour = parseColour(raw);
  return colour !== null && colour.length > MAX_COLOUR_LENGTH ? null : colour;
}

function parseColour(raw: string | undefined): string | null {
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
/**
 * Each stylesheet declaration's background colour, parsed on first use. Keyed by the declaration,
 * which every selector of a comma list shares, so `.a,.b,.c{background:…}` parses once (review
 * rounds 7 and 8).
 */
const ruleBackgrounds = new WeakMap<Declaration, string | null>();

function ruleBackgroundColour(rule: RuleDecl): string | null {
  const cached = ruleBackgrounds.get(rule.declaration);
  if (cached !== undefined) return cached;
  const colour = backgroundColour(rule.value);
  ruleBackgrounds.set(rule.declaration, colour);
  return colour;
}

/**
 * Each declaration's zero test and colour, parsed on first use like the background above. A rule
 * value may be long and match many elements, so parsing it per element would make the check
 * quadratic (#746).
 */
const declarationZeros = new WeakMap<Declaration, boolean>();
const declarationColours = new WeakMap<Declaration, string | null>();

function declarationIsZero(declaration: Declaration): boolean {
  const cached = declarationZeros.get(declaration);
  if (cached !== undefined) return cached;
  const zero = isZero(declaration.value);
  declarationZeros.set(declaration, zero);
  return zero;
}

function declarationColour(declaration: Declaration): string | null {
  if (declarationColours.has(declaration)) return declarationColours.get(declaration) ?? null;
  const colour = colourValue(declaration.value);
  declarationColours.set(declaration, colour);
  return colour;
}

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
 * Simple visibility-relevant rules (display, visibility, background, opacity, font-size, colour)
 * in document order, skipping comments and every at-rule block. A rule that sets `display:block`
 * is kept too, so it can override an earlier hide.
 */
function hiddenRules(css: string): HiddenRules {
  const text = stripCssComments(css);
  const rules: HiddenRules = {
    display: ruleBucket(),
    visibility: ruleBucket(),
    background: ruleBucket(),
    opacity: ruleBucket(),
    'font-size': ruleBucket(),
    color: ruleBucket(),
  };
  const properties = ['display', 'visibility', 'background', 'opacity', 'font-size', 'color'] as const;
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
      for (const property of properties) {
        const declaration = declarations.get(property);
        if (!declaration) continue;
        for (const part of prelude.split(',')) {
          const selector = parseSimpleSelector(part.trim());
          if (selector === null) continue;
          addRule(rules[property], { selector, value: declaration.value, important: declaration.important, declaration, order });
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
  let idCount = 0;
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
    } else {
      // Two different ids can never match one element; skip the rule. A repeated id counts once
      // per occurrence toward specificity (0.14.10 review round 2). Like many classes, more than
      // MAX_SELECTOR_CLASSES repeats is a stated limit, so the weights in specificity() never overlap.
      if (id !== null && id !== name) return null;
      if (idCount >= MAX_SELECTOR_CLASSES) return null;
      id = name;
      idCount++;
    }
    i = j;
  }
  return { tag, id, idCount, classes };
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

/**
 * The most construct names one warning lists; the rest are dropped so a stylesheet with many
 * unsupported features still produces one short sentence (#872).
 */
const MAX_CSS_CONSTRUCTS = 4;

/**
 * The properties whose unsupported value can decide whether the link is visible. A rule that sets
 * only a layout property the check ignores (margin, text-align) cannot hide the link, so it must
 * not produce a warning.
 */
const CSS_VISIBILITY_PROPERTIES = new Set([
  'display',
  'visibility',
  'opacity',
  'font-size',
  'color',
  'background',
  'background-image',
  'left',
  'right',
  'top',
  'bottom',
  'text-indent',
  'height',
  'max-height',
  'width',
  'max-width',
  'mso-hide',
  'transform',
  '-webkit-transform',
  'clip',
  'clip-path',
]);

/** The properties the refusal models, so only these have a per-kind cap to report. */
const MODELLED_PROPERTIES = new Set(['display', 'visibility', 'background', 'opacity', 'font-size', 'color']);

/** Offsets the check only understands in pixels; a relative unit is a stated limit. */
const OFFSET_PROPERTIES = new Set(['left', 'right', 'top', 'bottom', 'text-indent']);

/** Colour functions the check does not convert, beyond hex, rgb()/rgba() and the named few. */
const OTHER_COLOUR_FUNCTIONS = ['hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'device-cmyk'];

/** Length units the check does not convert for offsets (percent is handled separately). */
const RELATIVE_UNITS = new Set([
  'em',
  'rem',
  'vw',
  'vh',
  'vmin',
  'vmax',
  'ch',
  'ex',
  'cap',
  'ic',
  'lh',
  'rlh',
  'vi',
  'vb',
  'svw',
  'svh',
  'lvw',
  'lvh',
  'dvw',
  'dvh',
  'cqw',
  'cqh',
  'cqi',
  'cqb',
  'cqmin',
  'cqmax',
]);

/**
 * The constructs in the CSS that can reach the unsubscribe link but that the static check does not
 * evaluate (#872). Distinct from `unsubscribeLinkProblem`: a non-empty list is a warning, never a
 * refusal, because the link may still be visible. Empty when the CSS only uses what the check
 * models, or when no CSS can reach the link.
 *
 * Only the link and its ancestors count. Every anchor to the URL is considered — a first anchor
 * hidden by the modelled CSS must not mask a later usable one. A rule reaches them when its simple
 * selector matches one of them, or — for a selector the check cannot parse — when its subject (the
 * rightmost compound) could match one. Selectors whose subject plainly names another element stay
 * silent, so unrelated footer or sidebar CSS does not warn. Inline styles on that same path count
 * too, with CSS comments stripped first as in a stylesheet.
 */
export function unsubscribeCssConstructs(html: string, url: string): string[] {
  const wanted = url.trim();
  if (!wanted) return [];
  const elements = unsubscribeLinkElements(html, wanted);
  if (elements.length === 0) return [];
  const constructs = new Set<string>();
  const css = styleText(html, () => false);
  if (css !== null) collectCssConstructs(css, elements, constructs);
  for (const el of elements) {
    const style = el.attribs.style;
    if (style !== undefined) inspectDeclarations(parseDeclarations(stripCssComments(style)), constructs);
  }
  return [...constructs].slice(0, MAX_CSS_CONSTRUCTS);
}

/** The author-facing warning for constructs `unsubscribeCssConstructs` found. */
export function unsubscribeCssWarningMessage(constructs: readonly string[]): string {
  const list = constructs.map((c) => `\`${c}\``).join(', ');
  return `The unsubscribe link's visibility depends on CSS we can't evaluate (${list}): check it in a client preview.`;
}

/**
 * The link and the ancestors of every anchor to the unsubscribe URL, deduplicated. A shared parent
 * is visited once: walking up from each anchor stops at an element already collected, whose own
 * ancestors are already there, so many matching anchors stay linear in the document.
 */
function unsubscribeLinkElements(html: string, wanted: string): ElementInfo[] {
  const stack: ElementInfo[] = [];
  const included = new Set<ElementInfo>();
  const elements: ElementInfo[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        stack.push(element(name, attribs));
        if (name !== 'a' || attribs.href === undefined || attribs.href.trim() !== wanted) return;
        for (let i = stack.length - 1; i >= 0; i--) {
          const el = stack[i]!;
          if (included.has(el)) break;
          included.add(el);
          elements.push(el);
        }
      },
      onclosetag(name) {
        let i = stack.length - 1;
        while (i >= 0 && stack[i]!.name !== name) i--;
        if (i >= 0) stack.length = i;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return elements;
}

/**
 * Linear scan of a stylesheet: each style rule is judged by whether its selector can reach the
 * link, and at-rule blocks are descended (not skipped) so a rule inside `@media` still counts.
 * Style-rule bodies are skipped after one pass, so nested at-rules stay linear. A statement at-rule
 * such as `@import` is not a rule we can attribute to one element, and imported font styles are
 * ordinary in e-mail, so it is left to the stated external-stylesheet limit rather than warned on.
 */
function collectCssConstructs(css: string, path: ElementInfo[], out: Set<string>): void {
  const text = stripCssComments(css);
  const atRules: string[] = [];
  const compoundCount = new Map<string, number>();
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '{') {
      const prelude = text.slice(start, i).trim();
      if (prelude.startsWith('@')) {
        atRules.push(atRuleName(prelude));
        i++;
        start = i;
        continue;
      }
      const end = blockEnd(text, i);
      const body = text.slice(i + 1, text[end - 1] === '}' ? end - 1 : end);
      const declarations = parseDeclarations(body);
      const relevant = [...declarations].filter(([name]) => CSS_VISIBILITY_PROPERTIES.has(name));
      if (relevant.length > 0) {
        const selectors = splitTopLevel(prelude, ',');
        const reaches = selectors.map((selector) => selectorReaches(selector, path));
        if (reaches.some(Boolean)) {
          // An at-rule or a selector the check cannot parse only matters when the rule could hide
          // the link. MJML's own responsive CSS sets `max-width:100%` inside @media on a column
          // ancestor, which must not warn on every template.
          if ([...declarations].some(([name, declaration]) => declarationCouldHide(name, declaration.value))) {
            if (atRules.length > 0) {
              out.add(atRules[0]!);
              const innermost = atRules[atRules.length - 1]!;
              if (innermost !== atRules[0]) out.add(innermost);
            }
            selectors.forEach((selector, index) => {
              if (reaches[index]) addSelectorConstructs(selector, out);
            });
          }
          for (const [name, declaration] of relevant) addValueConstructs(name, declaration.value, out);
        }
        // Mirror the refusal's per-kind cap: a compound selector past it is dropped, so if it could
        // have matched the link the check cannot say what the cascade would do. Rules inside an
        // at-rule never reach the refusal's buckets, so they do not consume a slot.
        if (atRules.length === 0) {
          for (const [name] of declarations) {
            if (!MODELLED_PROPERTIES.has(name)) continue;
            selectors.forEach((selector, index) => {
              const simple = parseSimpleSelector(selector);
              if (simple === null || !isCompoundSelector(simple)) return;
              const count = compoundCount.get(name) ?? 0;
              if (count < MAX_COMPOUND_RULES) compoundCount.set(name, count + 1);
              else if (reaches[index]) out.add('rule cap');
            });
          }
        }
      }
      i = end;
      start = i;
      continue;
    }
    if (ch === '}') {
      if (atRules.length > 0) atRules.pop();
      i++;
      start = i;
      continue;
    }
    if (ch === ';') {
      i++;
      start = i;
      continue;
    }
    i++;
  }
}

/** The index just past the `}` that closes the block opened at `open`. */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** The at-keyword of a prelude: `@media screen` and `@media(max-width:…` both give `@media`. */
function atRuleName(prelude: string): string {
  if (!prelude.startsWith('@')) return '';
  let i = 1;
  while (i < prelude.length) {
    const ch = prelude[i]!;
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '-') i++;
    else break;
  }
  return prelude.slice(0, i).toLowerCase();
}

/** Split a selector list on commas that are not inside brackets, parentheses or quotes. */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if ((ch === ']' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && ch === separator) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

/** The compounds of one complex selector, in order; the last one is the subject. */
function selectorCompounds(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if ((ch === ']' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && (ch === '>' || ch === '+' || ch === '~' || isSpace(ch))) {
      if (i > start) parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (selector.length > start) parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * Whether a rule's selector could select the link or one of its ancestors. A selector the check
 * models is matched exactly. Otherwise the subject decides: a `.unrelated .promo` rule cannot reach
 * the link, while `a:hover` (subject `a`) can. When the subject names nothing at all (`:hover`,
 * `*`, `[data-x]`), it could match, so it counts.
 */
function selectorReaches(selector: string, path: ElementInfo[]): boolean {
  // A CSS escape can spell any tag, class or id (`.foot\65 r` is `.footer`). The warning scan does
  // not decode escapes, so an escaped selector could reach the link and must be reported.
  if (selector.includes('\\')) return true;
  const simple = parseSimpleSelector(selector);
  if (simple !== null) return path.some((el) => selectorMatches(simple, el));
  const compounds = selectorCompounds(selector);
  const subject = compounds[compounds.length - 1];
  if (subject === undefined) return true;
  const { tag, id, classes } = compoundTokens(subject);
  if (tag === null && id === null && classes.length === 0) return true;
  return path.some(
    (el) => (tag === null || tag === el.name) && (id === null || id === el.id) && classes.every((name) => el.classes.has(name)),
  );
}

/** A compound selector's tag, id and classes, ignoring attributes and pseudo-classes. */
function compoundTokens(compound: string): { tag: string | null; id: string | null; classes: string[] } {
  let tag: string | null = null;
  let id: string | null = null;
  const classes: string[] = [];
  let i = 0;
  if (compound[0] !== '*' && compound[0] !== '.' && compound[0] !== '#' && compound[0] !== ':' && compound[0] !== '[') {
    let j = 0;
    while (j < compound.length && isSelectorName(compound[j]!)) j++;
    if (j > 0) tag = compound.slice(0, j).toLowerCase();
    i = j;
  }
  while (i < compound.length) {
    const ch = compound[i]!;
    if (ch === '.' || ch === '#') {
      let j = i + 1;
      while (j < compound.length && isSelectorName(compound[j]!)) j++;
      const name = compound.slice(i + 1, j);
      if (name) {
        if (ch === '.') classes.push(name);
        else id = name;
      }
      i = j;
      continue;
    }
    if (ch === '[') {
      i = skipBalanced(compound, i, '[', ']');
      continue;
    }
    if (ch === ':') {
      i++;
      if (compound[i] === ':') i++;
      while (i < compound.length && isSelectorName(compound[i]!)) i++;
      if (compound[i] === '(') i = skipBalanced(compound, i, '(', ')');
      continue;
    }
    i++;
  }
  return { tag, id, classes };
}

function isSelectorName(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_';
}

/** The index just past the closer matching the opener at `open`. */
function skipBalanced(value: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return value.length;
}

/** Whether a complex selector has a top-level combinator (descendant, child, sibling). */
function hasTopLevelCombinator(selector: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if ((ch === ']' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && (ch === '>' || ch === '+' || ch === '~' || isSpace(ch))) return true;
  }
  return false;
}

/** Names the selector features the check does not model; a simple selector adds nothing. */
function addSelectorConstructs(selector: string, out: Set<string>): void {
  let named = false;
  if (selector.includes('\\')) {
    out.add('escaped selector');
    named = true;
  }
  if (parseSimpleSelector(selector) !== null) return;
  if (hasTopLevelCombinator(selector)) {
    out.add('combinator');
    named = true;
  }
  if (selector.includes('[')) {
    out.add('attribute selector');
    named = true;
  }
  if (selector.includes(':')) {
    out.add('pseudo-class');
    named = true;
  }
  if (!named) out.add('complex selector');
}

/** Whether one declaration could take the link out of view on its own (or through an unsupported value). */
function declarationCouldHide(property: string, raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (hasValueConstruct(property, value)) return true;
  switch (property) {
    case 'display':
      return value === 'none';
    case 'visibility':
      return value === 'hidden' || value === 'collapse';
    case 'opacity':
    case 'font-size':
    case 'width':
    case 'height':
    case 'max-height':
    case 'max-width':
      return isZero(value);
    case 'mso-hide':
      return value === 'all';
    case 'color':
    case 'background':
    case 'background-image':
      return true;
    case 'clip':
      return value !== 'auto';
    case 'clip-path':
      return value !== 'none';
    case 'left':
    case 'right':
    case 'top':
    case 'bottom':
    case 'text-indent': {
      const px = lengthPx(value);
      return px !== null && px <= -1000;
    }
    default:
      return false;
  }
}

/** Whether a value contains a construct `addValueConstructs` reports. */
function hasValueConstruct(property: string, value: string): boolean {
  const found = new Set<string>();
  addValueConstructs(property, value, found);
  return found.size > 0;
}

/** One declaration's unsupported construct, when it can decide the link's visibility. */
function addValueConstructs(property: string, raw: string, out: Set<string>): void {
  const value = raw.toLowerCase();
  if (hasCssFunction(value, 'hsl') || hasCssFunction(value, 'hsla')) out.add('hsl()');
  for (const name of OTHER_COLOUR_FUNCTIONS) {
    if (hasCssFunction(value, name)) out.add(`${name}()`);
  }
  if (property === 'background' || property === 'background-image') {
    if (value.includes('gradient(')) out.add('gradient');
    if (hasCssFunction(value, 'url') || hasCssFunction(value, 'image') || hasCssFunction(value, 'image-set')) out.add('image');
  }
  if (property === 'transform' || property === '-webkit-transform') out.add('transform');
  if (OFFSET_PROPERTIES.has(property) && hasRelativeLength(value)) out.add('relative offset');
  if (hasCssFunction(value, 'calc') || hasCssFunction(value, 'clamp') || hasCssFunction(value, 'min') || hasCssFunction(value, 'max'))
    out.add('calc()');
  if (property === 'clip') {
    const clip = value.trim();
    if (clip !== 'auto' && !zeroRect(clip)) out.add('clip');
  }
  if (property === 'clip-path') {
    const clip = value.trim();
    if (clip !== 'none' && !zeroClipPath(clip)) out.add('clip-path');
  }
}

/** A CSS function call by name, with a boundary so `hsl` does not match inside another word. */
function hasCssFunction(value: string, name: string): boolean {
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const at = value.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : value[at - 1]!;
    if (!((before >= 'a' && before <= 'z') || (before >= '0' && before <= '9') || before === '-' || before === '_')) return true;
    from = at + needle.length;
  }
}

/** Whether a value contains a number with a percent or font-relative unit. */
function hasRelativeLength(value: string): boolean {
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '.' || (ch >= '0' && ch <= '9')) {
      while (i < value.length && ((value[i]! >= '0' && value[i]! <= '9') || value[i] === '.')) i++;
      if (value[i] === '%') return true;
      let j = i;
      while (j < value.length && value[j]! >= 'a' && value[j]! <= 'z') j++;
      if (j > i && RELATIVE_UNITS.has(value.slice(i, j))) return true;
      i = j;
      continue;
    }
    i++;
  }
  return false;
}

/** Whether a parsed simple selector is a compound (not one of the single tag/id/class buckets). */
function isCompoundSelector(selector: HideSelector): boolean {
  if (selector.tag === null && selector.id === null && selector.classes.length === 1) return false;
  if (selector.tag === null && selector.id !== null && selector.idCount === 1 && selector.classes.length === 0) return false;
  if (selector.tag !== null && selector.id === null && selector.classes.length === 0) return false;
  return true;
}

/** The constructs of one element's inline declarations. */
function inspectDeclarations(declarations: Map<string, Declaration>, out: Set<string>): void {
  for (const [name, declaration] of declarations) {
    if (!CSS_VISIBILITY_PROPERTIES.has(name)) continue;
    addValueConstructs(name, declaration.value, out);
  }
}

/** The author-facing reason, shared by the save validator and the publish gate. */
export function unsubscribeProblemMessage(problem: UnsubscribeLinkProblem): string {
  if (problem === 'hidden')
    return 'The unsubscribe link is hidden, so readers cannot see or click it. Make it a visible link in the message body.';
  if (problem === 'too_complex')
    return `The e-mail is too complex to check the unsubscribe link (more than ${MAX_UNSUBSCRIBE_NESTING} nested levels, or more than ${MAX_UNSUBSCRIBE_CHECK_MS / 1000} second of checking). Simplify the layout or its styles.`;
  if (problem === 'empty')
    return 'The unsubscribe link has no text, so readers cannot see it. Give it a few words, or an image with alt text.';
  return 'A marketing e-mail must contain an unsubscribe link, and this one does not.';
}
