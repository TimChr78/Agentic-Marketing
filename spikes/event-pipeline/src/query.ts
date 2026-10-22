import { Session } from 'chdb';

// Runs the analytics queries against the sink's ClickHouse data directory and reports timings.
const ch = new Session(process.env.CH_PATH!);
const sql = JSON.parse(process.env.QUERIES!) as string[];
const out: Record<string, unknown> = {};
for (const q of sql) {
  const t0 = performance.now();
  const res = JSON.parse(ch.query(q, 'JSONCompact'));
  out[q.replace(/\s+/g, ' ').slice(0, 60)] = { ms: +(performance.now() - t0).toFixed(1), data: res.data };
}
process.send?.({ type: 'query', out });
