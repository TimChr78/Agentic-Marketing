// Personalization for sdk-js: ask the decision API what each placement shows, render it, and
// report exposures. Content comes from the workspace (people and agents), so HTML is sanitised
// before it touches the page.

export interface Decision {
  placement: string;
  experienceId: string;
  version: number;
  variantId: string;
  content: { html?: string; json?: Record<string, unknown> } | null;
  trigger: { type: 'immediate' | 'exit_intent' | 'scroll' | 'time_on_page'; value?: number };
  /** Shown because of a preview link (?am_preview=…); not reported as a view. */
  preview?: boolean;
}

/**
 * Put this in the <head>, before other scripts: it hides placements until `personalize()` has
 * rendered them, for at most `ms`, so visitors don't see default content flash and change.
 */
export const antiFlickerSnippet = (ms = 500) =>
  `<style>.am-loading [data-am-placement]{visibility:hidden}</style><script>document.documentElement.classList.add('am-loading');setTimeout(function(){document.documentElement.classList.remove('am-loading')},${ms})</script>`;

// An allowlist, not a denylist (#1132): a denylist always misses the next construct — SVG SMIL
// <set>, <style>, a second srcset candidate — so only markup that is known to be inert is kept.
// No svg, math, style, script, frame, form or template element, and no event handler attribute.
const ALLOWED_TAGS = new Set([
  'A',
  'ABBR',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CAPTION',
  'CITE',
  'CODE',
  'COL',
  'COLGROUP',
  'DD',
  'DEL',
  'DIV',
  'DL',
  'DT',
  'EM',
  'FIGCAPTION',
  'FIGURE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'I',
  'IMG',
  'INS',
  'KBD',
  'LI',
  'MARK',
  'OL',
  'P',
  'PRE',
  'Q',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TIME',
  'TR',
  'U',
  'UL',
]);
const GLOBAL_ATTRS = new Set(['class', 'id', 'title', 'role', 'dir', 'lang', 'hidden', 'style']);
const TAG_ATTRS: Record<string, readonly string[]> = {
  a: ['href', 'rel', 'target', 'type'],
  img: ['src', 'srcset', 'alt', 'width', 'height', 'loading', 'decoding'],
  ol: ['start', 'reversed', 'type'],
  li: ['value'],
  td: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  th: ['colspan', 'rowspan', 'headers', 'scope', 'abbr'],
  col: ['span', 'width'],
  colgroup: ['span', 'width'],
  time: ['datetime'],
};

