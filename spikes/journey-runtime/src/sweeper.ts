import { pool } from './db';
import { advance, welcome, type ParticipantState } from './journey';

// Approach B: the participants table is the queue. Each loop claims a batch of due rows with
// FOR UPDATE SKIP LOCKED, runs the interpreter in memory, and writes new states + sends back
// in the same transaction. Crash anywhere → the transaction rolls back and the rows are due again.

export interface BatchResult {
  participants: number;
  steps: number;
  sends: number;
}

export async function runBatch(now: Date, batchSize: number, chaos?: (phase: 'claimed' | 'written') => void): Promise<BatchResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, node, status, seq, due_at, waiting_event, matched FROM jr.participants
       WHERE status IN ('ready', 'waiting') AND due_at <= $1
       ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, batchSize],
    );
    if (!rows.length) {
      await client.query('COMMIT');
      return { participants: 0, steps: 0, sends: 0 };
    }
    const ids: string[] = [], nodes: string[] = [], statuses: string[] = [], seqs: number[] = [], dues: (Date | null)[] = [], waits: (string | null)[] = [];
    const sId: string[] = [], sNode: string[] = [], sSeq: number[] = [], sTpl: string[] = [];
    let steps = 0;
    for (const r of rows) {
      const p: ParticipantState = { node: r.node, status: r.status, seq: r.seq, dueAt: r.due_at, waitingEvent: r.waiting_event, matched: r.matched };
      const out = advance(welcome, p, now);
      steps += out.steps;
      ids.push(r.id);
      nodes.push(out.state.node);
      statuses.push(out.state.status);
      seqs.push(out.state.seq);
      dues.push(out.state.dueAt);
      waits.push(out.state.waitingEvent);
      for (const s of out.sends) {
        sId.push(r.id);
        sNode.push(s.node);
        sSeq.push(s.seq);
        sTpl.push(s.template);
      }
    }
    chaos?.('claimed');
    await client.query(
      `UPDATE jr.participants p SET node = v.node, status = v.status, seq = v.seq, due_at = v.due_at,
              waiting_event = v.waiting_event, matched = false, updated_at = now()
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::int[], $5::timestamptz[], $6::text[])
            AS v(id, node, status, seq, due_at, waiting_event)
       WHERE p.id = v.id`,
      [ids, nodes, statuses, seqs, dues, waits],
    );
    if (sId.length)
      await client.query(
        `INSERT INTO jr.sends (participant_id, node, seq, template)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::int[], $4::text[]) ON CONFLICT DO NOTHING`,
        [sId, sNode, sSeq, sTpl],
      );
    chaos?.('written'); // updates written, transaction still open
    await client.query('COMMIT');
    return { participants: rows.length, steps, sends: sId.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Run `loops` concurrent sweepers until nothing is due at `now`. */
export async function drain(now: Date, loops: number, batchSize: number) {
  const total: BatchResult = { participants: 0, steps: 0, sends: 0 };
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: loops }, async () => {
      for (;;) {
        const r = await runBatch(now, batchSize);
        if (!r.participants) return;
        total.participants += r.participants;
        total.steps += r.steps;
        total.sends += r.sends;
      }
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  return { ...total, seconds, participantsPerSec: Math.round(total.participants / seconds), stepsPerSec: Math.round(total.steps / seconds) };
}

/** Event matcher: wake participants waiting for `event` for these profiles. */
export async function deliverEvents(profileIds: string[], event: string, now: Date) {
  const { rowCount } = await pool.query(
    `UPDATE jr.participants SET status = 'waiting', due_at = $3, matched = true, waiting_event = NULL
     WHERE profile_id = ANY($1::text[]) AND waiting_event = $2 AND status = 'waiting'`,
    [profileIds, event, now],
  );
  return rowCount ?? 0;
}
