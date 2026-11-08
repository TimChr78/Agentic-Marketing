import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// A durable sweep guard (#530): every visible control that submits a form, switches data or calls
// a mutating handler is marked `mutation`, so the demo capability context can disable it. New
// submit buttons, switches, menu actions and icon buttons fail this test until they are marked.

const ROOT = join(process.cwd(), 'apps/web/src');

/** Real signed-in surfaces the demo never renders; their forms are not demo controls. */
const ALLOWED_FILES = new Set(['app/SignIn.tsx', 'app/ForgotPassword.tsx', 'app/ResetPassword.tsx']);

/**
 * Read-only submit controls, scoped to their exact control rather than a file-wide name: only the
 * person lookup in Consent and the People search are exempt, not every button that happens to use
 * the same loading flag.
 */
const ALLOWED_CONTROLS: { file: string; control: RegExp }[] = [
  { file: 'pages/audience/ConsentPage.tsx', control: /<Button type="submit" loading=\{lookingUp\}/ },
  { file: 'pages/audience/PeoplePage.tsx', control: /<Button size="sm" type="submit" loading=\{searching\}/ },
];

const MUTATING_HANDLER =
  /\b(save|submit|create|remove|delete|archive|rename|approve|reject|invite|import|connect|revoke|erase|erasePerson|record|upload|install|rotate|discard|publish|openPublish|refreshSnapshot|toBrief|sendTest|setRole|setAutonomy|pause|resume|runNow|test)\b/;

const MUTATING_SWITCH = /(\btoggle\b|onToggle|void\s+toggle\s*\()/;

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(path);
  }
  return out;
}

interface Tag {
  text: string;
  line: number;
}

/** Opening JSX tags for one element name, ignoring `>` inside braces, strings and arrows. */
function tags(source: string, name: string): Tag[] {
  const out: Tag[] = [];
  for (let start = source.indexOf(`<${name}`); start >= 0; start = source.indexOf(`<${name}`, start + 1)) {
    const after = source[start + name.length + 1];
    if (after && !/[\s/>]/.test(after)) continue;
    let depth = 0;
    let quote: string | null = null;
    let index = start + name.length + 1;
    for (; index < source.length; index++) {
      const ch = source[index]!;
      if (quote) {
        if (ch === quote && source[index - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    out.push({ text: source.slice(start, index + 1), line: source.slice(0, start).split('\n').length });
  }
  return out;
}

/** The value of one JSX prop, following balanced braces. */
function prop(tag: string, name: string): string | null {
  const marker = `${name}={`;
  const start = tag.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start + marker.length - 1; index < tag.length; index++) {
    const ch = tag[index]!;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return tag.slice(start + marker.length, index);
    }
  }
  return null;
}

/** Object literals that define a menu action (`onSelect`), expanded with balanced braces. */
function menuActions(source: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (let at = source.indexOf('onSelect:'); at >= 0; at = source.indexOf('onSelect:', at + 1)) {
    let open = at;
    let depth = 0;
    for (; open >= 0; open--) {
      if (source[open] === '}') depth++;
      else if (source[open] === '{') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (open < 0) continue;
    let close = at;
    depth = 0;
    for (; close < source.length; close++) {
      if (source[close] === '{') depth++;
      else if (source[close] === '}') {
        if (depth === 0) break;
        depth--;
      }
    }
    out.push({ text: source.slice(open, close + 1), line: source.slice(0, at).split('\n').length });
  }
  return out;
}

function failures(): string[] {
  const problems: string[] = [];
  for (const path of walk(ROOT)) {
    const file = relative(ROOT, path);
    if (ALLOWED_FILES.has(file)) continue;
    const source = readFileSync(path, 'utf8');
    const allowed = (text: string) => ALLOWED_CONTROLS.some((row) => row.file === file && row.control.test(text));

    for (const name of ['Button', 'IconButton', 'Switch']) {
      for (const tag of tags(source, name)) {
        if (/mutation=\{false\}/.test(tag.text)) {
          if (!allowed(tag.text)) problems.push(`${file}:${tag.line}: mutation={false} is not allowed\n  ${tag.text.replace(/\s+/g, ' ')}`);
          continue;
        }
        if (/\bmutation\b/.test(tag.text)) continue;
        const submit = /type="submit"/.test(tag.text) || /\bform="/.test(tag.text);
        const handler = prop(tag.text, name === 'Switch' ? 'onChange' : 'onClick');
        const mutating = handler !== null && (name === 'Switch' ? MUTATING_SWITCH.test(handler) : MUTATING_HANDLER.test(handler));
        if (!submit && !mutating) continue;
        if (allowed(tag.text)) continue;
        problems.push(`${file}:${tag.line}: mark this ${name} with mutation\n  ${tag.text.replace(/\s+/g, ' ').slice(0, 180)}`);
      }
    }

    // Native buttons: visible submits and mutating onClick handlers. Menu items are governed by the
    // MenuItem object below, so their native button is not checked here.
    for (const tag of tags(source, 'button')) {
      if (/\bhidden\b/.test(tag.text) || /role="menuitem"/.test(tag.text)) continue;
      const handler = prop(tag.text, 'onClick');
      const mutating = handler !== null && MUTATING_HANDLER.test(handler);
      if (!/type="submit"/.test(tag.text) && !mutating) continue;
      problems.push(`${file}:${tag.line}: visible native button without mutation\n  ${tag.text.replace(/\s+/g, ' ').slice(0, 180)}`);
    }

    // Menu actions are data objects, so the flag lives on the item, not the rendered button.
    for (const action of menuActions(source)) {
      if (!MUTATING_HANDLER.test(action.text)) continue;
      if (/mutation\s*:\s*true/.test(action.text)) continue;
      problems.push(`${file}:${action.line}: mark this menu action with mutation\n  ${action.text.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
  return problems;
}

describe('demo mutation sweep (#530)', () => {
  it('marks every visible submit, switch, menu action and mutating control with mutation', () => {
    expect(failures()).toEqual([]);
  });
});
