import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { NATS_URL, WORKSPACE, subjectFor, type BusEvent, type InEvent } from './common';

// Ingest gateway (one process): validate, stamp tenant + received_at, publish to JetStream
// with the event id as message id (server-side dedupe), answer once the bus has acked.
const nc = await connect({ servers: NATS_URL });
const js = jetstream(nc);
const enc = new TextEncoder();

const app = new Hono();
app.post('/v1/batch', async (c) => {
  const body = (await c.req.json()) as { batch?: InEvent[]; consent?: { analytics?: boolean } };
  if (!Array.isArray(body.batch) || body.batch.length > 500) return c.json({ error: 'invalid_batch' }, 400);
  if (body.consent?.analytics === false) return c.json({ accepted: 0, dropped: body.batch.length });
  const receivedAt = new Date().toISOString();
  const acks = [];
  for (const e of body.batch) {
    if (!e.messageId || !e.anonymousId || !e.type) return c.json({ error: 'invalid_event', messageId: e.messageId }, 400);
    const ev: BusEvent = { ...e, workspaceId: WORKSPACE, receivedAt };
    acks.push(js.publish(subjectFor(WORKSPACE, e.anonymousId), enc.encode(JSON.stringify(ev)), { msgID: e.messageId }));
  }
  const res = await Promise.all(acks);
  return c.json({ accepted: res.length, duplicates: res.filter((r) => r.duplicate).length });
});

const port = Number(process.env.PORT ?? 3300);
serve({ fetch: app.fetch, port }, () => process.send?.('ready'));
