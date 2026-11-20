// The sanitiser released before #1132, kept verbatim as a differential baseline: whatever it
// removed must stay removed. It is a denylist (scripts, frames, forms, event handlers) and is not
// safe to use; only tests import it.

const DROP = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'NOSCRIPT', 'TEMPLATE']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'srcset']);
const BAD_SCHEME = /^(javascript|vbscript|data):(?!image\/(png|gif|jpe?g|webp);)/;
const BAD_STYLE = /expression|url\(\s*['"]?javascript:/i;

/** The old denylist sanitizer, exactly as shipped before #1132. */
export function sanitizeOld(html: string, doc: Document): DocumentFragment {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const walk = (node: Element | DocumentFragment) => {
    for (const el of Array.from(node.children)) {
      if (DROP.has(el.tagName.toUpperCase())) {
        el.remove();
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase();
        const value = [...a.value]
          .filter((ch) => ch.charCodeAt(0) > 0x20)
          .join('')
          .toLowerCase();
        const handler = name.startsWith('on');
        const badStyle = name === 'style' && BAD_STYLE.test(a.value);
        const badUrl = URL_ATTRS.has(name) && BAD_SCHEME.test(value);
        if (handler || badStyle || badUrl) el.removeAttribute(a.name);
      }
      walk(el);
    }
  };
  walk(tpl.content);
  return tpl.content;
}

export interface OldRemovals {
  /** Element tags the old sanitizer dropped wherever they appeared. */
  tags: Set<string>;
  /** Attribute values it removed, verbatim, so the new output must not contain them. */
  values: string[];
}

/** What the old sanitizer would remove from `html`: its baseline for the differential test. */
export function oldRemovals(html: string, doc: Document): OldRemovals {
  const tpl = doc.createElement('template');
  tpl.innerHTML = html;
  const tags = new Set<string>();
  const values: string[] = [];
  const walk = (node: Element | DocumentFragment) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toUpperCase();
      if (DROP.has(tag)) {
        tags.add(tag);
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        const name = a.name.toLowerCase();
        const value = [...a.value]
          .filter((ch) => ch.charCodeAt(0) > 0x20)
          .join('')
          .toLowerCase();
        if (name.startsWith('on') || (name === 'style' && BAD_STYLE.test(a.value)) || (URL_ATTRS.has(name) && BAD_SCHEME.test(value)))
          values.push(a.value);
      }
      walk(el);
    }
  };
  walk(tpl.content);
  return { tags, values };
}
