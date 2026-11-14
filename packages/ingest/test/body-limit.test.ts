import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { bodyLimit } from '../src/body-limit';

// #932 review (A2): a Content-Length at or below the limit must not be trusted. The guard counts
// every body while reading it, so an understated header cannot smuggle an oversized body past it.

const MAX = 1024;

function appWithLimit() {
  const handled: string[] = [];
  const app = new Hono();
  app.post(
    '/x',
    bodyLimit(MAX, (c) => c.json({ error: 'payload_too_large' }, 413)),
    async (c) => {
      handled.push(await c.req.text());
      return c.text('ok');
    },
  );
  return { app, handled };
}

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/x', { method: 'POST', body, headers });

describe('bodyLimit counts actual bytes (#932 A2)', () => {
  it('refuses a body larger than the limit when Content-Length understates it', async () => {
    const { app, handled } = appWithLimit();
    const res = await app.request(post('a'.repeat(MAX * 300), { 'content-length': '1' }));
    expect(res.status).toBe(413);
    expect(handled).toEqual([]);
  });

  it('refuses a chunked body without Content-Length once it crosses the limit', async () => {
    const { app, handled } = appWithLimit();
    const res = await app.request(post('a'.repeat(MAX * 2)));
    expect(res.status).toBe(413);
    expect(handled).toEqual([]);
  });

  it('refuses a declared length over the limit without running the handler', async () => {
    const { app, handled } = appWithLimit();
    const res = await app.request(post('a'.repeat(MAX + 1), { 'content-length': String(MAX + 1) }));
    expect(res.status).toBe(413);
    expect(handled).toEqual([]);
  });

  it('accepts a body of exactly the limit and passes it on intact', async () => {
    const { app, handled } = appWithLimit();
    const body = 'b'.repeat(MAX);
    const res = await app.request(post(body, { 'content-length': String(MAX) }));
    expect(res.status).toBe(200);
    expect(handled).toEqual([body]);
  });

  it('refuses one byte over the limit', async () => {
    const { app, handled } = appWithLimit();
    const res = await app.request(post('c'.repeat(MAX + 1), { 'content-length': String(MAX + 1) }));
    expect(res.status).toBe(413);
    expect(handled).toEqual([]);
  });

  it('accepts a smaller body and passes it on intact', async () => {
    const { app, handled } = appWithLimit();
    const res = await app.request(post('hello', { 'content-length': '5' }));
    expect(res.status).toBe(200);
    expect(handled).toEqual(['hello']);
  });

  it('lets an empty body through', async () => {
    const { app, handled } = appWithLimit();
    const res = await app.request(post(null));
    expect(res.status).toBe(200);
    expect(handled).toEqual(['']);
  });
});
