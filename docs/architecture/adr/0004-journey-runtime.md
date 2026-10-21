# ADR-0004: Journey runtime on Postgres + Graphile Worker

- Status: Proposed
- Date: 2026-10-21

## Context
Journeys need durable waits (minutes to months), event waits with timeouts, retries, exactly-once *effects*, and millions of concurrent participants. Options: a durable execution engine (Temporal, Restate, Hatchet, DBOS) or an interpreter over a state table with a Postgres job queue.

## Decision
Own **journey interpreter**: participant state rows in Postgres, one job per node execution in **Graphile Worker** (MIT), timers as indexed `wake_at` columns moved to the queue by the scheduler. State update and next-job enqueue happen in the same transaction. All side effects are idempotent through the send gateway. The engine sits behind a `DurableRuntime` port.

## Alternatives
- **Temporal (MIT)** — battle-tested, but a separate cluster (frontend/history/matching/worker services + its own DB) to run and upgrade; workflow-code versioning is awkward for user-defined graphs. Remains the upgrade path for very high scale.
- **Restate** — BSL license.
- **Inngest** — not permissively licensed for self-hosting.
- **DBOS Transact (MIT)** — Postgres-backed durable workflows as a library; attractive, younger. Worth re-evaluating in the runtime spike.
- **pg-boss (MIT)** — similar to Graphile Worker; Graphile Worker chosen for throughput and LISTEN/NOTIFY-based low latency.

## Consequences
We own correctness of the interpreter (must be well tested, incl. crash/retry tests). Journey graphs are data, so versioning, simulation and agent editing are straightforward. Postgres becomes the throughput ceiling for steps/s — acceptable until well beyond 10M profiles with partitioning.
