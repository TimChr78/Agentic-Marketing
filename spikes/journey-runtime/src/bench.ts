import { enroll, pool, resetSchema, tableSizes } from './db';
import { deliverEvents, drain, runBatch } from './sweeper';

// Approach B benchmark: N participants through the full welcome journey with a virtual clock.
//   pnpm bench [participants=1000000] [loops=8] [batch=500]
const N = Number(process.argv[2] ?? 1_000_000);
const LOOPS = Number(process.argv[3] ?? 8);
const BATCH = Number(process.argv[4] ?? 500);
const H = 3_600_000;

const log = (label: string, data: unknown) => console.log(`${label.padEnd(34)} ${JSON.stringify(data)}`);
const timed = async <T>(fn: () => Promise<T>) => {
  const t0 = performance.now();
  const r = await fn();
  return { r, seconds: +((performance.now() - t0) / 1000).toFixed(2) };
};

const T0 = new Date('2026-11-01T08:00:00Z');
console.log(`approach B (table-as-queue) · ${N.toLocaleString('en')} participants · ${LOOPS} loops × batch ${BATCH}\n`);

await resetSchema();
const e = await timed(() => enroll(N, T0));
log('1. enroll (bulk insert)', { seconds: e.seconds, perSec: Math.round(N / e.seconds) });

log('2. trigger → e-mail → wait 2d', await drain(T0, LOOPS, BATCH));

// Sweeper cost when a million participants wait and nothing is due.
const idle = await timed(() => runBatch(new Date(T0.getTime() + H), BATCH));
log('   idle sweep (1M waiting, 0 due)', { ms: Math.round(idle.seconds * 1000), claimed: idle.r.participants });

const T1 = new Date(T0.getTime() + 48 * H);
log('3. timers fire → wait for click', await drain(T1, LOOPS, BATCH));

// 30% of people click the welcome e-mail within the window.
const clickers = Array.from({ length: Math.round(N * 0.3) }, (_, i) => `prf_${i * 3 + 1}`);
const T1b = new Date(T1.getTime() + H);
const ev = await timed(async () => {
  let woken = 0;
  for (let i = 0; i < clickers.length; i += 2000) woken += await deliverEvents(clickers.slice(i, i + 2000), 'email_clicked', T1b);
  return woken;
});
log('4. click events matched', { events: clickers.length, woken: ev.r, seconds: ev.seconds, eventsPerSec: Math.round(clickers.length / ev.seconds) });

log('5. clicked → tips e-mail → goal', await drain(T1b, LOOPS, BATCH));
const T2 = new Date(T1.getTime() + 49 * H);
log('6. click timeout → code e-mail → goal', await drain(T2, LOOPS, BATCH));

const { rows: [check] } = await pool.query(`
  SELECT (SELECT count(*) FROM jr.participants WHERE status = 'completed')::int AS completed,
         (SELECT count(*) FROM jr.participants WHERE status <> 'completed')::int AS not_completed,
         (SELECT count(*) FROM jr.sends)::int AS sends,
         (SELECT count(*) FROM (SELECT participant_id FROM jr.sends GROUP BY participant_id HAVING count(*) <> 2) x)::int AS participants_without_exactly_two_sends`);
log('7. verify', check);
log('   table sizes', await tableSizes());
await pool.end();
