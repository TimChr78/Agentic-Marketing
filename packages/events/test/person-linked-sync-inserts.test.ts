import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #1037 part 1 guard: person-linked inserts are synchronous. A ClickHouse server with async
// inserts enabled acknowledges a batch before it is committed, which is exactly how an erased
// person's row reappeared after a sweep (#1034). Every writer of `events`, `message_events` and
// `journey_events` must therefore pass `async_insert=0`, which the store's SYNC_INSERT constant
// does. This scans source, so a new writer cannot quietly omit it.

const ROOT = new URL('../../..', import.meta.url).pathname;
const PERSON_LINKED = ["table: 'events'", "table: 'message_events'", "table: 'journey_events'"];

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'migrations') continue;
      yield* sources(path);
    } else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
      yield path;
    }
  }
}

/** The object literal of one `.insert({ … })` call: from the call to the next call or 4 KB. */
function insertBlocks(source: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = source.indexOf('.insert(', from);
    if (start === -1) return blocks;
    const next = source.indexOf('.insert(', start + 1);
    const end = next === -1 ? Math.min(source.length, start + 4000) : Math.min(next, start + 4000);
    blocks.push(source.slice(start, end));
    from = start + 1;
  }
}

describe('person-linked ClickHouse inserts are synchronous (#1037 guard)', () => {
  it('every insert of events, message_events or journey_events sets async_insert=0', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const path of [...sources(join(ROOT, 'packages')), ...sources(join(ROOT, 'apps/server/src'))]) {
      const source = readFileSync(path, 'utf8');
      for (const block of insertBlocks(source)) {
        if (!PERSON_LINKED.some((table) => block.includes(table))) continue;
        found++;
        if (!block.includes('SYNC_INSERT') && !block.includes('async_insert: 0')) offenders.push(path.replace(`${ROOT}/`, ''));
      }
    }
    expect(found, 'the scan must find the store’s three person-linked inserts').toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
