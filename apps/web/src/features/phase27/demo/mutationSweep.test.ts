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
 * Read-only submit controls and async reads, scoped to their exact control rather than a file-wide
 * name: only the person lookup in Consent and the People search are exempt, not every button that
 * happens to use the same loading flag. A reload, a next page or a preview is a `void fn(…)` but
 * does not change data, so it is allowlisted here with the reason it is read-only.
 */
const ALLOWED_CONTROLS: { file: string; control: RegExp; reason: string }[] = [
  {
    file: 'app/Root.tsx',
    control: /<Button className="mt-4" onClick=\{\(\) => void signOut\(\)\}>/,
    reason: 'ends the session; changes no workspace data',
  },
  {
    file: 'pages/audience/ConsentPage.tsx',
    control: /<Button type="submit" loading=\{lookingUp\}/,
    reason: 'looks up one person; no write',
  },
  {
    file: 'pages/audience/PeoplePage.tsx',
    control: /<Button size="sm" type="submit" loading=\{searching\}/,
    reason: 'searches people; no write',
  },
  {
    file: 'features/agents/HostedAgentCard.tsx',
    control: /<Button loading=\{loadingMore\} onClick=\{\(\) => void loadMore\(\)\}>/,
    reason: 'loads the next page of runs; a read',
  },
  {
    file: 'features/agents/phase26/ActivityTab.tsx',
    control: /<Button loading=\{loadingMore\} onClick=\{\(\) => void loadMore\(\)\}>/,
    reason: 'loads the next page of activity; a read',
  },
  {
    file: 'features/artifacts/ArtifactDetailPage.tsx',
    control: /<Button onClick=\{\(\) => void art\.reload\(\)\}>/,
    reason: 'retries the detail read after an error',
  },
  {
    file: 'features/artifacts/SegmentEditor.tsx',
    control: /<Button size="sm" variant="secondary" loading=\{!!current\?\.loading\} onClick=\{\(\) => void estimateNow\(\)\}>/,
    reason: 'segments.preview: a size estimate, not a write',
  },
  {
    file: 'features/home/OnboardingChecklist.tsx',
    control: /<Button size="sm" variant="ghost" onClick=\{\(\) => void load\(\)\}>/,
    reason: 'reloads the checklist read',
  },
  {
    file: 'features/phase27/content/ContentList.tsx',
    control: /<Button onClick=\{\(\) => void list\.reload\(\)\}>/,
    reason: 'retries the list read',
  },
  {
    file: 'features/tokens/TokenDrawer.tsx',
    control: /<Button variant="ghost" disabled=\{!dirty\} onClick=\{\(\) => void t\.reload\(\)\}>/,
    reason: 'reloads the token read',
  },
  {
    file: 'pages/HomePage.tsx',
    control: /<Button variant="secondary".*onClick=\{\(\) => void home\.reload\(\)\}>/,
    reason: 'reloads the dashboard reads',
  },
  {
    file: 'pages/audience/PeoplePage.tsx',
    control: /<Button variant="secondary" onClick=\{\(\) => void retryFirst\(\)\}>/,
    reason: 'retries the first page read',
  },
  {
    file: 'pages/audience/PeoplePage.tsx',
    control: /<Button onClick=\{\(\) => void next\(\)\} loading=\{loadingPage\}/,
    reason: 'pages forward; a read',
  },
  {
    file: 'pages/audience/PeoplePage.tsx',
    control: /<IconButton label="Refresh people".*onClick=\{\(\) => void loadFirst\(\)\}/,
    reason: 'refreshes the first page; a read',
  },
  {
    file: 'pages/audience/PersonPage.tsx',
    control: /<Button icon=\{<RefreshCw size=\{15\} \/>\} onClick=\{\(\) => void profile\.reload\(\)\}>/,
    reason: 'retries the profile read',
  },
  {
    file: 'pages/build/BroadcastsPage.tsx',
    control: /<Button onClick=\{\(\) => void list\.reload\(\)\}>/,
    reason: 'retries the list read',
  },
  {
    file: 'pages/build/RecipesPage.tsx',
    control: /<Button onClick=\{\(\) => void loadList\(\)\}>/,
    reason: 'retries the starters read',
  },
  {
    file: 'pages/build/RecipesPage.tsx',
    control: /<Button variant="secondary" loading=\{checking\} onClick=\{\(\) => void check\(\)\}>/,
    reason: 'recipes.preview: checks prerequisites, no write',
  },
  {
    file: 'pages/design/AssetsPage.tsx',
    control: /<Button onClick=\{\(\) => void list\.reload\(\)\}>/,
    reason: 'retries the asset list read',
  },
  {
    file: 'pages/insights/MessagesPage.tsx',
    control: /<Button onClick=\{\(\) => void loadMore\(\)\} loading=\{loadingMore\}>/,
    reason: 'pages forward; a read',
  },
  {
    file: 'pages/settings/SecretsPage.tsx',
    control: /<Button onClick=\{\(\) => void list\.reload\(\)\}>/,
    reason: 'retries the secrets list read',
  },
  {
    file: 'pages/settings/UsersPage.tsx',
    control: /<Button onClick=\{\(\) => void data\.reload\(\)\}>/,
    reason: 'retries the member list read',
  },
  {
    file: 'pages/settings/UsersPage.tsx',
    control: /<Button icon=\{<Copy size=\{14\} \/>\} onClick=\{\(\) => void copy\(\)\}>/,
    reason: 'copies the invitation link to the clipboard',
  },
];

