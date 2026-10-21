import { spawn } from 'node:child_process';
import { enroll, pool, resetSchema } from './db';
import { deliverEvents } from './sweeper';

// Crash test for approach B: 4 sweeper processes that exit at random points (also mid-
// transaction) and are SIGKILLed by this supervisor; restarted until the stage is drained.
const N = Number(process.argv[2] ?? 200_000);
const H = 3_600_000;
const T0 = new Date('2026-11-01T08:00:00Z');
let crashes = 0;
let kills = 0;

async function due(clock: Date) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM jr.participants WHERE status IN ('ready','waiting') AND due_at <= $1`, [clock]);
  return rows[0].n as number;
}

async function stage(label: string, clock: Date) {
  const t0 = performance.now();
  while ((await due(clock)) > 0) {
    const workers = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/chaos-worker.ts'], {
        env: { ...process.env, CLOCK: clock.toISOString(), CRASH_P: '0.02' },
        stdio: 'inherit',
      });
      const killer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          kills++;
        }
      }, 300 + Math.random() * 1500);
      return new Promise<void>((resolve) =>
        child.on('exit', (code, signal) => {
          clearTimeout(killer);
          if (code === 137 && !signal) crashes++;
          resolve();
        }),
      );
    });
    await Promise.all(workers);
  }
  console.log(`${label.padEnd(30)} drained in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

await resetSchema();
await enroll(N, T0);
await stage('trigger → wait 2d', T0);
const T1 = new Date(T0.getTime() + 48 * H);
await stage('timers → wait for click', T1);
const clickers = Array.from({ length: Math.round(N * 0.3) }, (_, i) => `prf_${i * 3 + 1}`);
for (let i = 0; i < clickers.length; i += 2000) await deliverEvents(clickers.slice(i, i + 2000), 'email_clicked', new Date(T1.getTime() + H));
await stage('clicked → goal', new Date(T1.getTime() + H));
await stage('timeout → goal', new Date(T1.getTime() + 49 * H));

const { rows: [v] } = await pool.query(`
  SELECT (SELECT count(*) FROM jr.participants WHERE status = 'completed')::int AS completed,
         (SELECT count(*) FROM jr.sends)::int AS sends,
         (SELECT count(*) FROM (SELECT participant_id FROM jr.sends GROUP BY participant_id HAVING count(*) <> 2) x)::int AS wrong_send_count,
         (SELECT count(*) FROM (SELECT participant_id, node FROM jr.sends GROUP BY 1, 2 HAVING count(*) > 1) x)::int AS duplicate_sends`);
console.log(JSON.stringify({ participants: N, selfCrashes: crashes, sigkills: kills, ...v }));
console.log(v.completed === N && v.sends === 2 * N && v.wrong_send_count === 0 && v.duplicate_sends === 0 ? 'PASS: no lost participants, no duplicate or missing sends' : 'FAIL');
await pool.end();
