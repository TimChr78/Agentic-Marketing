import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { Button, cx, inputCls } from '../../components/ui';

// A visual composer for a variant: blocks (heading, text, button, image) with a live preview,
// turned into the variant's HTML. The blocks ride along in a data attribute on the wrapper, so
// the variant opens again as blocks; HTML written by hand (or by an agent) stays as it is.

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'button'; text: string; href: string }
  | { kind: 'image'; src: string; alt: string };

export interface Design {
  blocks: Block[];
  align: 'left' | 'center';
  background: string;
  color: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeUrl = (u: string) => (/^(https?:\/\/|\/)/i.test(u.trim()) ? u.trim() : '#');
const COLOR = /^#[0-9a-f]{3,8}$/i;

export function toHtml(d: Design): string {
  const body = d.blocks
    .map((b) => {
      switch (b.kind) {
        case 'heading':
          return `<h2 style="margin:0 0 8px">${esc(b.text)}</h2>`;
        case 'text':
          return `<p style="margin:0 0 12px">${esc(b.text)}</p>`;
        case 'button':
          return `<a href="${esc(safeUrl(b.href))}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:${esc(COLOR.test(d.color) ? d.color : '#111')};color:#fff;text-decoration:none">${esc(b.text)}</a>`;
        case 'image':
          return `<img src="${esc(safeUrl(b.src))}" alt="${esc(b.alt)}" style="max-width:100%;display:block;margin:0 0 12px">`;
      }
    })
    .join('');
  const bg = COLOR.test(d.background) ? d.background : 'transparent';
  return `<div data-am-blocks="${esc(JSON.stringify(d))}" style="padding:16px;text-align:${d.align};background:${bg}">${body}</div>`;
}

/** The design inside HTML the composer wrote, or null for other HTML. */
export function fromHtml(html: string | undefined): Design | null {
  const m = html?.match(/^<div data-am-blocks="([^"]*)"/);
  if (!m) return null;
  try {
    const raw = m[1].replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const d = JSON.parse(raw) as Design;
    return Array.isArray(d.blocks) ? d : null;
  } catch {
    return null;
  }
}

const NEW: Record<Block['kind'], Block> = {
  heading: { kind: 'heading', text: 'A heading' },
  text: { kind: 'text', text: 'Some text.' },
  button: { kind: 'button', text: 'Shop now', href: '/' },
  image: { kind: 'image', src: 'https://', alt: '' },
};

export function Composer({ html, onChange }: { html: string | undefined; onChange: (html: string) => void }) {
  const existing = fromHtml(html);
  const [design, setDesign] = useState<Design>(
    existing ?? { blocks: [{ kind: 'heading', text: 'Your next camp starts here' }], align: 'left', background: '#ffffff', color: '#1f6f43' },
  );
  const [touched, setTouched] = useState(!!existing);
  const update = (d: Design) => {
    setDesign(d);
    setTouched(true);
    onChange(toHtml(d));
  };
  const setBlock = (i: number, b: Block) => update({ ...design, blocks: design.blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, by: number) => {
    const blocks = [...design.blocks];
    const [b] = blocks.splice(i, 1);
    blocks.splice(Math.max(0, Math.min(blocks.length, i + by)), 0, b);
    update({ ...design, blocks });
  };

  return (
    <div className="grid gap-3 p-3">
      {!touched && html !== undefined && (
        <p className="text-[11px] text-muted">This variant has hand-written HTML. Editing blocks here replaces it.</p>
      )}
      {design.blocks.map((b, i) => (
        <div key={i} className="flex items-start gap-2 rounded border border-line p-2">
          <span className="w-16 pt-1.5 text-[11px] uppercase tracking-wider text-muted">{b.kind}</span>
          <div className="grid flex-1 gap-1.5">
            {'text' in b && (
              <input className={inputCls} aria-label={`${b.kind} text`} value={b.text} onChange={(e) => setBlock(i, { ...b, text: e.target.value })} />
            )}
            {b.kind === 'button' && (
              <input className={inputCls} aria-label="Button link" value={b.href} onChange={(e) => setBlock(i, { ...b, href: e.target.value })} />
            )}
            {b.kind === 'image' && (
              <>
                <input className={inputCls} aria-label="Image URL" value={b.src} onChange={(e) => setBlock(i, { ...b, src: e.target.value })} />
                <input className={inputCls} aria-label="Image description" placeholder="Description (alt text)" value={b.alt} onChange={(e) => setBlock(i, { ...b, alt: e.target.value })} />
              </>
            )}
          </div>
          <Button variant="ghost" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
            <ArrowUp size={14} />
          </Button>
          <Button variant="ghost" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === design.blocks.length - 1}>
            <ArrowDown size={14} />
          </Button>
          <Button variant="ghost" aria-label="Remove block" onClick={() => update({ ...design, blocks: design.blocks.filter((_, j) => j !== i) })}>
            <Trash2 size={14} />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {(Object.keys(NEW) as Block['kind'][]).map((k) => (
          <Button key={k} onClick={() => update({ ...design, blocks: [...design.blocks, NEW[k]] })}>
            + {k}
          </Button>
        ))}
        <label className="ml-auto flex items-center gap-1 text-muted">
          Align
          <select className={cx(inputCls, 'w-auto')} value={design.align} onChange={(e) => update({ ...design, align: e.target.value as Design['align'] })}>
            <option value="left">left</option>
            <option value="center">center</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted">
          Background
          <input type="color" aria-label="Background colour" value={design.background} onChange={(e) => update({ ...design, background: e.target.value })} />
        </label>
        <label className="flex items-center gap-1 text-muted">
          Button
          <input type="color" aria-label="Button colour" value={design.color} onChange={(e) => update({ ...design, color: e.target.value })} />
        </label>
      </div>
    </div>
  );
}