const MUTATING_HANDLER =
  /\b(save|submit|create|remove|delete|archive|rename|approve|reject|invite|import|connect|revoke|erase|erasePerson|record|upload|install|rotate|discard|publish|openPublish|refreshSnapshot|toBrief|sendTest|setRole|setAutonomy|pause|resume|runNow|test)\b/;

const MUTATING_SWITCH = /(\btoggle\b|onToggle|void\s+toggle\s*\()/;

// A handler that fires an async command mutates even when its name is lexical rather than verbal:
// `removeSelection`, `onPick`, `void save(…)` and `api.call(…)` all count. The verb list stays as
// the second signal; either one is enough for a button, and it was already the rule for Select.
const ASYNC_COMMAND = /\bvoid\s+[\w.]+\s*\(|\bapi\.call\s*\(/;

/** Whether one control's handler changes data, by name or by firing an async command. */
export function handlerMutates(name: string, handler: string | null): boolean {
  if (handler === null) return false;
  if (name === 'Switch') return MUTATING_SWITCH.test(handler);
  if (name === 'Select') return ASYNC_COMMAND.test(handler);
  return MUTATING_HANDLER.test(handler) || ASYNC_COMMAND.test(handler);
}

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

    for (const name of ['Button', 'IconButton', 'Switch', 'Select']) {
      for (const tag of tags(source, name)) {
        if (/mutation=\{false\}/.test(tag.text)) {
          if (!allowed(tag.text)) problems.push(`${file}:${tag.line}: mutation={false} is not allowed\n  ${tag.text.replace(/\s+/g, ' ')}`);
          continue;
        }
        if (/\bmutation\b/.test(tag.text)) continue;
        const submit = /type="submit"/.test(tag.text) || /\bform="/.test(tag.text);
        const handler = prop(tag.text, name === 'Switch' || name === 'Select' ? 'onChange' : 'onClick');
        const mutating = handlerMutates(name, handler);
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

  it('flags a Button or IconButton that fires an async command, whatever its name (#552)', () => {
    expect(handlerMutates('Button', '() => void removeSelection(id)')).toBe(true);
    expect(handlerMutates('IconButton', '() => void api.call("members.remove", input)')).toBe(true);
    expect(handlerMutates('Button', '() => { void archive(row); }')).toBe(true);
  });

  it('keeps the verb list as a second signal (#552)', () => {
    expect(handlerMutates('Button', '() => save()')).toBe(true);
    expect(handlerMutates('IconButton', '() => remove(id)')).toBe(true);
  });

  it('does not flag local state or navigation (#552)', () => {
    expect(handlerMutates('Button', '() => setOpen(true)')).toBe(false);
    expect(handlerMutates('IconButton', '() => navigate("/settings")')).toBe(false);
    expect(handlerMutates('Button', null)).toBe(false);
  });

  it('flags a clipboard copy by shape, so the sweep can allowlist that exact control (#552)', () => {
    expect(handlerMutates('Button', '() => void navigator.clipboard.writeText(text)')).toBe(true);
  });
});