const URL_ATTRS = new Set(['href', 'src']);
const SAFE_DATA = /^data:image\/(?:png|gif|jpe?g|webp);/;
const EXTERNAL_URL = /url\(\s*(?!['"]?\s*#)/i;

/** Browsers ignore whitespace and control characters inside a scheme ("java\tscript:"). */
const normalizeUrl = (value: string) =>
  [...value]
    .filter((ch) => ch.charCodeAt(0) > 0x20)
    .join('')
    .toLowerCase();

/** http(s), a relative URL, or a raster data: image; nothing that can run as script. */
function safeUrl(value: string): boolean {
  const v = normalizeUrl(value);
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v)?.[1];
  if (!scheme) return true;
  if (scheme === 'http' || scheme === 'https') return true;
  return scheme === 'data' && SAFE_DATA.test(v);
}

/** Every candidate is a URL of its own: a later candidate must not smuggle a script scheme past the first. */
function safeSrcset(value: string): boolean {
  return value.split(',').every((candidate) => {
    const url = candidate.trim().split(/\s+/)[0];
    return !!url && safeUrl(url);
  });
}

/** Inline CSS may style the element but not fetch anything, import a sheet or hide a value from this check. */
function unsafeStyle(css: string): boolean {
  return (
    /@/.test(css) ||
    /\\/.test(css) ||
    /expression\s*\(/i.test(css) ||
    /javascript:/i.test(css) ||
    /-moz-binding/i.test(css) ||
    EXTERNAL_URL.test(css)
  );
}

const allowedAttribute = (tag: string, name: string) =>
  name.startsWith('aria-') || GLOBAL_ATTRS.has(name) || (TAG_ATTRS[tag]?.includes(name) ?? false);

/** Removes everything outside a small allowlist of inert HTML tags and attributes. Needs a DOM. */
export function sanitize(html: string, doc: Document = document): DocumentFragment {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const walk = (node: Element | DocumentFragment) => {
    for (const el of Array.from(node.children)) {
      if (!ALLOWED_TAGS.has(el.tagName.toUpperCase())) {
        el.remove();
        continue;
      }
      const tag = el.tagName.toLowerCase();
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase();
        if (
          !allowedAttribute(tag, name) ||
          (name === 'style' && unsafeStyle(a.value)) ||
          (name === 'srcset' && !safeSrcset(a.value)) ||
          (URL_ATTRS.has(name) && !safeUrl(a.value))
        )
          el.removeAttribute(a.name);
      }
      walk(el);
    }
  };
  walk(tpl.content);
  return tpl.content;
}

export interface PersonalizeHost {
  decide(placements: string[]): Promise<Decision[]>;
  track(event: string, properties: Record<string, unknown>): void;
}

export interface PersonalizeOptions {
  /** Placements to ask for; default: every element with data-am-placement on the page. */
  placements?: string[];
  /** Show defaults after this long if the decision API is slow (ms). */
  timeout?: number;
  /** Called for every decision when it applies; render JSON content or placements without an element here. */
  onDecision?: (d: Decision, el: Element | null) => void;
  doc?: Document;
  win?: Window;
}

export async function personalize(host: PersonalizeHost, opts: PersonalizeOptions = {}): Promise<Decision[]> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const reveal = () => doc.documentElement.classList.remove('am-loading');
  const placements =
    opts.placements ?? Array.from(doc.querySelectorAll('[data-am-placement]')).map((e) => e.getAttribute('data-am-placement') ?? '');
  if (!placements.length) {
    reveal();
    return [];
  }
  let decisions: Decision[] = [];
  try {
    decisions = await Promise.race([
      host.decide(placements),
      new Promise<Decision[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), opts.timeout ?? 500)),
    ]);
  } catch {
    // Slow or failed: the page keeps its default content.
    reveal();
    return [];
  }

  const show = (d: Decision) => {
    const el = doc.querySelector(`[data-am-placement="${d.placement.replace(/"/g, '')}"]`);
    if (d.content?.html !== undefined && el) el.replaceChildren(sanitize(d.content.html, doc));
    opts.onDecision?.(d, el);
    if (!d.preview)
      host.track('Experience Viewed', {
        experience_id: d.experienceId,
        variant_id: d.variantId,
        version: d.version,
        placement: d.placement,
      });
  };

  for (const d of decisions) {
    // The control group sees the default content; that is its exposure.
    if (d.variantId === 'holdout') {
      host.track('Experience Viewed', { experience_id: d.experienceId, variant_id: 'holdout', version: d.version, placement: d.placement });
      continue;
    }
    const t = d.trigger ?? { type: 'immediate' };
    if (t.type === 'immediate') show(d);
    else if (t.type === 'time_on_page') setTimeout(() => show(d), (t.value ?? 10) * 1000);
    else if (t.type === 'exit_intent') {
      const onLeave = (e: MouseEvent) => {
        if (e.clientY > 0 || e.relatedTarget) return;
        doc.removeEventListener('mouseout', onLeave);
        show(d);
      };
      doc.addEventListener('mouseout', onLeave);
    } else if (t.type === 'scroll') {
      const onScroll = () => {
        const max = doc.documentElement.scrollHeight - win.innerHeight;
        if (max <= 0 || (win.scrollY / max) * 100 >= (t.value ?? 50)) {
          win.removeEventListener('scroll', onScroll);
          show(d);
        }
      };
      win.addEventListener('scroll', onScroll, { passive: true });
    }
  }
  reveal();
  return decisions;
}
