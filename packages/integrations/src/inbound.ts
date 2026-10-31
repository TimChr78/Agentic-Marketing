import { timingSafeEqual } from 'node:crypto';
import { type Db, schema } from '@agentic-marketing/db';
import type { EventBus } from '@agentic-marketing/events';
import { acceptItems, bodyLimit, sourceLookups } from '@agentic-marketing/ingest';
import type { KeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { connectionSecrets, connectorOf, inboundTokenHash } from './connections';

// Inbound webhooks: POST /hooks/in/<connection>/<token>. The secret URL authenticates the
// sender, the connector verifies its signature when it has one and maps the payload to
// Segment-spec events, and they go through the same policy and bus as the ingest gateway.

// A provider callout can carry several mapped records; 1 MB covers them and is checked before
// the secret URL is authenticated or the body is read.
const MAX_BODY = 1024 * 1024;

export function inboundApi(deps: { db: Db; bus: EventBus; kp: KeyProvider }) {
  const { loadPolicy } = sourceLookups(deps.db);
  const app = new Hono();
  app.post(
    '/hooks/in/:id/:token',
    // Refuse an oversized delivery before the body is read or the secret URL is authenticated.
    bodyLimit(MAX_BODY, (c) => c.json({ error: 'too_large', message: 'Webhooks are limited to 1 MB.' }, 413)),
    async (c) => {
      const { rows } = await deps.db.admin.query<{ workspace_id: string; token_hash: string | null; enabled: boolean }>(
        'SELECT workspace_id, token_hash, enabled FROM connections WHERE id = $1',
        [c.req.param('id')],
      );
      const r = rows[0];
      const given = Buffer.from(inboundTokenHash(c.req.param('token')));
      if (!r?.enabled || !r.token_hash || given.length !== r.token_hash.length || !timingSafeEqual(given, Buffer.from(r.token_hash)))
        return c.json({ error: 'not_found', message: 'Unknown or disabled webhook URL.' }, 404);

      const raw = await c.req.text();
      const ws = r.workspace_id;
      const conn = await deps.db.withWorkspace(ws, async (tx) => {
        const [x] = await tx
          .select()
          .from(schema.connections)
          .where(eq(schema.connections.id, c.req.param('id')));
        return x ? { row: x, secrets: await connectionSecrets(tx, x, deps.kp) } : null;
      });
      if (!conn) return c.json({ error: 'not_found', message: 'Unknown or disabled webhook URL.' }, 404);
      const connector = connectorOf(conn.row.connector);
      if (!connector.inbound) return c.json({ error: 'not_found', message: 'This connection does not receive webhooks.' }, 404);

      const headers = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
      const ictx = {
        settings: connector.settings.parse(conn.row.settings),
        secrets: connector.secrets.parse(conn.secrets),
        headers,
        body: raw,
      };
      const problem = connector.inbound.verify(ictx);
      if (problem) {
        logger.warn({ connection: conn.row.id, problem }, 'inbound webhook refused');
        return c.json({ error: 'invalid_signature', message: `Refused: ${problem}.` }, 401);
      }
      let payload: unknown;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        return c.json({ error: 'invalid_json', message: 'The body is not JSON.' }, 400);
      }
      let items: unknown[];
      try {
        items = await connector.inbound.map(payload, ictx);
      } catch (err) {
        return c.json({ error: 'mapping_failed', message: `The mapping failed: ${(err as Error).message}` }, 422);
      }
      const source = { id: conn.row.id, workspaceId: ws, kind: 'server' as const, requiredPurpose: null };
      const { accepted, rejected, dropped } = acceptItems(items, source, await loadPolicy(ws));
      const { duplicates } = accepted.length ? await deps.bus.publish(accepted) : { duplicates: 0 };
      if (rejected.length) logger.warn({ connection: conn.row.id, rejected }, 'inbound webhook events rejected');
      return c.json({ success: true, accepted: accepted.length, duplicates, dropped, ...(rejected.length ? { rejected } : {}) });
    },
  );
  return app;
}
