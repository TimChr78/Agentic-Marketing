import { AppError } from '@agentic-marketing/core';
import { Parser } from 'htmlparser2';
import { type ImageSize, svgSizeFromAttributes } from './media';

// SVG uploads are untrusted XML. This sanitiser keeps a small allow-list of drawing elements and
// attributes, drops everything else, and never resolves entities or DOCTYPEs. The cleaned tree is
// serialised again, so an attribute cannot survive by being spelled in a way the checks miss.

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const MAX_ELEMENTS = 10_000;
const MAX_DEPTH = 512;

const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
  'title',
  'desc',
  'style',
  'symbol',
]);

// Geometry, presentation, identity and accessibility. Event handlers, links, scripts and filters
// are deliberately absent: anything not named here is removed.
const ALLOWED_ATTRIBUTES = new Set([
  'id',
  'class',
  'viewBox',
  'preserveAspectRatio',
  'version',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'd',
  'points',
  'pathLength',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'opacity',
  'color',
  'display',
  'visibility',
  'overflow',
  'transform',
  'transform-origin',
  'vector-effect',
  'paint-order',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
  'mask',
  'maskUnits',
  'maskContentUnits',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'letter-spacing',
  'word-spacing',
  'writing-mode',
  'direction',
  'unicode-bidi',
  'text-decoration',
  'text-rendering',
  'shape-rendering',
  'image-rendering',
  'color-interpolation',
  'color-interpolation-filters',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-labelledby',
  'xml:space',
]);

const DRAWABLE = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use']);

type Element = { type: 'element'; name: string; attributes: Record<string, string>; children: Node[] };
type Text = { type: 'text'; text: string };
type Node = Element | Text;

export interface SanitisedSvg {
  svg: string;
  size: ImageSize | null;
  /** What was removed, for the upload response: "script", "onload attribute", "style with @import", … */
  sanitized: string[];
}

