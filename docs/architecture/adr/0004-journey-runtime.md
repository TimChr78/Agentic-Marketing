# ADR-0004: Journey runtime on Postgres — participants table as a batched queue

- Status: Accepted (revised after spike 3)
- Date: 2026-10-21

## Context
Journeys need durable waits (minutes to months), event waits with timeouts, retries, exactly-once *effects*, and millions of concurrent participants. Options: a durable execution engine (Temporal, Restate, Hatchet, DBOS), a job queue with one job per step (Graphile Worker, pg-boss), or an interpreter over a state table.

## Decision
Own **journey interpreter** over a **participants table that is itself the work queue**:
- Each participant row holds the pinned journey version, current node, `status` (`ready`, `waiting`, `completed`, …), a step counter `seq`, `due_at` (ready-since or timer) and the awaited event, if any.
- Sweeper loops claim due rows in batches with `FOR UPDATE SKIP LOCKED`, run the interpreter in memory until each participant waits or ends, and write new states and outbox rows (sends, step events) in the **same transaction**.
- Side effects are keyed by `(participant, node, seq)`, so re-running a batch after a crash is harmless.
- Events wake waiting participants via an index on `(profile_id, waiting_event)`.
- Slow or external steps (LLM, webhooks) do not run inside the batch: the participant moves to an "awaiting external" state and the result comes back like an event.
- **Graphile Worker (MIT)** stays for low-volume background jobs (cron, maintenance, exports), not for per-participant steps.
- The engine sits behind a `DurableRuntime` port.

## Evidence (spike 3)
[`spikes/journey-runtime/FINDINGS.md`](../../../spikes/journey-runtime/FINDINGS.md): 1M participants through the full welcome journey at ~45k participants/s on a 4-vCPU box; 51k events/s matched; idle sweep < 1 ms with 1M waiting; crash test with 131 random crashes/SIGKILLs (also mid-transaction) lost and duplicated nothing. One Graphile Worker job per wake-up reached ~870 participants/s (≈50× slower), and jobs held by a hard-killed worker stay locked for 4 hours.

## Alternatives
- **One Graphile Worker / pg-boss job per step** — measured ≈50× slower; 4-hour lock expiry after hard crashes.
- **Temporal (MIT)** — battle-tested, but a separate cluster to run and upgrade; workflow-code versioning is awkward for user-defined graphs. No longer the expected scaling path; kept behind the port as an option.
- **Restate** — BSL license. **Inngest** — not permissively licensed for self-hosting.
- **DBOS Transact (MIT)** — durable workflows as a library; per-workflow overhead similar in shape to job-per-step.

## Consequences
We own the interpreter's correctness, so crash and idempotency tests are part of CI. Fairness between workspaces (claim per workspace or partition) and vacuum tuning are Phase 2 work. Scaling path: more sweeper processes, then hash-partitioning the participants table.
