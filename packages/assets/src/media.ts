// Content sniffing and image dimensions without a dependency: the raster formats the asset
// library accepts are simple enough to recognise from their headers, and a mismatch between the
// declared content type and the bytes is a mistake worth reporting clearly. SVG is text, so its
// root element is checked instead (the sanitiser validates the rest).

export const ASSET_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf'] as const;
export type AssetContentType = (typeof ASSET_CONTENT_TYPES)[number];

export type ImageSize = { width: number; height: number };

/** The start of the document with byte-order mark, XML declaration and leading comments removed. */
function xmlStart(text: string): string {
  let rest = text.replace(/^\uFEFF/, '').trimStart();
  for (;;) {
    if (rest.startsWith('<?')) {
      const end = rest.indexOf('?>');
      if (end < 0) return '';
      rest = rest.slice(end + 2).trimStart();
      continue;
    }
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      if (end < 0) return '';
      rest = rest.slice(end + 3).trimStart();
      continue;
    }
    return rest;
  }
}

/** What the bytes look like. An SVG is XML whose root element is <svg>; anything else is not one. */
export function sniffContentType(data: Buffer): AssetContentType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  const head = data.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  const text = xmlStart(data.subarray(0, 8192).toString('utf8'));
  // A DOCTYPE is refused by the sanitiser; still recognise the document as SVG so that message wins.
  if (/^<!doctype/i.test(text)) return /<svg[\s/>]/i.test(text) ? 'image/svg+xml' : null;
  if (/^<svg[\s/>]/i.test(text)) return 'image/svg+xml';
  return null;
}

/** Pixel size from the header of a PNG, JPEG, GIF or WebP, or from an SVG's viewBox/width/height. */
export function imageSize(data: Buffer, contentType: AssetContentType): ImageSize | null {
  try {
    switch (contentType) {
      case 'image/png':
        return pngSize(data);
      case 'image/jpeg':
        return jpegSize(data);
      case 'image/gif':
        return gifSize(data);
      case 'image/webp':
        return webpSize(data);
      case 'image/svg+xml':
        return svgSize(data);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]!] = match[2] ?? match[3] ?? '';
  }
  return attributes;
}

function dimension(value: string | undefined): number | null {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(value ?? '');
  if (!match) return null;
  const number = Number(match[1]);
  if (!(number > 0)) return null;
  const factor: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  return Math.max(1, Math.round(number * (match[2] ? factor[match[2].toLowerCase()]! : 1)));
}

/** Intrinsic size from an SVG root's attributes, preferring width/height and falling back to viewBox. */
export function svgSizeFromAttributes(attributes: Record<string, string>): ImageSize | null {
  const viewBox = (attributes.viewBox ?? attributes.viewbox ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const boxWidth = viewBox.length === 4 && viewBox[2]! > 0 ? viewBox[2]! : null;
  const boxHeight = viewBox.length === 4 && viewBox[3]! > 0 ? viewBox[3]! : null;
  const width = dimension(attributes.width);
  const height = dimension(attributes.height);
  if (width && height) return { width, height };
  if (width && boxWidth && boxHeight) return { width, height: Math.max(1, Math.round((width * boxHeight) / boxWidth)) };
  if (height && boxWidth && boxHeight) return { width: Math.max(1, Math.round((height * boxWidth) / boxHeight)), height };
  if (boxWidth && boxHeight) return { width: Math.max(1, Math.round(boxWidth)), height: Math.max(1, Math.round(boxHeight)) };
  if (width) return { width, height: width };
  if (height) return { width: height, height };
  return null;
}

export function svgSize(data: Buffer): ImageSize | null {
  const text = xmlStart(data.subarray(0, 8192).toString('utf8'));
  const root = /^<svg\b([^>]*)>/i.exec(text);
  return root ? svgSizeFromAttributes(parseAttributes(root[1] ?? '')) : null;
}

function size(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 ? { width, height } : null;
}

function pngSize(data: Buffer): ImageSize | null {
  if (data.length < 24 || data.toString('latin1', 12, 16) !== 'IHDR') return null;
  return size(data.readUInt32BE(16), data.readUInt32BE(20));
}

function jpegSize(data: Buffer): ImageSize | null {
  let i = 2;
  while (i + 4 <= data.length) {
    if (data[i] !== 0xff) {
      i += 1;
      continue;
    }
    let marker = data[i + 1] ?? 0;
    while (marker === 0xff && i + 2 < data.length) {
      i += 1;
      marker = data[i + 1] ?? 0;
    }
    // Standalone markers (SOI, RSTn) carry no length; start-of-scan ends the header.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = data.readUInt16BE(i + 2);
    if (length < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC): height and width follow the precision.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > data.length) return null;
      return size(data.readUInt16BE(i + 7), data.readUInt16BE(i + 5));
    }
    i += 2 + length;
  }
  return null;
}

function gifSize(data: Buffer): ImageSize | null {
  if (data.length < 10) return null;
  return size(data.readUInt16LE(6), data.readUInt16LE(8));
}

function webpSize(data: Buffer): ImageSize | null {
  if (data.length < 30) return null;
  const chunk = data.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return size(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
  if (chunk === 'VP8L') {
    const bits = data.readUInt32LE(21);
    return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    return size(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  }
  return null;
}

/** The file name for an SVG: a real .svg extension, so the PNG rendition URL is predictable. */
export function svgFileName(input: string): string {
  return /\.svg$/i.test(input) ? input.replace(/\.svg$/i, '.svg') : `${extensionlessName(input)}.svg`;
}

/** The PNG rendition keeps the asset's base name and swaps the extension; the id still identifies it. */
export function renditionFileName(fileName: string): string {
  return `${fileName.replace(/\.[^.]*$/, '') || fileName}.png`;
}

/** A safe file name and URL segment: no paths, quotes, spaces or control characters. */
export function sanitiseFileName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
  return cleaned || 'file';
}

export function assetKind(contentType: AssetContentType): 'image' | 'file' {
  return contentType === 'application/pdf' ? 'file' : 'image';
}

/** "1.5" for 1.5 MB: the limit in user-facing errors and messages. */
export function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1).replace(/\.0$/, '');
}

export function extensionlessName(fileName: string): string {
  const name = fileName.replace(/\.[^.]*$/, '').trim();
  return name || fileName;
}
