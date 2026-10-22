import { fork, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { connect } from '@nats-io/transport-node';
import { AckPolicy, DeliverPolicy, jetstreamManager } from '@nats-io/jetstream';
import { NATS_URL, SHARDS, STREAM } from './common';

// Orchestrates: nats-server (JetStream, file storage) · ingest gateway processes · load generator ·
// ClickHouse sink · ordered consumers. Phase 1 uses one ingest process, phase 2 two, and the sink
// is SIGKILLed once between insert and ack to test recovery.
//   pnpm bench [eventsPerPhase=500000]
const PER_PHASE = Number(process.argv[2] ?? 500_000);
const DATA = process.env.DATA_DIR ?? '/tmp/event-pipeline';
const NATS_BIN = process.env.NATS_BIN ?? '/opt/spike-bin/nats-server';
const log = (label: string, data: unknown) => console.log(`${label.padEnd(36)} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

rmSync(DATA, { recursive: true, force: true });
mkdirSync(`${DATA}/nats`, { recursive: true });

const nats = spawn(NATS_BIN, ['-js', '-sd', `${DATA}/nats`, '-p', '4222', '-m', '8222'], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try {
    await (await connect({ servers: NATS_URL })).close();
    break;
  } catch {
    await sleep(100);
  }
}
const nc = await connect({ servers: NATS_URL });
const jsm = await jetstreamManager(nc);
await jsm.streams.add({
  name: STREAM,
  subjects: ['events.>'],
  storage: 'file' as never,
  duplicate_window: 120_000_000_000, // 2 min, nanoseconds
  max_age: 7 * 24 * 3600 * 1_000_000_000,
});
// ack_wait 5 s: messages held by a crashed sink are redelivered after 5 s (default 30 s).
await jsm.consumers.add(STREAM, { durable_name: 'ch-sink', ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, max_ack_pending: 60_000, ack_wait: 5_000_000_000 });
for (let s = 0; s < SHARDS; s++)
  await jsm.consumers.add(STREAM, { durable_name: `ordered-${s}`, ack_policy: AckPolicy.Explicit, filter_subject: `events.*.${s}`, max_ack_pending: 1000 });

const forkTs = (file: string, env: Record<string, string> = {}) => fork(file, [], { execArgv: ['--import', 'tsx'], env: { ...process.env, ...env } });
const once = <T>(child: ChildProcess, type?: string) =>
  new Promise<T>((resolve) => {
    const h = (m: any) => {
      if (!type || m === type || m?.type === type) {
        child.off('message', h);
        resolve(m);
      }
    };
    child.on('message', h);
  });

let sinkRows = 0;
const lags: number[] = [];
const startSink = (env: Record<string, string> = {}) => {
  const s = forkTs('src/sink.ts', { CH_PATH: `${DATA}/clickhouse`, ...env });
  s.on('message', (m: any) => {
    if (m.type === 'progress') {
      sinkRows = m.rows;
      lags.push(m.lagMs);
    }
  });
  return s;
};
let sink = startSink();
console.log('stream, consumers and sink ready');
const ordered = forkTs('src/ordered.ts');

async function phase(label: string, ingestProcesses: number, offset: number, extra?: () => Promise<void>) {
  const ingest = Array.from({ length: ingestProcesses }, (_, i) => forkTs('src/ingest.ts', { PORT: String(3300 + i) }));
  await Promise.all(ingest.map((p) => once(p, 'ready')));
  console.log(`${label}: ingest ready`);
  const lg = forkTs('src/loadgen.ts', {
    TOTAL: String(PER_PHASE),
    OFFSET: String(offset),
    INGEST_URLS: ingest.map((_, i) => `http://127.0.0.1:${3300 + i}`).join(','),
  });
  const extraDone = extra?.();
  const result = await once(lg, undefined);
  log(`${label}: ingest → JetStream`, result);
  await extraDone;
  ingest.forEach((p) => p.kill());
}

// Phase 1: one ingest process.
await phase('phase 1 (1 ingest process)', 1, 0);

// Phase 2: two ingest processes; kill the sink once right after an insert, before its ack.
await phase('phase 2 (2 ingest processes)', 2, PER_PHASE, async () => {
  await sleep(1500);
  sink.kill('SIGKILL');
  log('sink SIGKILLed mid-stream', { rowsAckedBefore: sinkRows });
  await sleep(500);
  // Restart a sink that exits right after its 2nd insert, before acking it (only if work is left).
  const pending = (await jsm.consumers.info(STREAM, 'ch-sink')).num_pending;
  if (pending > 0) {
    sink = startSink({ CRASH_AFTER_INSERTS: '1' });
    await new Promise((r) => sink.once('exit', r));
    log('sink exited after insert, before ack', { code: sink.exitCode, pendingBefore: pending });
  }
  sink = startSink();
});

// Wait for the sink to catch up.
const total = PER_PHASE * 2;
const info = async () => (await jsm.consumers.info(STREAM, 'ch-sink')).num_pending + (await jsm.consumers.info(STREAM, 'ch-sink')).num_ack_pending;
const waitStart = Date.now();
while ((await info()) > 0) await sleep(250);
log('sink caught up after load ended', { seconds: (Date.now() - waitStart) / 1000 });

sink.send({ cmd: 'stop' });
await once<any>(sink, 'done');
sink.kill();
await new Promise((r) => sink.once('exit', r));
lags.sort((a, b) => a - b);
log('sink: ingest → ClickHouse lag per batch', { batches: lags.length, p50: lags[Math.floor(lags.length / 2)], p95: lags[Math.floor(lags.length * 0.95)], max: lags[lags.length - 1] });

ordered.send({ cmd: 'stop' });
log('ordered consumers (16 shards)', await once(ordered, 'done'));

const stream = await jsm.streams.info(STREAM);
log('JetStream stream', { messages: stream.state.messages, mb: +(stream.state.bytes / 1e6).toFixed(1) });

// Queries run in their own process (chDB holds the data directory; the sink has stopped).
const queries = [
  `SELECT count() AS rows, uniqExact(event_id) AS unique_events FROM events`,
  `SELECT count() FROM events FINAL`,
  `SELECT formatReadableSize(sum(bytes_on_disk)) AS on_disk, formatReadableSize(sum(data_uncompressed_bytes)) AS raw FROM system.parts WHERE table = 'events' AND active`,
  `SELECT count() AS profiles FROM (SELECT anonymous_id FROM events WHERE name = 'product_viewed' AND properties.category = 'shoes' GROUP BY anonymous_id HAVING count() >= 3)`,
  `SELECT level, count() FROM (SELECT windowFunnel(86400 * 7)(toDateTime(ts), name = 'product_viewed', name = 'product_added', name = 'checkout_started', name = 'order_completed') AS level FROM events GROUP BY anonymous_id) GROUP BY level ORDER BY level`,
  `SELECT toDate(ts) AS day, count() FROM events GROUP BY day ORDER BY day LIMIT 3`,
];
const qp = forkTs('src/query.ts', { CH_PATH: `${DATA}/clickhouse`, QUERIES: JSON.stringify(queries) });
const qr = await once<any>(qp, 'query');
for (const [sql, r] of Object.entries(qr.out)) log(`query: ${sql}`, r);

await nc.close();
nats.kill();
log('expected events', { total });
process.exit(0);
