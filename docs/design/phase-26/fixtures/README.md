# Phase 26 fixture payloads

Example command outputs for the Phase 26 UI tasks. They are design fixtures, not live evidence.

| File | Command | Use |
|---|---|---|
| `deliverability.trend.json` | `deliverability.trend({from,to,channel:'email',stream:'marketing'})` | 30 workspace-local points in `Europe/Copenhagen`; the first three days have no volume so both rates are `null`. |
| `agents.mandate.json` | `agents.mandate({agentId})` | An active published mandate with its full content and an inside-working-hours verdict. |
| `agents.mandate.none.json` | `agents.mandate({agentId})` | The same command for an agent with no active mandate. |

The payloads match the registered output schemas exactly. Dates, ids and thresholds are synthetic.
