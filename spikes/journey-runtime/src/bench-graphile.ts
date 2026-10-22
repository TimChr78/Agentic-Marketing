import { makeWorkerUtils, run, type Task } from 'graphile-worker';
import { DATABASE_URL, enroll, pool, resetSchema } from './db';
import { advance, welcome, type ParticipantState } from './journey';

// Approach A: one Graphile Worker job per participant wake-up. State change and the next
// job (incl. future timer jobs via run_at) are written in one transaction.
//   pnpm tsx src/bench-graphile.ts [participants=100000] [concurrency=24]
const N = Number(process.argv[2] ?? 100_000);
const CONCURRENCY = Number(process.argv[3] ?? 24);
const H = 3_600_000;
let clock = new Date('2026-11-01T08:00:00Z');
let processed = 0;

const step: Task = async (payload) => {
  const { id, seq } = payload as { id: string; seq: number };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [r] } = await client.query('SELECT node, status, seq, due_at, waiting_event, matched FROM jr.participants WHERE id = $1 FOR UPDATE', [id]);
    if (!r || r.seq !== seq || r.status === 'completed') {
      await client.query('COMMIT'); // duplicate or stale job: the step already ran
      return;
    }
    const p: ParticipantState = { node: r.node, status: r.status, seq: r.seq, dueAt: r.due_at, waitingEvent: r.waiting_event, matched: r.matched };
    const out = advance(welcome, p, clock);
    await client.query('UPDATE jr.participants SET node=$2, status=$3, seq=$4, due_at=$5, waiting_event=$6, matched=false WHERE id=$1', [
      id, out.state.node, out.state.status, out.state.seq, out.state.dueAt, out.state.waitingEvent,
    ]);
    for (const s of out.sends)
      await client.query('INSERT INTO jr.sends (participant_id, node, seq, template) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, s.node, s.seq, s.template]);
    if (out.state.status === 'waiting')
      await client.query(`SELECT graphile_worker.add_job('step', json_build_object('id', $1::bigint, 'seq', $2::int), run_at := $3)`, [id, out.state.seq, out.state.dueAt]);
    await client.query('COMMIT');
    processed++;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

async function waitForQueue() {
  const t0 = performance.now();
  const start = processed;
  for (;;) {
    const { rows: [q] } = await pool.query(`SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE run_at <= now() AND locked_at IS NULL`);
    const { rows: [l] } = await pool.query(`SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE locked_at IS NOT NULL`);
    if (q.n === 0 && l.n === 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const seconds = (performance.now() - t0) / 1000;
  return { participants: processed - start, seconds: +seconds.toFixed(1), participantsPerSec: Math.round((processed - start) / seconds) };
}

console.log(`approach A (Graphile Worker job per wake-up) · ${N.toLocaleString('en')} participants · concurrency ${CONCURRENCY}\n`);
await resetSchema();
const utils = await makeWorkerUtils({ connectionString: DATABASE_URL });
await utils.migrate();
await pool.query('TRUNCATE graphile_worker._private_jobs CASCADE');
await enroll(N, clock);

const runner = await run({ connectionString: DATABASE_URL, concurrency: CONCURRENCY, noHandleSignals: true, pollInterval: 200, taskList: { step } });
const t0 = performance.now();
// Batch API in chunks: 100k add_job() calls in one statement took >10 min (see FINDINGS.md).
for (let from = 0; from < N; from += 5000)
  await pool.query(
    `SELECT graphile_worker.add_jobs(array_agg(('step', json_build_object('id', id, 'seq', seq), null, null, null, null, null, null)::graphile_worker.job_spec))
     FROM jr.participants WHERE id > $1 AND id <= $2`,
    [from, from + 5000],
  );
console.log('enqueue first jobs                ', { seconds: +((performance.now() - t0) / 1000).toFixed(1) });
console.log('1. trigger → e-mail → wait 2d     ', await waitForQueue());

const { rows: [f] } = await pool.query(`SELECT count(*)::int AS n FROM graphile_worker._private_jobs WHERE run_at > now()`);
console.log('   future timer jobs in queue     ', f.n);

// Fast-forward: make all timers due now.
clock = new Date(clock.getTime() + 48 * H);
await pool.query(`UPDATE graphile_worker._private_jobs SET run_at = now()`);
console.log('2. timers fire → wait for click   ', await waitForQueue());

await runner.stop();
await utils.release();
const { rows: [v] } = await pool.query(`SELECT (SELECT count(*) FROM jr.sends)::int AS sends, (SELECT count(*) FROM jr.participants WHERE node = 'b1')::int AS waiting_for_click`);
console.log('verify                            ', v);
await pool.end();
