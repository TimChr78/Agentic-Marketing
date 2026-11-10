---
section: Changed
issues: [607, 650, 651, 652, 653]
---
- The documentation now matches 0.14.1, and setting `ROLE` to anything other than `api`, `ingest`, `worker`, `scheduler` or `all` stops the server at start-up with a configuration error instead of running a process that serves nothing. The architecture pages document the four real roles: `ingest` also answers `/v1/decide`, and the scheduler runs as a single `Recreate` replica. The status handoff, the architecture status headers, the wave 5 roadmap and the demo pointers now describe the shipped 0.14 line, and the broken source links in the Phase 27 and Wave 5 design inventories are fixed.
