import type { Db } from '@agentic-marketing/db';
import { Hono } from 'hono';
import { renditionFileName } from './media';

// Public asset links: /a/<id>/<file name>. Like /f and /u, the id is the credential: no session and
// no workspace context, so a CDN or e-mail client can fetch the bytes and cache them forever.
// For an SVG, the same id with a .png name serves the stored PNG rendition e-mail can use.

type AssetRow = {
  file_name: string;
  content_type: string;
  sha256: string;
  deleted_at: Date | null;
};

type StoredObject = {
  content_type: string;
  sha256: string;
  data: Buffer | null;
};

const NOT_FOUND = { error: 'not_found', message: 'Not found.' };

const headers = (fileName: string, contentType: string, sha256: string, data: Uint8Array) => ({
  'Content-Type': contentType,
  'Content-Length': String(data.length),
  'Cache-Control': 'public, max-age=31536000, immutable',
  ETag: `"${sha256}"`,
  'X-Content-Type-Options': 'nosniff',
  // The bytes are untrusted uploads: never let them load anything or run outside their format.
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Content-Disposition': `inline; filename="${fileName.replace(/["\\]/g, '\\$&')}"`,
});

function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim())
    .some((tag) => tag === '*' || tag === etag || tag === `W/${etag}`);
}

export function assetRoutes(deps: { db: Db }) {
  const app = new Hono();

  app.get('/a/:id/:fileName?', async (c) => {
    const id = c.req.param('id');
    if (!/^ast_[0-9a-f]{32}$/.test(id)) return c.json(NOT_FOUND, 404);
    const { rows } = await deps.db.admin.query<AssetRow>('SELECT file_name, content_type, sha256, deleted_at FROM assets WHERE id = $1', [
      id,
    ]);
    const asset = rows[0];
    if (!asset) return c.json(NOT_FOUND, 404);
    if (asset.deleted_at) return c.text('This asset was deleted.', 410);

    // A .png name on an SVG asset means "the e-mail rendition"; anything else is the original file.
    const wantsRendition = (c.req.param('fileName') ?? '').toLowerCase().endsWith('.png');
    let stored: StoredObject | undefined;
    let name = asset.file_name;
    if (asset.content_type === 'image/svg+xml' && wantsRendition) {
      const rendition = await deps.db.admin.query<StoredObject>(
        "SELECT content_type, sha256, data FROM asset_renditions WHERE asset_id = $1 AND kind = 'png'",
        [id],
      );
      stored = rendition.rows[0];
      name = renditionFileName(asset.file_name);
    } else {
      const blob = await deps.db.admin.query<StoredObject>(
        'SELECT a.content_type, a.sha256, b.data FROM assets a LEFT JOIN asset_blobs b ON b.workspace_id = a.workspace_id AND b.asset_id = a.id WHERE a.id = $1',
        [id],
      );
      stored = blob.rows[0];
    }
    if (!stored?.data) return c.json(NOT_FOUND, 404);

    const data = new Uint8Array(stored.data);
    const etag = `"${stored.sha256}"`;
    if (matches(c.req.header('if-none-match'), etag)) {
      const { 'Content-Length': _length, ...cacheHeaders } = headers(name, stored.content_type, stored.sha256, data);
      return c.body(null, 304, cacheHeaders);
    }
    return c.body(data, 200, headers(name, stored.content_type, stored.sha256, data));
  });

  return app;
}
