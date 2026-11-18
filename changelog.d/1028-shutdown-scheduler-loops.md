---
section: Fixed
issues: [1028]
---
- The server stops promptly on `SIGTERM`/`SIGINT` even while a scheduler job is waiting between
  rounds or a provider call is still answering. Every scheduler and worker loop now sleeps through a
  cancellation-aware helper, so a stop that lands mid-round no longer waits out a whole tick — an
  hour for retention, six for the ad spend import, thirty seconds for the segment scheduler — and the
  ad audience, spend-import and OAuth token-refresh jobs stop between connections, with their egress
  request destroyed instead of waited out (#1028).
