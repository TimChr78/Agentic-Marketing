import { AppError } from '@agentic-marketing/core';
import { Resvg } from '@resvg/resvg-js';
import type { ImageSize } from './media';

// E-mail clients rarely render SVG, so every SVG asset gets a PNG rendition at upload. resvg is
// prebuilt for linux-x64-gnu and linux-arm64-gnu, which is what the Debian-based image uses.

const MAX_PX = 2_000;
const DEFAULT_HEIGHT = 200;

export interface PngRendition {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Rasterise at twice the intrinsic size, capped at 2000 px per side. An SVG without a usable size
 * is treated as 200 px tall, so a logo always has a predictable e-mail image.
 */
export function rasteriseSvg(svg: string, size: ImageSize | null): PngRendition {
  const intrinsicWidth = size?.width ?? DEFAULT_HEIGHT;
  const intrinsicHeight = size?.height ?? DEFAULT_HEIGHT;
  const scale = Math.min(2, MAX_PX / intrinsicWidth, MAX_PX / intrinsicHeight);
  const width = Math.max(1, Math.round(intrinsicWidth * scale));
  try {
    const image = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: 'transparent' }).render();
    return { data: Buffer.from(image.asPng()), width: image.width, height: image.height };
  } catch (error) {
    throw new AppError('invalid_input', `The SVG could not be rendered to a PNG for e-mail: ${(error as Error).message.split('\n')[0]}`);
  }
}
