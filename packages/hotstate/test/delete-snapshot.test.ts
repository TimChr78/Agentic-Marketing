import { randomUUID } from 'node:crypto';
import Valkey from 'iovalkey';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { valkeyHotState } from '../src';

// #1196: an erasure fences every id of the person, then deletes the snapshots and sessions the
// fence makes unreadable. The delete used to pass every key of the family to one `DEL` call, and a
// family with a long identifier history produces more keys than V8 lets one call carry: the call
// threw before Valkey saw it, so the erasure's cleanup retried and could never finish.

const VALKEY_URL = process.env.VALKEY_URL;
const prefix = `am-hotstate-delete-${process.pid}-${Date.now()}`;

let hot!: ReturnType<typeof valkeyHotState>;
let raw!: Valkey;
const ws = '00000000-0000-4000-8000-000000000000';
const sessionKey = (anonymousId: string) => `${prefix}:${ws}:s:${anonymousId}`;
const snapshotKey = (anonymousId: string) => `${prefix}:${ws}:p:a:${anonymousId}`;

beforeAll(() => {
  if (VALKEY_URL) {
    hot = valkeyHotState({ url: VALKEY_URL, prefix });
    raw = new Valkey(VALKEY_URL);
  }
});

afterAll(async () => {
  if (hot) await hot.close();
  if (raw) raw.disconnect();
});

describe.skipIf(!VALKEY_URL)('erasure snapshot deletion', () => {
  it('deletes a family whose key list exceeds one call’s argument limit', async () => {
    // Two keys per anonymous id: 66,000 ids are 132,000 keys, more arguments than one call can
    // carry (about 125,000). Only the first and the last id have state; the rest exist only to make
    // the list long, which is enough for the old single call to fail before it reached Valkey.
    const anonymousIds = Array.from({ length: 66_000 }, (_, i) => `family-${i}`);
    const first = anonymousIds[0]!;
    const last = anonymousIds.at(-1)!;
    const live = `live-${randomUUID()}`;

    await raw.mset(
      snapshotKey(first),
      'family',
      sessionKey(first),
      'family',
      snapshotKey(last),
      'family',
      sessionKey(last),
      'family',
      snapshotKey(live),
      'live',
      sessionKey(live),
      'live',
    );

    await hot.deleteSnapshot(ws, { anonymousIds, userIds: [] });

    expect(await raw.exists(snapshotKey(first), sessionKey(first), snapshotKey(last), sessionKey(last))).toBe(0);
    // A visitor outside the family keeps their state: the delete is scoped to the named ids.
    expect(await raw.exists(snapshotKey(live), sessionKey(live))).toBe(2);
  }, 120_000);
});
