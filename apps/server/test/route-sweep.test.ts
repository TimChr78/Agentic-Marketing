import { bodyLimit } from '@agentic-marketing/ingest';
import { type Context, Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { findUnboundedRoutes } from './route-sweep';

// #932 review A5: the sweep must notice more than a bare `app.post`. These fixtures run the same
// function against small apps so a regression in the sweep itself is caught.

const ok = (c: Context) => c.text('ok');
const readsBody = async (c: Context, next: () => Promise<void>) => {
  await c.req.text();
  await next();
};
const guard = () => bodyLimit(1024, (c) => c.json({ error: 'payload_too_large' }, 413));

describe('the body-limit sweep itself (#932 A5)', () => {
  it('flags an unguarded app.all', () => {
    const app = new Hono();
    app.all('/fixture/all', ok);
    expect(findUnboundedRoutes(app)).toEqual(['ALL /fixture/all']);
  });

  it('flags unguarded body-reading middleware', () => {
    const app = new Hono();
    app.use('/fixture/use/*', readsBody);
    app.post('/fixture/use/one', ok);
    expect(findUnboundedRoutes(app)).toContain('ALL /fixture/use/*');
  });

  it('flags an unguarded POST in a mounted sub-app', () => {
    const sub = new Hono();
    sub.post('/one', ok);
    const app = new Hono();
    app.route('/fixture', sub);
    expect(findUnboundedRoutes(app)).toEqual(['POST /fixture/one']);
  });

  it('flags an unguarded app.on', () => {
    const app = new Hono();
    app.on(['GET', 'POST'], '/fixture/on', ok);
    expect(findUnboundedRoutes(app)).toEqual(['POST /fixture/on']);
  });

  it('accepts guarded registrations in the app and in a sub-app', () => {
    const app = new Hono();
    app.all('/fixture/all', guard(), ok);
    app.on(['GET', 'POST'], '/fixture/on', guard(), ok);
    const sub = new Hono();
    sub.use('/one/*', guard());
    sub.post('/one/action', ok);
    app.route('/fixture', sub);
    expect(findUnboundedRoutes(app)).toEqual([]);
  });

  it('honours the explicit allow-list', () => {
    const app = new Hono();
    app.all('/hooks', ok);
    app.all('/hooks/*', ok);
    expect(findUnboundedRoutes(app)).toEqual([]);
  });
});
