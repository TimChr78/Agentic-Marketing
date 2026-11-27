---
section: Fixed
issues: [1287, 1288, 1289, 1290, 1291, 1292, 1293, 1294]
---
- The MCP and implement skills no longer present people-only `audiences.*` writers as agent calls, and the static/CSV audience recipe says which steps a person runs.
- The audience-curator recipe and starter agent size a published segment through the metric layer (`analytics.query` with `segment.members`, `artifacts:read` only) instead of people-level `segments.preview`, skip a segment with no published version, size inactivity inside the intended segment on the e-mail channel, and draft a proposed sunset (its unsaved condition has no members) for a person to preview and decide; the existing hosted curators keep their saved instructions, so an operator edit is needed to adopt the corrected workflow.
- The architecture pages now name real examples in the `data.write` action-class row, the three shipped key providers (`MASTER_KEY`, OpenBao transit, AWS KMS), and an installation-wide `EGRESS_ALLOWED_HOSTS` allow-list shared by every workspace.
- `agents-and-mcp.md` describes the MCP surface that ships: four effects, Streamable HTTP only, three resources, no prompts and API-key AI providers, with its tool inventory and people-only list matching registry metadata (`profiles.export` is people-only; a hosted agent may still delete its own memory notes).
- `deployment-and-scaling.md` and the wave-4 roadmap record that backup verification (`am backup --verify`) and the restore key check shipped; only remote targets (#142) and ClickHouse backups at scale (#146) remain open.
