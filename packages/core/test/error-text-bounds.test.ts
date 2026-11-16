import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// #964: a send failure's stored text is bounded as well as redacted (#919). One hand-rolled
// `redactCredentials(...).split('\n')[0]` had no length cut, so a provider's single-line answer was
// stored whole. This guard keeps the shape out of the source: the bound must apply to the result
// that produced the first line, not to something else in the same statement.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', 'test', 'tests', '__tests__', 'fixtures']);

/** The first-line use of a redacted string. */
const FIRST_LINE = /\.split\(\s*(['"])\\n\1\s*\)\s*\[\s*0\s*\]/;
const LENGTH_CUT = /\.(?:slice|substring)\(\s*0\s*,/;
const WRAPPER = new Set(['safeErrorText', 'failureText']);
const FIRST_LINE_HELPER = new Set(['firstLine']);

/** Every source file the guard reads. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry) && !/\.test\.|\.spec\./.test(entry)) out.push(path);
  }
  return out;
}

/** The index of the closer matching the opener at `open`, ignoring quoted text. */
function closeOf(text: string, open: number): number {
  const opener = text[open];
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}';
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The identifier immediately before `pos` (skipping whitespace), or an empty string. */
function nameBefore(text: string, pos: number): string {
  let index = pos - 1;
  while (index >= 0 && /\s/.test(text[index]!)) index -= 1;
  const end = index + 1;
  while (index >= 0 && /[A-Za-z0-9_$]/.test(text[index]!)) index -= 1;
  return text.slice(index + 1, end);
}

/** The direct method chain on the value a call returns, e.g. `.split(...)[0].trim().slice(0, 10)`. */
function directChain(text: string, from: number): string {
  let index = from;
  for (;;) {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
    const char = text.charAt(index);
    if (char === '!') {
      index += 1;
      continue;
    }
    if (char === '.') {
      index += 1;
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index]!)) index += 1;
      while (index < text.length && /\s/.test(text[index]!)) index += 1;
      const opener = text.charAt(index);
      if (opener === '(' || opener === '[') {
        const close = closeOf(text, index);
        if (close < 0) break;
        index = close + 1;
      }
      continue;
    }
    if (char === '[') {
      const close = closeOf(text, index);
      if (close < 0) break;
      index = close + 1;
      continue;
    }
    break;
  }
  return text.slice(from, index);
}

/** Why a source snippet leaves an unbounded first-line text, or null when it is safe. */
export function unboundedRedaction(code: string): string | null {
  for (let at = code.indexOf('redactCredentials('); at >= 0; at = code.indexOf('redactCredentials(', at + 1)) {
    const open = code.indexOf('(', at);
    const close = closeOf(code, open);
    if (close < 0) continue;
    // The whole redaction wrapped by safeErrorText/failureText is bounded by the wrapper.
    let before = close + 1;
    while (before < code.length && /\s/.test(code[before]!)) before += 1;
    if (code.charAt(before) === ')') {
      // Find the `(` that owns this argument and the identifier before it.
      let owner = at - 1;
      while (owner >= 0 && /\s/.test(code[owner]!)) owner -= 1;
      if (code.charAt(owner) === '(') {
        const name = nameBefore(code, owner);
        if (WRAPPER.has(name)) continue;
        if (FIRST_LINE_HELPER.has(name)) return `${at}: firstLine(redactCredentials(…)) has no length cut`;
      }
    }
    const chain = directChain(code, close + 1);
    const firstLine = FIRST_LINE.exec(chain);
    if (firstLine) {
      const after = chain.slice(firstLine.index + firstLine[0].length);
      if (!LENGTH_CUT.test(after)) return `${at}: redactCredentials(…).split(newline)[0] without a slice(0, n) on that result`;
      continue;
    }
    // A direct cut on the redacted result is enough even without a first-line step.
    if (LENGTH_CUT.test(chain)) continue;
  }
  return null;
}

describe('every first-line error text has a length cut (#964)', () => {
  it('flags the first-line bypasses and accepts the bounded shapes', () => {
    const cases: [string, boolean][] = [
      ['firstLine(redactCredentials(message))', true],
      ["redactCredentials(message).split('\\n')[0]", true],
      ["redactCredentials(message).split('\\n')[0].trim()", true],
      ["redactCredentials(message).split('\\n')[0].trim() + 'x'.slice(0, 3)", true],
      ["const x = redactCredentials(message).split('\\n')[0]; const y = other.slice(0, 3)", true],
      ['safeErrorText(redactCredentials(message), 300)', false],
      ['failureText(redactCredentials(message))', false],
      ["redactCredentials(message).split('\\n')[0].slice(0, 300)", false],
      ["redactCredentials(message).split('\\n')[0]!.trim().slice(0, max)", false],
      ['redactCredentials(message).slice(0, 300)', false],
      ['redactCredentials(message)', false],
    ];
    const wrong = cases.filter(([code, isOffender]) => (unboundedRedaction(code) !== null) !== isOffender);
    expect(wrong.map(([code]) => code)).toEqual([]);
  });

  it('does not keep an unbounded first-line in any source file', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const why = unboundedRedaction(readFileSync(file, 'utf8'));
      if (why) offenders.push(`${relative(ROOT, file)}: ${why}`);
    }
    expect(offenders.slice(0, 10)).toEqual([]);
    expect(offenders).toHaveLength(0);
  });
});
