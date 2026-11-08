import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Sol's Phase 28 review: a phone list must reserve its own 72 px rows while loading, not the
// desktop gallery's tiles, or the page collapses when results arrive (ContentList, Assets).
describe('Assets loading geometry (#555)', () => {
  const source = readFileSync(join(process.cwd(), 'apps/web/src/pages/design/AssetsPage.tsx'), 'utf8');
  const loading = source.slice(source.indexOf('loadingContent='), source.indexOf('desktopTable='));

  it('reserves the phone rows below md and keeps the gallery tiles from md', () => {
    expect(loading).toContain('<PhoneListSkeleton');
    expect(loading).toMatch(/<div className="hidden md:block">\s*<GallerySkeleton/);
  });
});
