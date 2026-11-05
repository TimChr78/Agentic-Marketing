import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { loginPage } from '../src/http/pages';
import { staticSite } from '../src/http/static';

// #195: the browser and the server-rendered OAuth pages use the product's own mark. The assets are
// built into apps/web/dist; this serves the real files through the same middleware the server uses.

const publicDir = fileURLToPath(new URL('../../web/public/', import.meta.url));
const made: string[] = [];

async function distWithBrandAssets() {
  const root = await mkdtemp(join(tmpdir(), 'am-brand-dist-'));
  made.push(root);
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Agentic Marketing</title>');
  await copyFile(join(publicDir, 'favicon.ico'), join(root, 'favicon.ico'));
  await copyFile(join(publicDir, 'favicon.svg'), join(root, 'favicon.svg'));
  await mkdir(join(root, 'brand'), { recursive: true });
  await copyFile(join(publicDir, 'brand/icon-192.png'), join(root, 'brand/icon-192.png'));
  return root;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('brand assets (#195)', () => {
  it('serves favicon.ico and favicon.svg with the right content types', async () => {
    const root = await distWithBrandAssets();
    const app = new Hono();
    app.use('*', staticSite({ root }));

    const ico = await app.request('/favicon.ico');
    expect(ico.status).toBe(200);
    expect(ico.headers.get('content-type')).toMatch(/image\/(x-icon|vnd\.microsoft\.icon)/);
    expect((await ico.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const svg = await app.request('/favicon.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(await svg.text()).toContain('<svg');

    const icon = await app.request('/brand/icon-192.png');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toContain('image/png');
  });

  it('puts the mark on the server-rendered sign-in page', async () => {
    expect(loginPage).toContain('Agentic Marketing');
    expect(loginPage).toContain('<svg');
    expect(loginPage).toContain('aria-label="Agentic Marketing"');
    // The page still works when the admin build is absent: the mark is inline, not a linked file.
    expect(loginPage).not.toContain('<img src="/brand/mark.svg"');
  });

  it('ships a manifest that names the app and its maskable icons', async () => {
    const manifest = JSON.parse(await readFile(join(publicDir, 'site.webmanifest'), 'utf8')) as {
      name: string;
      icons: { purpose?: string }[];
    };
    expect(manifest.name).toBe('Agentic Marketing');
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });
});
