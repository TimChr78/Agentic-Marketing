// Turns the single-file Vite build into a page body for the claude.ai Artifact skeleton,
// which supplies doctype/html/head/body itself. The inlined bundle contains strings such as
// "</head>", so wrapper tags are removed by position (first opener, last closer), not by regex.
import { readFileSync, writeFileSync } from 'node:fs';

let html = readFileSync('dist-single/index.html', 'utf8');

const cutFirst = (s, tag) => {
  const i = s.indexOf(tag);
  return i < 0 ? s : s.slice(0, i) + s.slice(i + tag.length);
};
const cutLast = (s, tag) => {
  const i = s.lastIndexOf(tag);
  return i < 0 ? s : s.slice(0, i) + s.slice(i + tag.length);
};

html = html.replace(/^<!doctype html>\s*/i, '');
html = cutFirst(html, '<html lang="en">');
html = cutFirst(html, '<head>');
html = cutFirst(html, '<meta charset="UTF-8" />');
html = html.replace(/<meta name="viewport"[^>]*>/, '');
for (const tag of ['</html>', '</body>', '<body>', '</head>']) html = cutLast(html, tag);

// Bundled libraries contain literal U+FFFD inside JS strings/regexes; the escape is equivalent there.
html = html.replaceAll('\uFFFD', '\\uFFFD');

// Title first so the 8 KB title scan finds it.
const title = html.match(/<title>[^<]*<\/title>/)[0];
html = `${title}\n${cutFirst(html, title).trim()}\n`;

writeFileSync('dist-single/artifact.html', html);
console.log(`wrote dist-single/artifact.html (${(html.length / 1e6).toFixed(2)} MB)`);
