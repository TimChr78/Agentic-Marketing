import { Session } from 'chdb';
import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { NATS_URL, STREAM, type BusEvent } from './common';

// ClickHouse sink: durable pull consumer → micro-batches (≤ 20k rows or 1 s) → INSERT → ack.
// Ack after insert = at-least-once; a crash between insert and ack re-delivers the batch, and
// ReplacingMergeTree on event_id makes the duplicates collapse.
// ClickHouse runs embedded (chDB, same engine as the server) because the server binaries
// could not be downloaded in this environment; see FINDINGS.md.

const CH_PATH = process.env.CH_PATH!;
const CRASH_AFTER = Number(process.env.CRASH_AFTER_INSERTS ?? 0);
const ch = new Session(CH_PATH);
ch.query(`
  CREATE TABLE IF NOT EXISTS events (
    workspace_id LowCardinality(String),
    event_id String,
    received_at DateTime64(3, 'UTC'),
    ts DateTime64(3, 'UTC'),
    type LowCardinality(String),
    name LowCardinality(String),
    anonymous_id String,
    properties JSON,
    context JSON,
    seq UInt32,
    stream_seq UInt64,
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
  ) ENGINE = ReplacingMergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (workspace_id, name, anonymous_id, ts, event_id)`);

const nc = await connect({ servers: NATS_URL });
const js = jetstream(nc);
const consumer = await js.consumers.get(STREAM, 'ch-sink');
const dec = new TextDecoder();

let inserts = 0;
let rows = 0;
const lagMs: number[] = [];
let stopping = false;
process.on('message', async (m: { cmd: string; sql?: string[] }) => {
  if (m.cmd === 'stop') stopping = true;
  if (m.cmd === 'stats') process.send?.({ type: 'stats', inserts, rows });
  if (m.cmd === 'query') {
    const out: Record<string, unknown> = {};
    for (const sql of m.sql!) {
      const t0 = performance.now();
      const res = ch.query(sql, 'JSONCompact');
      out[sql.replace(/\s+/g, ' ').slice(0, 70)] = { ms: +(performance.now() - t0).toFixed(1), data: JSON.parse(res).data };
    }
    process.send?.({ type: 'query', out });
  }
});

while (!stopping) {
  const buf: string[] = [];
  const msgs: { ack: () => void }[] = [];
  const started = Date.now();
  let oldestReceived = Infinity;
  while (buf.length < 20_000 && Date.now() - started < 1000) {
    const batch = await consumer.fetch({ max_messages: 5000, expires: 1000 });
    for await (const m of batch) {
      const e = JSON.parse(dec.decode(m.data)) as BusEvent;
      oldestReceived = Math.min(oldestReceived, Date.parse(e.receivedAt));
      buf.push(
        JSON.stringify({
          workspace_id: e.workspaceId,
          event_id: e.messageId,
          received_at: e.receivedAt,
          ts: e.timestamp,
          type: e.type,
          name: e.event ?? e.type,
          anonymous_id: e.anonymousId,
          properties: e.properties ?? {},
          context: e.context ?? {},
          seq: e.seq,
          stream_seq: m.seq,
        }),
      );
      msgs.push(m);
    }
  }
  if (!buf.length) continue;
  await ch.insert({ table: 'events', values: buf.join('\n'), format: 'JSONEachRow' });
  inserts++;
  if (CRASH_AFTER && inserts === CRASH_AFTER) process.exit(137); // inserted, not acked
  for (const m of msgs) m.ack();
  rows += buf.length;
  lagMs.push(Date.now() - oldestReceived);
  process.send?.({ type: 'progress', rows, lagMs: lagMs[lagMs.length - 1] });
}
await nc.drain();
lagMs.sort((a, b) => a - b);
process.send?.({ type: 'done', rows, inserts, lagP50: lagMs[Math.floor(lagMs.length / 2)], lagP95: lagMs[Math.floor(lagMs.length * 0.95)] });
