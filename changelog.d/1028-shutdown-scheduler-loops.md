---
section: Fixed
issues: [1028]
---
- The server stops promptly on `SIGTERM`/`SIGINT` even while a scheduler job is waiting between
  rounds or a provider call is still answering. Every scheduler and worker loop now sleeps through a
  cancellation-aware helper, so a stop that lands mid-round no longer waits out a whole tick — an
  hour for retention, six for the ad spend import, thirty seconds for the segment scheduler — and the
  ad audience, spend-import and OAuth token-refresh jobs stop between items instead of mid-flight.
- A stop no longer cancels work whose answer must be stored: an OAuth token exchange already sent
  finishes and keeps its rotated refresh token instead of leaving the dead one behind, and an ad
  spend import finishes its pages instead of marking the window incomplete. A cancelled content feed
  is no longer retried or counted as a failure, so a healthy feed keeps its normal interval after a
  restart rather than waiting up to sixteen times longer (#1028).
