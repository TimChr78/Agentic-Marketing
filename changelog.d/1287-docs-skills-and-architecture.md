---
section: Fixed
issues: [1287, 1288, 1289, 1290, 1291, 1292, 1293, 1294]
---
- The MCP and implement skills no longer present people-only `audiences.*` writers as agent calls, and the static/CSV audience recipe says which steps a person runs.
- The audience-curator recipe and starter agent size inactivity inside the intended segment on the e-mail channel, and read each segment's published version so a pending edit is not mistaken for a change in the live audience; the starter agent now has the `profiles:read` scope `segments.preview` needs.
- The architecture pages now name real examples in the `data.write` action-class row, the three shipped key providers (`MASTER_KEY`, OpenBao transit, AWS KMS), and an installation-wide `EGRESS_ALLOWED_HOSTS` allow-list shared by every workspace.
- `agents-and-mcp.md` describes the MCP surface that ships: four effects, Streamable HTTP only, three resources, no prompts and API-key AI providers.
- `deployment-and-scaling.md` and the wave-4 roadmap record that backup verification (`am backup --verify`) and the restore key check shipped; only remote targets (#142) and ClickHouse backups at scale (#146) remain open.
