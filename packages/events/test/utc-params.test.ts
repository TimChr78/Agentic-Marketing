import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Event times are stored as DateTime64(3, 'UTC') and passed as UTC strings. A query parameter typed
// without a time zone is read in the ClickHouse server's zone, which shifts every window on a server
// that does not run in UTC (#54). CI's ClickHouse runs in UTC, so only this check catches it.
const packages = fileURLToPath(new URL('../../', import.meta.url));

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'test' ? [] : sources(path);
      return path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('ClickHouse query parameters', () => {
  it('give every DateTime parameter the UTC zone', async () => {
    const offenders: string[] = [];
    for (const file of await sources(packages)) {
      const text = await readFile(file, 'utf8');
      for (const m of text.matchAll(/\{\w+:DateTime(?:64\(\d\))?\}/g)) offenders.push(`${file.slice(packages.length)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});
