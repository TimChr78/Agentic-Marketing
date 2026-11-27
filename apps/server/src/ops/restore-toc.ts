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
 * The scan is linear and compares the schema field and the name exactly. pg_restore prints the
 * namespace and the tag unquoted, so a space in either one is indistinguishable from the separator;
 * the fields are therefore split by position (empty fields kept) rather than on runs of spaces. That
 * ambiguity is inherent to the unquoted TOC tag: a schema named `public ` and a table named
 * ` restore_fence` both print as `TABLE public  restore_fence`. Only the exact schema `public` with
 * the exact name is the fence, and a table-qualified entry is matched against the tables the archive
 * itself names, longest name first, so the object of `public."restore_fence legacy"` stays.
 *
 * A line whose description this filter does not know is left alone: it cannot be one of the entries
 * that drop or refill the fence, and dropping a line it cannot read could remove an unrelated
 * object.
 */

const FENCE_SCHEMA = 'public';
const FENCE_NAME = 'restore_fence';

/**
 * Descriptions whose tag is the object's own name within the schema. Indexes, statistics and the
 * sequence named by `SEQUENCE OWNED BY` are schema-scoped objects, not table-qualified: their tag
 * is their own name, even when the object belongs to the fence's table.
 */
const SELF_NAMED = new Set([
  'TABLE',
  'TABLE DATA',
  'SEQUENCE',
  'SEQUENCE SET',
  'SEQUENCE OWNED BY',
  'VIEW',
  'MATERIALIZED VIEW',
  'MATERIALIZED VIEW DATA',
  'FOREIGN TABLE',
  'INDEX',
  'INDEX ATTACH',
  'STATISTICS',
]);

/** Descriptions whose tag begins with the owning table's name, followed by the object's own. */
const TABLE_QUALIFIED = new Set([
  'CONSTRAINT',
  'CHECK CONSTRAINT',
  'FK CONSTRAINT',
  'TRIGGER',
  'RULE',
  'POLICY',
  'ROW SECURITY',
  'DEFAULT',
]);

/** Descriptions whose tag is `<object type> <target>`, as for a comment or an ACL. */
const TARGET_NAMED = new Set(['COMMENT', 'ACL']);

/** Every description the scan can read. Longer descriptions are matched first. */
const DESCRIPTIONS = [...SELF_NAMED, ...TABLE_QUALIFIED, ...TARGET_NAMED].sort((a, b) => b.split(' ').length - a.split(' ').length);

interface TocEntry {
  description: string;
  schema: string;
  /** The tag's fields, without the owner. A space inside a name is kept as an empty field. */
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
  if (line.charAt(semicolon + 1) !== ' ') return null;
  // `<tableoid> <oid> <description> <schema> <tag> <owner>`, single-space separated and printed by
  // pg_restore with no quoting, so empty fields are kept: they are part of a name, not padding.
  const fields = line.slice(semicolon + 2).split(' ');
  // `<tableoid> <oid>` come before the description; the owner is the last field, and the tag sits
  // between the schema and the owner.
  if (fields.length < 6) return null;
  for (const description of DESCRIPTIONS) {
    const length = description.split(' ').length;
    if (fields.length < 3 + length + 2) continue;
    if (fields.slice(2, 2 + length).join(' ') !== description) continue;
    const schema = fields[2 + length] ?? '';
    const tag = fields.slice(3 + length, fields.length - 1);
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

/**
 * The table a tag is qualified by, using the table names the archive itself names. The longest
 * match wins, so `restore_fence legacy …` belongs to `restore_fence legacy`, not to `restore_fence`.
 * Without a known table the first field is the best reading (the unquoted tag cannot do better).
 */
function qualifiedTable(tag: string[], tables: Set<string>): string | null {
  const text = tag.join(' ');
  let longest: string | null = null;
  for (const table of tables) {
    if (text !== table && !text.startsWith(`${table} `)) continue;
    if (longest === null || table.length > longest.length) longest = table;
  }
  return longest ?? tag[0] ?? null;
}

/** True when the entry is the fence table or one of its own objects. */
function belongsToFence(entry: TocEntry, tables: Set<string>): boolean {
  if (entry.schema !== FENCE_SCHEMA) return false;
  if (SELF_NAMED.has(entry.description)) return entry.tag.join(' ') === FENCE_NAME;
  if (TABLE_QUALIFIED.has(entry.description)) return qualifiedTable(entry.tag, tables) === FENCE_NAME;
  if (TARGET_NAMED.has(entry.description)) return targetsFenceTable(entry.tag);
  return false;
}

/**
 * Returns `toc` without the entries that name `public.restore_fence`, ready for `pg_restore
 * --use-list`. Every other line, including the archive header, is kept exactly as it was.
 */
export function filterRestoreFenceEntries(toc: string): string {
  const lines = toc.split('\n');
  const entries = lines.map(parseTocEntry);
  // The archive names its own tables, which is what resolves a table-qualified tag: the tag is
  // unquoted, so it cannot say where the table name ends on its own.
  const tables = new Set<string>();
  for (const entry of entries) {
    if (entry?.description === 'TABLE' && entry.schema === FENCE_SCHEMA) tables.add(entry.tag.join(' '));
  }
  return lines
    .filter((_, index) => {
      const entry = entries[index] ?? null;
      return entry === null || !belongsToFence(entry, tables);
    })
    .join('\n');
}
