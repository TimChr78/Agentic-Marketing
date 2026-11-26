import type { Db } from '@agentic-marketing/db';
import type { EventBus } from '@agentic-marketing/events';
import { describe, expect, it } from 'vitest';
import { ingestApi } from '../src/gateway';

// #1246: JSON.parse also succeeds for `null`. With no Authorization header the gateway read
// `body.batch` and threw, so a four-byte unauthenticated request answered 500 (and logged an
// "unhandled error" with a stack) instead of the 400 every other malformed body gets.

const app = () => ingestApi({ db: {} as Db, bus: {} as EventBus });

const post = (body: string, headers: Record<string, string> = {}) => app().request('http://x/v1/b', { method: 'POST', body, headers });

describe('the ingest gateway refuses a non-object JSON body with 400 (#1246)', () => {
  it('answers 400 for a null body without an Authorization header', async () => {
    const res = await post('null');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'invalid_json' });
  }, 30_000);

  it('refuses a top-level array like the edge worker does', async () => {
    const res = await post('[]');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, error: 'invalid_json' });
  }, 30_000);
});
