import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { staticSite } from '../src/http/static';

const made: string[] = [];

async function site(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'am-web-dist-'));
  made.push(root);
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function appFor(root: string) {
  const app = new Hono();
  app.get('/api/ping', (c) => c.json({ ok: true }));
  app.use('*', staticSite({ root }));
  return app;
}

const index = '<!doctype html><div id="root">live admin</div>';
const files = { 'index.html': index, 'assets/app.js': 'console.log("live");' };

describe('staticSite', () => {
  it('serves the SPA shell at / and for extension-less navigation paths', async () => {
    const app = appFor(await site(files));

    const rootRes = await app.request('/');
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-type')).toContain('text/html');
    expect(await rootRes.text()).toBe(index);

    const journeys = await app.request('/journeys');
    expect(journeys.status).toBe(200);
    expect(await journeys.text()).toBe(index);
  });

  it('serves real assets with their content type', async () => {
    const app = appFor(await site(files));

    const res = await app.request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toBe('console.log("live");');
  });

  it('404s a missing asset instead of returning the page', async () => {
    const app = appFor(await site(files));

    const res = await app.request('/assets/missing.js');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('live admin');
  });

  it('does not answer non-GET/HEAD requests with the page', async () => {
    const app = appFor(await site(files));

    const res = await app.request('/', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('live admin');
  });

  it('leaves API paths to the API, including unknown ones', async () => {
    const app = appFor(await site(files));

    const handled = await app.request('/api/ping');
    expect(handled.status).toBe(200);
    expect(await handled.json()).toEqual({ ok: true });

    const unknown = await app.request('/v1/unknown');
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type') ?? '').not.toContain('text/html');
    expect(await unknown.text()).not.toContain('live admin');
  });

  it('falls through cleanly when there is no index.html', async () => {
    const app = appFor(await site({ 'assets/app.js': 'console.log("live");' }));

    const res = await app.request('/journeys');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('live admin');

    const asset = await app.request('/assets/app.js');
    expect(asset.status).toBe(200);
  });

  it('is a no-op when the directory does not exist', async () => {
    const app = appFor(join(tmpdir(), 'am-web-dist-does-not-exist'));

    const res = await app.request('/');
    expect(res.status).toBe(404);
  });
});
