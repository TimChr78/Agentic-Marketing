# Spike 3 — Journey runtime on Postgres: 1M waiting participants, timers, crashes

**Question:** can a journey runtime on plain Postgres hold a million participants in long waits, fire their timers, match events to waiting participants and survive crashes without losing anyone or sending twice? And should every step be a Graphile Worker job ([ADR-0004](../../docs/architecture/adr/0004-journey-runtime.md))?

**Answer:** Postgres is more than enough, but **not with one job per step**. Treating the participants table itself as the queue, and claiming due participants in batches with `FOR UPDATE SKIP LOCKED`, was about **50× faster** than one Graphile Worker job per wake-up. It also recovers from crashes immediately, where a hard-killed Graphile Worker leaves its locked jobs stuck for 4 hours. ADR-0004 is updated accordingly.

Machine: 4 vCPU / 15 GB, Postgres 16 and the benchmark on the same box (`shared_buffers=2GB`, durable commits). Journey: the welcome series from the demo, i.e. trigger → e-mail → wait 2 days → wait for click (2-day timeout) → tips or code e-mail → goal. A virtual clock moves time forward.

## Approach B — participants table as the queue (recommended)

`src/sweeper.ts`: N concurrent loops each claim up to 500 due rows (`status IN ('ready','waiting') AND due_at <= now ORDER BY due_at FOR UPDATE SKIP LOCKED`), run the interpreter in memory until each participant waits or finishes, and write new states plus sends back with two `unnest` statements in the same transaction. `due_at` is both "ready since" and "timer fires at", so timers need no separate scheduler.

1,000,000 participants, 8 loops × batch 500 (`pnpm bench 1000000`):

| Stage | Result |
|---|---|
| Enroll 1M participants | 12.0 s (83k/s) |
| Trigger → e-mail → wait 2 days | 22.6 s · **44k participants/s** · 132k node executions/s · 1M sends written |
| Sweep with 1M waiting and nothing due | < 1 ms (partial index on `due_at`) |
| Timers fire → wait for click | 20.3 s · 49k participants/s |
| 300k click events matched to waiting participants | 5.9 s · **51k events/s** |
| Clicked → tips e-mail → goal | 6.5 s · 46k participants/s |
| Click timeout → code e-mail → goal | 14.9 s · 47k participants/s |
| Verification | 1,000,000 completed · 2,000,000 sends · 0 participants without exactly two sends |
| Storage | participants 463 MB (260 MB heap), sends 193 MB, for 1M |

### Crash test (`pnpm crash 200000`)

4 sweeper processes that `exit(137)` at random points (2% per batch, both **with the transaction open** and right after commit), plus a supervisor that **SIGKILLs** random workers every 0.3–1.8 s; workers are restarted until each stage is drained.

Result over the full journey: 85 self-crashes, 46 SIGKILLs → **200,000 completed, 400,000 sends, 0 missing, 0 duplicated.** A dead process's transaction is rolled back by Postgres and its row locks vanish at once, so the rows are simply due again; `(participant, node, seq)` as the send key makes re-execution harmless.

## Approach A — one Graphile Worker job per wake-up

`src/bench-graphile.ts`: each wake-up is a job; the task locks the participant, runs the interpreter, writes state and sends, and enqueues the next job (timers as `run_at` in the future) in the same transaction. 100,000 participants, concurrency 24:

| Stage | Result |
|---|---|
| Trigger → e-mail → wait 2 days | 114.6 s · **~870 participants/s** |
| Timers fire → wait for click | 112.8 s · ~890 participants/s |
| Queue | 100k future jobs held in `graphile_worker._private_jobs` |

Findings:
- **~50× slower** than batching: per participant it pays a job fetch, five round trips and a job completion. Graphile Worker can be tuned (local queue, batched completion), but a per-participant job is the wrong grain for journeys.
- **Crash recovery:** jobs locked by a worker that dies hard (SIGKILL, OOM, lost node) are only retried after `job_expiry` = **4 hours**. Graceful shutdown releases them; hard crashes don't. For journey timing that is unacceptable.
- **Bulk enqueue pitfall:** `SELECT add_job(...) FROM participants` for 100k rows ran > 10 minutes and was cancelled; `add_jobs()` with 5k-row batches took 2.4 s.

## What this means for 10M profiles

- A single modest Postgres handles ~45k participant transitions/s. A campaign that enrols 1M people moves everyone to their first wait in under 30 s; actual e-mail sending will be limited by the provider, not the runtime.
- Waiting participants are cheap: ~0.5 KB per row including indexes, so 10M waiting ≈ 5 GB. An idle sweep stays sub-millisecond.
- Scaling path: more sweeper loops/processes first; then hash-partition `participants` by journey or workspace; Temporal is no longer the expected next step.

## Not covered (follow-ups for Phase 0/2)

- **Slow or external steps** (LLM calls, webhooks) must not run inside the batch transaction. Plan: the batch moves the participant to `awaiting_external`, a separate worker does the call and writes the result back as an event (same pattern as event matching).
- **Fairness across workspaces:** one global `ORDER BY due_at` lets a huge campaign delay a small workspace. Claim per workspace (round-robin) or partition the table.
- **Sends** go to an outbox here; delivering them (rate limits per provider, retries) is a separate batched worker, same pattern.
- **Many journey versions:** the interpreter caches the pinned version graph per `(journey, version)`.
- **Vacuum:** heavy UPDATE churn; `fillfactor=80` keeps updates HOT; autovacuum settings need production tuning.
- **Step history** for analytics (one row per node execution) is written to ClickHouse via the outbox, not to Postgres.

## Run it

```bash
pnpm install
pnpm --filter @agentic-marketing/spike-journey-runtime bench 1000000   # approach B
pnpm --filter @agentic-marketing/spike-journey-runtime crash 200000    # crash test
pnpm --filter @agentic-marketing/spike-journey-runtime exec tsx src/bench-graphile.ts 100000 24   # approach A
```

Uses `DATABASE_URL` (default `postgres://am:am@localhost:5432/am`) and recreates the `jr` schema on each run.
