# Brand assets

The product's own identity, as opposed to a customer's brand under **Design → Brand**. The mark is an
upward **A** drawn with two round strokes: it stays legible at 16 px and calm at 512 px.

## One source

The geometry lives in [`packages/core/src/brand.ts`](../../packages/core/src/brand.ts)
(`brandMarkSvg` and `brandWordmarkSvg`). The server-rendered sign-in, consent and invitation pages
inline the same function, so there is no second copy to keep in sync.

Generated files are committed under [`apps/web/public`](../../apps/web/public) because the Docker
image copies only the built web directory; nothing is rasterised at runtime.

| Path | Use |
|---|---|
| `brand/mark.svg` | Colour mark on its accent tile. The default for app and documentation. |
| `brand/mark-wordmark.svg` | Mark plus the "Agentic Marketing" wordmark. README and wide headers. |
| `brand/mark-mono-light.svg` | One ink colour (`#14171c`) for white or light backgrounds. |
| `brand/mark-mono-dark.svg` | One ink colour (`#e7e9ed`) for dark backgrounds. |
| `brand/mark-wordmark-mono-light.svg` | The wordmark in one dark ink for light backgrounds. |
| `brand/mark-wordmark-mono-dark.svg` | The wordmark in one light ink for dark backgrounds. |
| `brand/icon-32.png` | Small raster icon (`32×32`). |
| `brand/apple-touch-icon.png` | iOS home screen (`180×180`). |
| `brand/icon-192.png`, `brand/icon-512.png` | Web app / Android icons. |
| `brand/icon-192-maskable.png`, `brand/icon-512-maskable.png` | Maskable variants with the glyph inside the safe zone. |
| `brand/social-preview.png` | `1280×640` link preview and GitHub social preview. |
| `favicon.svg`, `favicon.ico` | Browser tab; the ICO contains 16, 32 and 48 px. |
| `site.webmanifest` | Name, short name, colours and the icon set. |

`apps/web/index.html` references them with relative URLs (`/favicon.ico`, `/brand/…`,
`/site.webmanifest`) so a self-hosted installation does not need a build-time hostname. The Open Graph
and Twitter tags use relative image URLs too: a crawler that requires an absolute URL falls back to the
title and description, and an operator can rewrite them at the proxy when they need a rich card.

## Using the mark

- **Clear space:** keep at least half the mark's height on every side. Do not put text or a border
  inside that space.
- **Minimum size:** 16 px for the mark, 120 px wide for the wordmark.
- **Do not** stretch, rotate, recolour outside the variants above, add a shadow, or place the colour
  mark on a busy photograph. Use the monochrome variant on photography or coloured panels.
- The admin chrome never takes a customer brand's accent colours. A workspace's logo and name appear
  in the switcher; its colours stay on hosted pages and e-mails.

## Regenerating

```bash
corepack pnpm install
corepack pnpm exec tsx scripts/gen-brand-assets.ts
```

The script uses `@resvg/resvg-js` (already used by the asset library) to rasterise the SVGs and writes
the ICO container itself, so there is no external image tool in the loop. Commit the changed files in
`apps/web/public` together with the source change.

The GitHub social preview is uploaded by hand in the repository settings from
`apps/web/public/brand/social-preview.png`; GitHub does not read Open Graph tags from the repository.

## Where it appears

- `apps/web/index.html`: icons, manifest, theme colours, description and link-preview metadata.
- `apps/web/src/app/AuthShell.tsx`: the signed-out screens use the mark instead of a letter tile.
- `apps/server/src/http/pages.ts`: the server-rendered OAuth sign-in, consent and invitation pages.
- `README.md`: the wordmark header.
