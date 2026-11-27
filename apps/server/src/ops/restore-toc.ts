/**
 * The `pg_restore --list` table of contents without `public.restore_fence`.
 *
 * `am restore` loads a backup with `pg_restore --clean`, which drops every object the archive names
 * before copying it. Dumps this build writes exclude the fence table, but a dump written by an
 * older build against the same schema still names it, so a plain load would drop the row this
 * attempt raised or copy the dump's own row over it. `pg_restore` has no `--exclude-table`; the
 * supported way to keep entries out of a load is `--use-list`, so the restore reads the table of
 * contents, removes every entry that belongs to the table, and loads with the filtered list (#1194
 * review).
 *
 * The scan is linear and compares the schema and name fields exactly. A line whose description this
 * filter does not know is left alone: it cannot be one of the entries that drop or refill the fence,
 * and dropping a line it cannot read could remove an unrelated object.
 */

const FENCE_SCHEMA = 'public';
const FENCE_NAME = 'restore_fence';

/** Descriptions whose tag is the object's own name. */
const SELF_NAMED = new Set([
  'TABLE',
  'TABLE DATA',
  'SEQUENCE',
  'SEQUENCE SET',
  'VIEW',
  'MATERIALIZED VIEW',
  'MATERIALIZED VIEW DATA',
  'FOREIGN TABLE',
]);

/** Descriptions whose tag begins with the owning table's name. */
const TABLE_QUALIFIED = new Set([
  'CONSTRAINT',
  'CHECK CONSTRAINT',
  'FK CONSTRAINT',
  'INDEX',
  'INDEX ATTACH',
  'TRIGGER',
  'RULE',
  'POLICY',
  'ROW SECURITY',
  'DEFAULT',
  'STATISTICS',
  'SEQUENCE OWNED BY',
]);

/** Descriptions whose tag is `<object type> <target>`, as for a comment or an ACL. */
const TARGET_NAMED = new Set(['COMMENT', 'ACL']);

/** Every description the scan can read. Longer descriptions are matched first. */
const DESCRIPTIONS = [...SELF_NAMED, ...TABLE_QUALIFIED, ...TARGET_NAMED].sort((a, b) => b.split(' ').length - a.split(' ').length);

interface TocEntry {
  description: string;
  schema: string;
  /** The tag's tokens, without the owner. */
  tag: string[];
}

/** True when every character is an ASCII digit; the dump id in front of the first `;`. */
function isDumpId(text: string): boolean {
  if (text.length === 0) return false;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** The fields of one TOC line, or null for a comment/blank line or a description this build does not know. */
function parseTocEntry(line: string): TocEntry | null {
  const semicolon = line.indexOf(';');
  if (semicolon < 0 || !isDumpId(line.slice(0, semicolon).trim())) return null;
  const tokens = line
    .slice(semicolon + 1)
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
  // `<tableoid> <oid>` come before the description; the owner is the last field, and the tag sits
  // between the schema and the owner.
  if (tokens.length < 6) return null;
  for (const description of DESCRIPTIONS) {
    const length = description.split(' ').length;
    if (tokens.length < 3 + length + 2) continue;
    if (tokens.slice(2, 2 + length).join(' ') !== description) continue;
    const schema = tokens[2 + length] ?? '';
    const tag = tokens.slice(3 + length, tokens.length - 1);
    if (tag.length === 0) return null;
    return { description, schema, tag };
  }
  return null;
}

/** True when a comment's or ACL's target is the fence table itself, not one of its objects. */
function targetsFenceTable(tag: string[]): boolean {
  const type = tag[0];
  const rest = tag.slice(1);
  if (type === 'TABLE') return rest.join(' ') === FENCE_NAME;
  if (type === 'COLUMN') {
    const target = rest.join(' ');
    const dot = target.lastIndexOf('.');
    return dot > 0 && target.slice(0, dot) === FENCE_NAME;
  }
  // A comment on a constraint, index, trigger or rule names that object and then `ON <table>`.
  const on = rest.indexOf('ON');
  return on >= 0 && rest.slice(on + 1).join(' ') === FENCE_NAME;
}

/** True when the entry is the fence table or one of its own objects. */
function belongsToFence(entry: TocEntry): boolean {
  if (entry.schema !== FENCE_SCHEMA) return false;
  if (SELF_NAMED.has(entry.description)) return entry.tag.join(' ') === FENCE_NAME;
  if (TABLE_QUALIFIED.has(entry.description)) return entry.tag[0] === FENCE_NAME;
  if (TARGET_NAMED.has(entry.description)) return targetsFenceTable(entry.tag);
  return false;
}

/**
 * Returns `toc` without the entries that name `public.restore_fence`, ready for `pg_restore
 * --use-list`. Every other line, including the archive header, is kept exactly as it was.
 */
export function filterRestoreFenceEntries(toc: string): string {
  return toc
    .split('\n')
    .filter((line) => {
      const entry = parseTocEntry(line);
      return entry === null || !belongsToFence(entry);
    })
    .join('\n');
}
