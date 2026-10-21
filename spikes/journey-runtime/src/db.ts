import pg from 'pg';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://am:am@localhost:5432/am';
export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 40 });

// Participant table = the work queue for approach B. `due_at` is both "ready since" and
// "timer fires at"; a partial index on it is what the sweeper scans.
export async function resetSchema() {
  await pool.query(`
    DROP SCHEMA IF EXISTS jr CASCADE;
    CREATE SCHEMA jr;
    CREATE TABLE jr.participants (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      journey_id text NOT NULL,
      version int NOT NULL,
      profile_id text NOT NULL,
      status text NOT NULL,
      node text NOT NULL,
      seq int NOT NULL DEFAULT 0,
      due_at timestamptz,
      waiting_event text,
      matched boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    ) WITH (fillfactor = 80);
    CREATE UNIQUE INDEX participants_entry ON jr.participants (journey_id, profile_id);
    CREATE INDEX participants_due ON jr.participants (due_at) WHERE status IN ('ready', 'waiting');
    CREATE INDEX participants_waiting_event ON jr.participants (profile_id, waiting_event) WHERE waiting_event IS NOT NULL;
    CREATE TABLE jr.sends (
      participant_id bigint NOT NULL,
      node text NOT NULL,
      seq int NOT NULL,
      template text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (participant_id, node, seq)
    );
  `);
}

export async function enroll(count: number, now: Date, journeyId = 'jrn_welcome') {
  // generate_series keeps the 1M insert in Postgres.
  await pool.query(
    `INSERT INTO jr.participants (journey_id, version, profile_id, status, node, due_at)
     SELECT $1, 1, 'prf_' || g, 'ready', 't1', $2 FROM generate_series(1, $3) g`,
    [journeyId, now, count],
  );
  await pool.query('ANALYZE jr.participants');
}

export async function tableSizes() {
  const { rows } = await pool.query(`
    SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total, pg_size_pretty(pg_relation_size(c.oid)) AS heap
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'jr' AND c.relkind = 'r'`);
  return rows;
}
