import { runBatch } from './sweeper';
import { pool } from './db';

// A sweeper process that kills itself at random points, including with a transaction open.
const now = new Date(process.env.CLOCK!);
const p = Number(process.env.CRASH_P ?? 0.02);
const chaos = () => {
  if (Math.random() < p) process.exit(137);
};
for (;;) {
  const r = await runBatch(now, 500, chaos);
  if (Math.random() < p) process.exit(137); // after commit, before the next claim
  if (!r.participants) break;
}
await pool.end();
