import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_ACCENT, BRAND_INK, BRAND_NAME, brandMarkSvg, brandWordmarkSvg } from '../packages/core/src/brand';

// Resolve the rasteriser from the asset library, which already depends on it, so the root manifest
// does not gain an image dependency for a script that runs only when the mark changes.
const require = createRequire(new URL('../packages/assets/package.json', import.meta.url));
const { Resvg } = require('@resvg/resvg-js') as { Resvg: typeof import('@resvg/resvg-js').Resvg };

// Generates the product assets in apps/web/public (#195) from the single geometry source in
// packages/core/src/brand.ts. Run after changing the mark:
//
//   corepack pnpm install
//   corepack pnpm exec tsx scripts/gen-brand-assets.ts
//
// The output is committed: the Docker image only copies the built web directory, so the server
// and README cannot generate assets at runtime. See docs/design/brand-assets.md.

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = join(root, 'apps/web/public');
const brandDir = join(publicDir, 'brand');

/** Full-bleed icon for app icons: the accent tile reaches every edge, so iOS/Android crop it cleanly. */
const appIconSvg = (scale = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="${BRAND_ACCENT}"/><g transform="translate(32 32) scale(${scale}) translate(-32 -32)"><path d="M17 46 32 18 47 46" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M24.5 36H39.5" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/></g></svg>`;

const png = (svg: string, size: number) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

/** An ICO container of PNG images (16, 32 and 48 px), which Chrome and Windows both accept. */
function ico(images: { size: number; data: Buffer }[]) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entry);
    header.writeUInt8(image.size >= 256 ? 0 : image.size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const socialPreviewSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img">
  <title>${BRAND_NAME}: agent-first marketing, with people in control</title>
  <rect width="1280" height="640" fill="#f7f8fa"/>
  <rect x="0" y="0" width="1280" height="8" fill="${BRAND_ACCENT}"/>
  <g transform="translate(400 168) scale(7.5)"><rect width="64" height="64" rx="14" fill="${BRAND_ACCENT}"/>
    <path d="M17 46 32 18 47 46" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M24.5 36H39.5" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round"/></g>
  <text x="640" y="440" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="96" font-weight="600" letter-spacing="-2" fill="${BRAND_INK}">${BRAND_NAME}</text>
  <text x="640" y="504" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="30" fill="#646c79">Agent-first marketing, with people in control</text>
</svg>`;

async function main() {
  await mkdir(brandDir, { recursive: true });

  const svgs: Record<string, string> = {
    'brand/mark.svg': brandMarkSvg({ title: BRAND_NAME }),
    'brand/mark-wordmark.svg': brandWordmarkSvg({ title: BRAND_NAME }),
    'brand/mark-mono-light.svg': brandMarkSvg({ tone: 'mono-light', title: BRAND_NAME }),
    'brand/mark-mono-dark.svg': brandMarkSvg({ tone: 'mono-dark', title: BRAND_NAME }),
    'brand/mark-wordmark-mono-light.svg': brandWordmarkSvg({ tone: 'mono-light', title: BRAND_NAME }),
    'brand/mark-wordmark-mono-dark.svg': brandWordmarkSvg({ tone: 'mono-dark', title: BRAND_NAME }),
    'favicon.svg': brandMarkSvg({ tone: 'color', title: BRAND_NAME }),
    'brand/social-preview.svg': socialPreviewSvg,
  };
  await Promise.all(Object.entries(svgs).map(([name, svg]) => writeFile(join(publicDir, name), `${svg}\n`)));

  const icon = (size: number, scale = 1) => png(appIconSvg(scale), size);
  const pngs: Record<string, Buffer> = {
    'brand/icon-32.png': icon(32),
    'brand/apple-touch-icon.png': icon(180),
    'brand/icon-192.png': icon(192),
    'brand/icon-512.png': icon(512),
    'brand/icon-192-maskable.png': icon(192, 0.72),
    'brand/icon-512-maskable.png': icon(512, 0.72),
    'brand/social-preview.png': new Resvg(socialPreviewSvg, { fitTo: { mode: 'width', value: 1280 } }).render().asPng(),
  };
  await Promise.all(Object.entries(pngs).map(([name, data]) => writeFile(join(publicDir, name), data)));

  await writeFile(join(publicDir, 'favicon.ico'), ico([16, 32, 48].map((size) => ({ size, data: icon(size) }))));

  const manifest = {
    name: BRAND_NAME,
    short_name: 'Agentic',
    description: 'Agent-first marketing, with people in control.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f7f8fa',
    theme_color: '#f7f8fa',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/brand/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/brand/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  await writeFile(join(publicDir, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Wrote brand assets to ${publicDir}`);
}

void main();
