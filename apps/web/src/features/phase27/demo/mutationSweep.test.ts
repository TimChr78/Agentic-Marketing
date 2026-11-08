import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// A durable sweep guard (#530): every visible control that submits a form or calls a mutating
// handler is marked `mutation`, so the demo capability context can disable it. New submit buttons
// and new create/save/delete handlers fail this test until they are marked.

const ROOT = join(process.cwd(), 'apps/web/src');

/** Real signed-in surfaces the demo never renders; their forms are not demo controls. */
const ALLOWED_FILES = new Set(['app/SignIn.tsx', 'app/ForgotPassword.tsx', 'app/ResetPassword.tsx']);

/** Read-only submit forms: looking a person up and searching are not changes. */
const READ_ONLY_SUBMITS = [/loading=\{lookingUp\}/, /loading=\{searching\}/];

const MUTATING_HANDLER =
  /\b(save|submit|create|remove|delete|archive|rename|approve|reject|invite|import|connect|revoke|erase|erasePerson|record|upload|install|rotate|discard|publish|openPublish|refreshSnapshot|toBrief|sendTest|setRole|setAutonomy|pause|resume|runNow|test)\b/;

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

function failures(): string[] {
  const problems: string[] = [];
  for (const path of walk(ROOT)) {
    const file = relative(ROOT, path);
    if (ALLOWED_FILES.has(file)) continue;
    const source = readFileSync(path, 'utf8');
    for (const tag of tags(source, 'Button')) {
      if (/\bmutation\b/.test(tag.text)) continue;
      const submit = /type="submit"/.test(tag.text) || /\bform="/.test(tag.text);
      const handler = prop(tag.text, 'onClick');
      const mutating = handler !== null && MUTATING_HANDLER.test(handler);
      if (!submit && !mutating) continue;
      if (READ_ONLY_SUBMITS.some((pattern) => pattern.test(tag.text))) continue;
      problems.push(`${file}:${tag.line}: mark this control with mutation\n  ${tag.text.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    for (const tag of tags(source, 'button')) {
      if (/\bhidden\b/.test(tag.text)) continue;
      if (!/type="submit"/.test(tag.text)) continue;
      problems.push(`${file}:${tag.line}: visible native submit without mutation\n  ${tag.text.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
  }
  return problems;
}

describe('demo mutation sweep (#530)', () => {
  it('marks every visible submit and mutating button with mutation', () => {
    expect(failures()).toEqual([]);
  });
});
