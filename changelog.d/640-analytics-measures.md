---
section: Fixed
issues: [589, 591, 631, 640, 682]
---
- Ad performance now counts conversions that carry only a user id (server-side orders, CRM and offline imports) as unattributed instead of dropping them, so their revenue appears in the report.
- Experiment results describe the published version of a live experience, so editing a draft no longer changes its goal, analysis method, threshold or control; the response names the version it describes.
- The journey funnel API computes its drop-off chain in the published journey's node order and leaves out steps from older versions, so republishing a journey no longer mixes topologies. When no published topology exists it reports per-step reach without a claim of a chain.
- The "latest event in period" line now applies the same event types and conversion names as the result, and is unavailable when the filters can match nothing.
- The e-mail measures count only `channel = 'email'`. Workspaces that also send SMS or push will see their e-mail numbers drop where those channels wrote sent, delivered or other shared message events; the measures are named and described as e-mail, so the old figures included other channels.
