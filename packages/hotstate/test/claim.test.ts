import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { valkeyHotState } from '../src';

// The two-state claim behind inbound replay protection (#643): a pending lease belongs to one
// owner, only that owner may complete it, and a completed key is reported as done. The expiry
// cases are covered by the injected clock in the inbound route tests; here the CAS and release
// semantics are checked against a real Valkey.

const VALKEY_URL = process.env.VALKEY_URL;
const prefix = `am-hotstate-test-${process.pid}-${Date.now()}`;
const key = () => `${randomUUID()}`;

let hot!: ReturnType<typeof valkeyHotState>;

beforeAll(() => {
  if (VALKEY_URL) hot = valkeyHotState({ url: VALKEY_URL, prefix });
});

afterAll(async () => {
  if (hot) await hot.close();
});

describe.skipIf(!VALKEY_URL)('hot-state claims', () => {
  it('reports pending, completes only the owner, then reports done', async () => {
    const k = key();
    const claim = await hot.claim(k, 60);
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') return;

    expect(await hot.claim(k, 60)).toEqual({ state: 'pending' });
    expect(await hot.complete(k, 'not-the-owner', 60)).toBe(false);
    expect(await hot.claim(k, 60)).toEqual({ state: 'pending' });
    expect(await hot.complete(k, claim.token, 60)).toBe(true);
    expect(await hot.claim(k, 60)).toEqual({ state: 'done' });
    expect(await hot.complete(k, claim.token, 60)).toBe(false);
  });

  it('releases only the owner’s pending claim', async () => {
    const k = key();
    const claim = await hot.claim(k, 60);
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') return;

    await hot.release(k, 'not-the-owner');
    expect(await hot.claim(k, 60)).toEqual({ state: 'pending' });
    await hot.release(k, claim.token);
    expect((await hot.claim(k, 60)).state).toBe('claimed');
  });

  it('keeps a completed key completed after a late release', async () => {
    const k = key();
    const claim = await hot.claim(k, 60);
    expect(claim.state).toBe('claimed');
    if (claim.state !== 'claimed') return;
    expect(await hot.complete(k, claim.token, 60)).toBe(true);
    await hot.release(k, claim.token);
    expect(await hot.claim(k, 60)).toEqual({ state: 'done' });
  });
});
