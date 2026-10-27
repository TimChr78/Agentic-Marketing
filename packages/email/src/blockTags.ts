// Parsing and shaping for {% block 'blk_…', key: value %}. Kept free of Liquid and MJML so the
// renderer, the publish checks and the usage lookup share one definition of where a block is.

export const BLOCK_ID = /^blk_[0-9a-f]{32}$/;

/** Block ids a template (or block) refers to, in the order they first appear. */
export function blockIdsIn(source: string): string[] {
  const ids = new Set<string>();
  for (const match of source.matchAll(/{%-?\s*block\s+(['"])(blk_[0-9a-f]{32})\1/g)) ids.add(match[2]);
  return [...ids];
}

/** A fragment must not include another block in v1; checked when saving and when rendering. */
export const usesBlockTag = (source: string) => /{%-?\s*block\s/.test(source);

export interface ParsedBlockTag {
  id: string;
  /** The `key: value, …` part, ready for liquidjs' Hash parser; null when there are no parameters. */
  params: string | null;
}

/** Splits `'blk_…', title: 'x'` into the block id and the parameter list. */
export function parseBlockTagArgs(args: string): ParsedBlockTag {
  const match = /^\s*(['"])(blk_[0-9a-f]{32})\1\s*(?:,\s*([\s\S]*))?$/.exec(args);
  if (!match) throw new Error("Use {% block 'blk_…', key: value %} with a quoted block id");
  return { id: match[2], params: match[3]?.trim() || null };
}

/** URL parameters must be http(s) or one of our asset links; anything else could be javascript:. */
export function isAllowedBlockUrl(value: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(value) || /^\/a\/ast_[0-9a-f]{32}\/[A-Za-z0-9._-]+$/.test(value);
}

/**
 * A block is a fragment, so preview and publish wrap it in the smallest valid document. Sections
 * go straight into the body; a column-only or content-only fragment gets the section/column it
 * needs, so simple blocks are not rejected for shape alone.
 */
export function wrapMjmlFragment(fragment: string): string {
  const body = fragment.trim();
  if (/^<mj-section[\s>]/i.test(body)) return `<mjml><mj-body>${body}</mj-body></mjml>`;
  if (/^<mj-column[\s>]/i.test(body)) return `<mjml><mj-body><mj-section>${body}</mj-section></mj-body></mjml>`;
  return `<mjml><mj-body><mj-section><mj-column>${body}</mj-column></mj-section></mj-body></mjml>`;
}
