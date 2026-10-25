import type { Db } from '@agentic-marketing/db';
import { Hono } from 'hono';

// Public asset links: /a/<id>/<file name>. Like /f and /u, the id is the credential: no session and
// no workspace context, so a CDN or e-mail client can fetch the bytes and cache them forever.

type AssetBlobRow = {
  file_name: string;
  content_type: string;
  sha256: string;
  deleted_at: Date | null;
  data: Buffer | null;
};

const NOT_FOUND = { error: 'not_found', message: 'Not found.' };

const headers = (row: AssetBlobRow, data: Uint8Array) => ({
  'Content-Type': row.content_type,
  'Content-Length': String(data.length),
  'Cache-Control': 'public, max-age=31536000, immutable',
  ETag: `"${row.sha256}"`,
  'X-Content-Type-Options': 'nosniff',
  // The bytes are untrusted uploads: never let them load anything or run outside their format.
  'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Content-Disposition': `inline; filename="${row.file_name.replace(/["\\]/g, '\\$&')}"`,
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
    const { rows } = await deps.db.admin.query<AssetBlobRow>(
      `SELECT a.file_name, a.content_type, a.sha256, a.deleted_at, b.data
         FROM assets a
         LEFT JOIN asset_blobs b ON b.workspace_id = a.workspace_id AND b.asset_id = a.id
        WHERE a.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) return c.json(NOT_FOUND, 404);
    if (row.deleted_at) return c.text('This asset was deleted.', 410);
    if (!row.data) return c.json(NOT_FOUND, 404);
    const data = new Uint8Array(row.data);
    const etag = `"${row.sha256}"`;
    if (matches(c.req.header('if-none-match'), etag)) {
      const { 'Content-Length': _length, ...cacheHeaders } = headers(row, data);
      return c.body(null, 304, cacheHeaders);
    }
    return c.body(data, 200, headers(row, data));
  });

  return app;
}
