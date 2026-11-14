import { defineCommand } from '@agentic-marketing/commands';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, callWithRetry, createClient, isIdempotencyInProgress } from '../src';

// #906: the idempotency contract says a 409 "still in progress" is retried with the SAME key and
// every other conflict is a final answer. `callWithRetry` is that loop; a fresh key per attempt
// would run the write twice, which is what the header exists to prevent.

const write = defineCommand({
  name: 'test.write',
  title: 'Write',
  description: 'A write for the client test.',
  input: z.object({ value: z.string() }),
  output: z.object({ id: z.string() }),
  permission: null,
  effect: 'write',
  handler: async () => ({ id: 'never-runs' }),
});

type Commands = [typeof write];

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const keyOf = (init: RequestInit | undefined) => new Headers(init?.headers).get('idempotency-key');

describe('the typed client retries an idempotent call (#906)', () => {
  it('retries the in-progress 409 with the same key and returns the first response', async () => {
    const calls: (RequestInit | undefined)[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      if (calls.length === 1)
        return respond(409, {
          error: 'conflict',
          message: 'A request with this idempotency key is still in progress.',
          details: { reason: 'idempotency_in_progress' },
        });
      return respond(200, { id: 'note_1' });
    });
    const api = createClient<Commands>({ fetch: fetch as unknown as typeof globalThis.fetch });

    expect(await callWithRetry(api, 'test.write', { value: 'a' })).toEqual({ id: 'note_1' });
    expect(calls).toHaveLength(2);
    expect(keyOf(calls[0])).toBeTruthy();
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
  });

  it('keeps a key the caller supplied', async () => {
    const calls: (RequestInit | undefined)[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      if (calls.length === 1) return respond(409, { error: 'conflict', details: { reason: 'idempotency_in_progress' } });
      return respond(200, { id: 'note_1' });
    });
    const api = createClient<Commands>({ fetch: fetch as unknown as typeof globalThis.fetch });

    await callWithRetry(api, 'test.write', { value: 'a' }, { idempotencyKey: 'logical-call-1' });
    expect(calls.map(keyOf)).toEqual(['logical-call-1', 'logical-call-1']);
  });

  it('retries a network error with the same key', async () => {
    const calls: (RequestInit | undefined)[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      if (calls.length === 1) throw new TypeError('fetch failed');
      return respond(200, { id: 'note_1' });
    });
    const api = createClient<Commands>({ fetch: fetch as unknown as typeof globalThis.fetch });

    expect(await callWithRetry(api, 'test.write', { value: 'a' })).toEqual({ id: 'note_1' });
    expect(calls).toHaveLength(2);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
  });

  it('stops on the other conflict and on any other 4xx', async () => {
    const reused = vi.fn(async () =>
      respond(409, { error: 'conflict', message: 'already used', details: { reason: 'idempotency_key_reused' } }),
    );
    const api = createClient<Commands>({ fetch: reused as unknown as typeof globalThis.fetch });
    const err = await callWithRetry(api, 'test.write', { value: 'a' }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    expect(isIdempotencyInProgress(err)).toBe(false);
    expect(reused).toHaveBeenCalledTimes(1);

    const refused = vi.fn(async () => respond(403, { error: 'forbidden', message: 'no' }));
    const api2 = createClient<Commands>({ fetch: refused as unknown as typeof globalThis.fetch });
    await expect(callWithRetry(api2, 'test.write', { value: 'a' })).rejects.toMatchObject({ status: 403 });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('does not retry a plain call', async () => {
    const fetch = vi.fn(async () => respond(409, { error: 'conflict', details: { reason: 'idempotency_in_progress' } }));
    const api = createClient<Commands>({ fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(api.call('test.write', { value: 'a' })).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty or malformed supplied key before sending anything', async () => {
    const fetch = vi.fn(async () => respond(200, { id: 'note_1' }));
    const api = createClient<Commands>({ fetch: fetch as unknown as typeof globalThis.fetch });

    await expect(callWithRetry(api, 'test.write', { value: 'a' }, { idempotencyKey: '' })).rejects.toThrow(
      'idempotency key must be 1 to 200 printable characters',
    );
    expect(() => api.call('test.write', { value: 'a' }, { idempotencyKey: 'not a key' })).toThrow(
      'idempotency key must be 1 to 200 printable characters',
    );
    await expect(callWithRetry(api, 'test.write', { value: 'a' }, { idempotencyKey: 'k'.repeat(201) })).rejects.toThrow(
      'idempotency key must be 1 to 200 printable characters',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('replays a lost response with the same generated key instead of running twice', async () => {
    const committed = new Map<string, { id: string }>();
    const calls: (RequestInit | undefined)[] = [];
    let runs = 0;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      const key = keyOf(init);
      if (key === null) return respond(400, { error: 'invalid_input', message: 'no key' });
      if (!committed.has(key)) {
        runs++;
        committed.set(key, { id: `note_${runs}` });
      }
      // The first attempt's response is lost after the server committed.
      if (calls.length === 1) throw new TypeError('socket hang up');
      return respond(200, committed.get(key));
    });
    const api = createClient<Commands>({ fetch: fetch as unknown as typeof globalThis.fetch });

    expect(await callWithRetry(api, 'test.write', { value: 'a' })).toEqual({ id: 'note_1' });
    expect(runs).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('recognises the in-progress sub-code only', () => {
    expect(isIdempotencyInProgress(new ApiError(409, 'conflict', 'x', { reason: 'idempotency_in_progress' }))).toBe(true);
    expect(isIdempotencyInProgress(new ApiError(409, 'conflict', 'x', { reason: 'idempotency_key_reused' }))).toBe(false);
    expect(isIdempotencyInProgress(new ApiError(500, 'internal', 'x'))).toBe(false);
  });
});
