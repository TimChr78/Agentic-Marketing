// GrapesJS treats self-closing <mj-image /> as open tags and escapes characters inside Liquid
// tags; normalise on the way in and out (spike 2), and compare Liquid tokens to catch losses.
export const expandSelfClosing = (m: string) => m.replace(/<(mj-[\w-]+)((?:\s[^>]*?)?)\s*\/>/g, '<$1$2></$1>');
export const unescapeLiquid = (m: string) =>
  m.replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, (t) => t.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
export const liquidTokens = (s: string) => (s.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) ?? []).map((t) => t.replace(/\s+/g, ' ').trim()).sort();
export function lostLiquid(before: string, after: string): string[] {
  const now = liquidTokens(after);
  const rest = [...now];
  return liquidTokens(before).filter((t) => {
    const i = rest.indexOf(t);
    if (i < 0) return true;
    rest.splice(i, 1);
    return false;
  });
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
export const imageTag = (src: string, alt: string) => `<mj-image src="${esc(src)}" alt="${esc(alt)}" />`;
