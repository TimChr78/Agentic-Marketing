import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { publicOnly } from '../src/http/public-only';
import { rejectUnsafeRawPath, unsafeRawPath } from '../src/http/raw-path';

const rawGet = (port: number, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });

describe('unsafeRawPath', () => {
  it('rejects dot segments before a proxy path rule can be bypassed', () => {
    for (const path of ['/f/../v1/workspace.get', '/hooks/../mcp', '/f/.', '/f/..', '/f/./x', '/../etc/passwd', '/f/../..', '/a//../b'])
      expect(unsafeRawPath(path), path).toBe(true);
  });

  it('rejects encoded dots, slashes and backslashes in any case', () => {
    for (const path of ['/f/%2e%2e/v1/x', '/f/%2E%2E/v1/x', '/f/%2e/x', '/f/%2f/x', '/f/%2F/x', '/f/%5c/x', '/f/%5C/x'])
      expect(unsafeRawPath(path), path).toBe(true);
  });

  it('rejects a backslash', () => {
    expect(unsafeRawPath('/f\\..\\v1\\x')).toBe(true);
  });

  it('accepts the real public links, the API and static assets', () => {
    for (const path of [
      '/',
      '/f',
      '/f/frm_0123456789abcdef0123456789abcdef',
      '/f/confirm/eyJrIjoiZG9pIn0.c2lnbmF0dXJl',
      '/u/eyJ4IjoxfQ.c2ln',
      '/c/eyJ4IjoxfQ.c2ln',
      '/hooks/email/m_123/token',
      '/hooks/in/hook_123/token',
      '/hooks/sms/token/status',
      '/v1/workspace.get',
      '/assets/index-abc123.js',
      '/f/confirm/a.b.c',
      '/.well-known/oauth-protected-resource',
    ])
      expect(unsafeRawPath(path), path).toBe(false);
  });

  it('only inspects the path, not the query string', () => {
    expect(unsafeRawPath('/f/frm_123?next=%2Faccount&email=first.last%40example.com')).toBe(false);
    expect(unsafeRawPath('/u/token?redirect=https%3A%2F%2Fexample.com%2F..%2Fx')).toBe(false);
    expect(unsafeRawPath('/f/frm_123?next=/f/../v1/x')).toBe(false);
  });
});

describe('raw path guard before routing', () => {
  it('rejects a raw traversal request that the URL parser would collapse', async () => {
    const app = new Hono();
    app.use('*', rejectUnsafeRawPath);
    app.get('/v1/x', (c) => c.text('reached'));
    let server: { close: () => void } | undefined;
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => resolve(info.port));
    });
    try {
      expect((await rawGet(port, '/f/../v1/x')).status).toBe(400);
      expect((await rawGet(port, '/f/%2e%2e/v1/x')).status).toBe(400);
      const ok = await rawGet(port, '/v1/x?next=%2Faccount');
      expect(ok.status).toBe(200);
      expect(ok.body).toBe('reached');
    } finally {
      server?.close();
    }
  });
});

describe('publicOnly', () => {
  const main = new Hono();
  main.get('/f/:id', (c) => c.text(`form ${c.req.param('id')}`));
  main.get('/u/:token', (c) => c.text('unsubscribe'));
  main.get('/c/:token', (c) => c.text('click'));
  main.post('/hooks/email/:id/:token', (c) => c.text('webhook'));
  main.get('/healthz', (c) => c.json({ ok: true }));
  main.get('/readyz', (c) => c.json({ ok: true }));
  main.get('/v1/workspace.get', (c) => c.text('admin'));
  main.get('/mcp', (c) => c.text('mcp'));
  const pub = publicOnly(main);

  it('passes the public paths through to the main app', async () => {
    expect((await pub.request('/f/frm_123')).status).toBe(200);
    expect(await (await pub.request('/f/frm_123')).text()).toBe('form frm_123');
    expect((await pub.request('/u/token')).status).toBe(200);
    expect((await pub.request('/c/token')).status).toBe(200);
    expect((await pub.request('/hooks/email/m_1/token', { method: 'POST' })).status).toBe(200);
    expect((await pub.request('/healthz')).status).toBe(200);
    expect((await pub.request('/readyz')).status).toBe(200);
  });

  it('404s everything else, including near-miss prefixes', async () => {
    for (const path of ['/', '/foo', '/foo/f/x', '/favorite', '/v1/workspace.get', '/mcp', '/api/auth/sign-in', '/assets/app.js'])
      expect((await pub.request(path)).status, path).toBe(404);
  });

  it('rejects a raw traversal target even when its resolved path is not public', async () => {
    const res = await pub.request('/v1/x', {}, { incoming: { url: '/f/../v1/x' } });
    expect(res.status).toBe(400);
  });
});
