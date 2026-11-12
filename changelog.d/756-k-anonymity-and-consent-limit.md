---
section: Security
issues: [756, 757, 790]
---
- A campaign revenue row is now keyed on the people who converted in its currency, not on the campaign's recipients: below k=5 converters its revenue and revenue per recipient are null and counted in `meta.suppressed`, while the row's recipient and converter counts stay readable (#756). `analytics.campaignSummary` follows the same rule, so a currency with fewer than five buyers no longer exposes one person's spend.
- `journeys.splitResult` applies the shared k floor per arm (#757). An arm below k=5 returns null counts and rates with `suppressed: true`, the response adds `k` and a top-level `suppressed`, and every comparison and verdict is withheld; API consumers must handle the new nullable arm fields. The journey report's split card and the MCP tool description say so.
- `POST /api/auth/oauth2/consent` now refuses a body over 16 KiB with a JSON `payload_too_large` 413 before reading it (#790). The route previously buffered an unbounded body, parsed it and replayed it into a second request before Better Auth checked the session; the 50 MB chunked case is refused while it is still arriving.
