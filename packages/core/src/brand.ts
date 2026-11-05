/**
 * The product's own brand mark (#195). This module is the single geometry source: the assets in
 * `apps/web/public/brand` are generated from it by `scripts/gen-brand-assets.ts`, and the
 * server-rendered OAuth pages inline the same mark. Edit the paths here, run the script and commit
 * both; do not hand-edit the generated SVGs.
 *
 * The mark is an upward "A" built from two round strokes: precise at 16 px, calm at 512 px. The
 * color variant sits on the accent tile; the monochrome variants are one ink colour for use on
 * light or dark backgrounds. See docs/design/brand-assets.md for clear space and minimum sizes.
 */
export const BRAND_NAME = 'Agentic Marketing';
export const BRAND_ACCENT = '#2457d6';
export const BRAND_INK = '#14171c';
export const BRAND_INK_DARK = '#e7e9ed';

export type BrandTone = 'color' | 'mono-light' | 'mono-dark';

const GLYPH_PATH = 'M17 46 32 18 47 46';
const CROSSBAR_PATH = 'M24.5 36H39.5';

function glyph(tone: BrandTone, strokeWidth: number) {
  const stroke = tone === 'color' ? '#ffffff' : tone === 'mono-dark' ? BRAND_INK_DARK : BRAND_INK;
  return `<path d="${GLYPH_PATH}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/><path d="${CROSSBAR_PATH}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
}

/** The square mark. `size` is its rendered size; the viewBox stays 64 so strokes stay sharp. */
export function brandMarkSvg({ tone = 'color', size = 64, title = BRAND_NAME }: { tone?: BrandTone; size?: number; title?: string } = {}) {
  const tile = tone === 'color' ? `<rect width="64" height="64" rx="14" fill="${BRAND_ACCENT}"/>` : '';
  const label = title ? `<title>${title}</title>` : '';
  const a11y = title ? 'role="img"' : 'aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64" ${a11y}>${label}${tile}${glyph(tone, 6)}</svg>`;
}

/** The mark followed by the wordmark, for README headers, documentation and social cards. */
export function brandWordmarkSvg({
  tone = 'color',
  width = 320,
  title = BRAND_NAME,
}: {
  tone?: BrandTone;
  width?: number;
  title?: string;
} = {}) {
  const ink = tone === 'mono-dark' ? BRAND_INK_DARK : BRAND_INK;
  const tile = tone === 'color' ? `<rect width="64" height="64" rx="14" fill="${BRAND_ACCENT}"/>` : '';
  const label = title ? `<title>${title}</title>` : '';
  const a11y = title ? 'role="img"' : 'aria-hidden="true"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="64" viewBox="0 0 320 64" ${a11y}>${label}${tile}${glyph(tone, 6)}<text x="80" y="41" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" font-size="25" font-weight="600" letter-spacing="-0.4" fill="${ink}">${BRAND_NAME}</text></svg>`;
}