/** The CSS we allow inside <style> and style="": no imports, no external URLs, no expression(). */
function unsafeCss(css: string): string | null {
  if (/@import/i.test(css)) return '@import';
  // Any other at-rule or a CSS escape could hide an import from this check; drop the block.
  if (/@/.test(css)) return '@rule';
  if (/\\/.test(css)) return 'CSS escape';
  if (/expression\s*\(/i.test(css)) return 'expression()';
  if (/javascript:/i.test(css)) return 'javascript:';
  if (/-moz-binding/i.test(css)) return 'binding';
  if (externalUrl(css)) return 'external url()';
  return null;
}

/**
 * Every url( must point inside the document (#id). Checked on the opening, not on a matched pair:
 * CSS accepts an unterminated url( at the end of a value, which a (…) pattern would miss.
 */
function externalUrl(value: string): boolean {
  return /url\(\s*(?!['"]?\s*#)/i.test(value);
}

/** An attribute value may use url(#id) but nothing outside the document. */
function unsafeValue(value: string): string | null {
  if (/javascript:/i.test(value)) return 'javascript:';
  if (/expression\s*\(/i.test(value)) return 'expression()';
  if (externalUrl(value)) return 'external url()';
  return null;
}

function internalReference(value: string): boolean {
  return /^#[A-Za-z_][\w:.-]*$/.test(value.trim());
}

function serialise(node: Node): string {
  if (node.type === 'text') return node.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`)
    .join('');
  if (!node.children.length) return `<${node.name}${attributes}/>`;
  return `<${node.name}${attributes}>${node.children.map(serialise).join('')}</${node.name}>`;
}

function hasDrawable(element: Element): boolean {
  if (DRAWABLE.has(element.name)) return true;
  return element.children.some((child) => child.type === 'element' && hasDrawable(child));
}

/**
 * Parse, clean and serialise an SVG. Throws AppError for a DOCTYPE (entity expansion), a root that
 * is not <svg>, more than 10,000 elements, or a result with nothing drawable in it.
 */
export function sanitiseSvg(data: Buffer): SanitisedSvg {
  const source = data.toString('utf8');
  if (/<!doctype/i.test(source)) {
    throw new AppError(
      'invalid_input',
      'SVG files with a DOCTYPE are refused: a DOCTYPE can define entities that expand on the server. Remove it and upload the file again.',
    );
  }

  const document: { root: Element | null; roots: number } = { root: null, roots: 0 };
  let elements = 0;
  let usesXlink = false;
  const stack: Element[] = [];
  const removed = new Set<string>();

  const addRemoved = (name: string) => {
    removed.add(name);
  };

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        elements += 1;
        if (elements > MAX_ELEMENTS) {
          throw new AppError(
            'invalid_input',
            `The SVG has more than ${MAX_ELEMENTS.toLocaleString('en-US')} elements. Simplify the artwork and upload it again.`,
          );
        }
        const element: Element = { type: 'element', name, attributes: { ...attributes }, children: [] };
        const parent = stack.at(-1);
        if (parent) parent.children.push(element);
        else {
          document.roots += 1;
          if (!document.root) document.root = element;
        }
        if (stack.length >= MAX_DEPTH) {
          throw new AppError('invalid_input', `The SVG is nested more than ${MAX_DEPTH} levels deep. Simplify the artwork.`);
        }
        stack.push(element);
      },
      ontext(text) {
        const parent = stack.at(-1);
        if (parent && text) parent.children.push({ type: 'text', text });
      },
      onclosetag() {
        stack.pop();
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );
  parser.write(source);
  parser.end();

  if (document.roots !== 1 || !document.root || document.root.name.toLowerCase() !== 'svg') {
    throw new AppError('invalid_input', 'The file is not an SVG: its XML root element must be <svg>.');
  }
  const root = document.root;

  const clean = (element: Element): Element | null => {
    if (!ALLOWED_ELEMENTS.has(element.name)) {
      addRemoved(element.name);
      return null;
    }
    if (element.name === 'style') {
      const css = element.children.map((child) => (child.type === 'text' ? child.text : '')).join('');
      const problem = unsafeCss(css);
      if (problem) {
        addRemoved(`style with ${problem}`);
        return null;
      }
    }

    const attributes: Record<string, string> = {};
    for (const [name, value] of Object.entries(element.attributes)) {
      if (name.toLowerCase().startsWith('on')) {
        addRemoved(`${name} attribute`);
        continue;
      }
      if (name === 'style') {
        const problem = unsafeCss(value);
        if (problem) {
          addRemoved(`style attribute with ${problem}`);
          continue;
        }
        attributes[name] = value;
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        if (element.name === 'use' && internalReference(value)) {
          attributes[name] = value.trim();
          if (name === 'xlink:href') usesXlink = true;
        } else addRemoved(`${name} attribute`);
        continue;
      }
      if (name === 'xmlns') {
        if (value === SVG_NS) attributes[name] = value;
        else addRemoved('xmlns attribute');
        continue;
      }
      if (name === 'xmlns:xlink') {
        if (value === XLINK_NS) attributes[name] = value;
        else addRemoved('xmlns:xlink attribute');
        continue;
      }
      if (!ALLOWED_ATTRIBUTES.has(name)) {
        addRemoved(`${name} attribute`);
        continue;
      }
      const problem = unsafeValue(value);
      if (problem) {
        addRemoved(`${name} attribute with ${problem}`);
        continue;
      }
      attributes[name] = value;
    }

    const children: Node[] = [];
    for (const child of element.children) {
      if (child.type === 'text') children.push(child);
      else {
        const cleaned = clean(child);
        if (cleaned) children.push(cleaned);
      }
    }
    return { type: 'element', name: element.name, attributes, children };
  };

  const cleanRoot = clean(root);
  if (!cleanRoot) throw new AppError('invalid_input', 'The SVG could not be read. Upload a different file.');

  const size = svgSizeFromAttributes(root.attributes) ?? svgSizeFromAttributes(cleanRoot.attributes);
  if (!hasDrawable(cleanRoot)) {
    const removedHint = removed.size ? ` after removing unsafe parts (${[...removed].join(', ')})` : '';
    throw new AppError('invalid_input', `The SVG has no drawable content${removedHint}. Upload an SVG with a path, shape or text.`);
  }

  cleanRoot.name = 'svg';
  // A standalone file needs the SVG namespace to render outside an HTML document.
  if (!cleanRoot.attributes.xmlns) cleanRoot.attributes = { xmlns: SVG_NS, ...cleanRoot.attributes };
  if (usesXlink && !cleanRoot.attributes['xmlns:xlink']) cleanRoot.attributes['xmlns:xlink'] = XLINK_NS;

  return { svg: serialise(cleanRoot), size, sanitized: [...removed] };
}
