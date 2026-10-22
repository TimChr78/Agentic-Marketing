import { generateEvents } from './common';

// Load generator: POST /v1/batch with `BATCH` events per request, `CONCURRENCY` requests in flight.
const TOTAL = Number(process.env.TOTAL ?? 1_000_000);
const PROFILES = Number(process.env.PROFILES ?? 100_000);
const BATCH = Number(process.env.BATCH ?? 50);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const URLS = (process.env.INGEST_URLS ?? 'http://127.0.0.1:3300').split(',');

const gen = generateEvents(TOTAL, PROFILES, Date.UTC(2026, 9, 1), Number(process.env.OFFSET ?? 0));
const latencies: number[] = [];
let sent = 0;
let req = 0;
const t0 = performance.now();

async function worker() {
  for (;;) {
    const batch = [];
    for (let i = 0; i < BATCH; i++) {
      const n = gen.next();
      if (n.done) break;
      batch.push(n.value);
    }
    if (!batch.length) return;
    const url = `${URLS[req++ % URLS.length]}/v1/batch`;
    const s = performance.now();
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batch }) });
    if (!res.ok) throw new Error(`ingest ${res.status}: ${await res.text()}`);
    await res.arrayBuffer();
    latencies.push(performance.now() - s);
    sent += batch.length;
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - t0) / 1000;
latencies.sort((a, b) => a - b);
const pct = (q: number) => +latencies[Math.floor(latencies.length * q)].toFixed(1);
process.send?.({ sent, seconds: +seconds.toFixed(1), eventsPerSec: Math.round(sent / seconds), requestMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) } });
