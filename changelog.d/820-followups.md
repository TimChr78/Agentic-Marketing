---
section: Fixed
issues: [820, 828, 840, 830, 831]
---
- **Breaking:** `experiences.results` now applies the k=5 floor per variant. A variant with fewer than five exposed visitors reports null counts and rates, `suppressed: true`, and no comparison, P(best) or expected loss that needs it; the result carries `k` and a top-level `suppressed`, and an unversioned-exposure count below k is no longer printed. API clients must handle the null fields.
- Dialog focus stays in the field being typed into when a dialog re-renders with an inline `onEscape`, and the Insert palette reads its inline `onClose` from a ref the same way (#820).
- `profiles.events` pages newest-first on the full replacing key `(timestamp, name, anonymous_id, event_id)` and carries the name and anonymous id in `nextCursor`, so events that tie on timestamp and event id are no longer skipped. Cursors from before this change still work and repeat a tied row rather than drop it (#840).
- The concurrent-migrator readiness probe excludes its own backend and matches migrator A's client backend, and fails with a clear message when the index build is never observed, so the ordering test no longer races (#830).
- The staged-send canary test waits for the canary's delivery state before deciding its outcome instead of relying on scheduler timing (#831).
