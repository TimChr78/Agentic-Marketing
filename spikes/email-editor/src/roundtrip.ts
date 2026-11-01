import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import mjml2html from 'mjml';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright';

// Round-trip LLM-style MJML templates through GrapesJS (grapesjs-mjml) and Easy Email and
// measure what survives: Liquid tags, MJML validity, rendered text and pixels.
mkdirSync('dist', { recursive: true });
mkdirSync('out', { recursive: true });
const common = {
  bundle: true,
  format: 'iife' as const,
  platform: 'browser' as const,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', global: 'window' },
  loader: { '.css': 'empty', '.scss': 'empty', '.less': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' } as const,
  logLevel: 'error' as const,
};
await build({ ...common, entryPoints: ['src/browser-grapes.ts'], outfile: 'dist/grapes.js' });
await build({ ...common, entryPoints: ['src/browser-easy.ts'], outfile: 'dist/easy.js' });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('pageerror', (e: Error) => console.error('pageerror', e.message.slice(0, 200)));
await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
await page.addScriptTag({ path: 'dist/grapes.js' });
await page.addScriptTag({ path: 'dist/easy.js' });

const liquid = (s: string) => (s.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) ?? []).map((t) => t.replace(/\s+/g, ' ').trim());
const multisetDiff = (a: string[], b: string[]) => {
  const left = [...a];
  const extra: string[] = [];
  for (const t of b) {
    const i = left.indexOf(t);
    if (i >= 0) left.splice(i, 1);
    else extra.push(t);
  }
  return { missing: left, changed: extra };
};

const shotPage = await browser.newPage({ viewport: { width: 700, height: 800 } });
async function render(m: string) {
  const r = await mjml2html(m, { validationLevel: 'soft' });
  await shotPage.setContent(r.html, { waitUntil: 'load' });
  const text = (await shotPage.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim();
  const png = PNG.sync.read(await shotPage.screenshot({ fullPage: true }));
  return { errors: r.errors.length, text, png };
}
function pixelDiff(a: PNG, b: PNG) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const crop = (p: PNG) => {
    const out = new PNG({ width: w, height: h });
    PNG.bitblt(p, out, 0, 0, w, h, 0, 0);
    return out;
  };
  const diff = pixelmatch(crop(a).data, crop(b).data, null, w, h, { threshold: 0.1 });
  const heightDelta = Math.abs(a.height - b.height);
  return +(((diff + heightDelta * w) / (Math.max(a.height, b.height) * w)) * 100).toFixed(2);
}

// Mitigations for GrapesJS found in the first run:
// 1. its HTML parser treats self-closing <mj-image /> etc. as open tags → expand them first;
// 2. text components escape > and < inside Liquid tags → unescape inside {{ }} / {% %} on export.
const expandSelfClosing = (m: string) => m.replace(/<(mj-[\w-]+)((?:\s[^>]*?)?)\s*\/>/g, '<$1$2></$1>');
const unescapeLiquid = (m: string) =>
  m.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, (t) => t.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));

const rows: Record<string, unknown>[] = [];
for (const file of readdirSync('templates').filter((f) => f.endsWith('.mjml')).sort()) {
  const src = readFileSync(`templates/${file}`, 'utf8');
  const original = await render(src);
  for (const editor of ['grapes', 'grapes+fix', 'easy'] as const) {
    for (const edit of [false, true]) {
      let out = '';
      let crash = '';
      try {
        const input = editor === 'grapes+fix' ? expandSelfClosing(src) : src;
        out = await page.evaluate(
          ([fn, m, e]: [string, string, boolean]) => (window as any)[fn](m, e),
          [editor === 'easy' ? 'roundtripEasy' : 'roundtripGrapes', input, edit] as [string, string, boolean],
        );
        if (editor === 'grapes+fix') out = unescapeLiquid(out);
      } catch (e) {
        crash = (e as Error).message.split('\n')[0].slice(0, 120);
      }
      const name = `${file.replace('.mjml', '')}.${editor}${edit ? '.edited' : ''}.mjml`;
      writeFileSync(`out/${name}`, out || `<!-- failed: ${crash} -->`);
      if (crash) {
        rows.push({ template: file, editor, edit, result: `import failed: ${crash}` });
        continue;
      }
      const tokens = multisetDiff(liquid(src), liquid(out));
      const r = await render(out);
      rows.push({
        template: file,
        editor,
        edit,
        liquidKept: `${liquid(src).length - tokens.missing.length}/${liquid(src).length}`,
        liquidMissing: tokens.missing,
        liquidChanged: tokens.changed,
        mjmlErrors: r.errors,
        textIdentical: edit ? undefined : r.text === original.text,
        pixelDiffPct: edit ? undefined : pixelDiff(original.png, r.png),
      });
    }
  }
}
writeFileSync('out/results.json', JSON.stringify(rows, null, 2));
for (const r of rows) console.log(JSON.stringify(r));
await browser.close();
