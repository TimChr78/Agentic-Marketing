---
section: Fixed
issues: [758, 759, 793, 794]
---
- Experiment results count exposure and conversion only for the version they describe. A republished experience whose variants were renamed no longer returns rows for the old variant ids, loses its control fallback or claims "Nothing to compare yet" under the new version's number (#758).
- The results screen prints the version the server measured and the analysis settings of that version, so an open draft with a different `alpha`, `threshold` or method no longer rewrites the caption of a result computed from the published version; a version too new to have exposures says "No data for version N yet" (#758, #759).
- Experiment results no longer leave exposures recorded without a version silently out of the counts: when the window holds any, the note says how many were excluded and that results count only the version they describe (#758).
- The journey holdout card labels the absolute lift and its 95% interval in percentage points ("+5.0 pp"), like the campaign and broadcast holdout panels, instead of printing a rate-style percent (#794).
- The Messages list loads the workspace's purposes and names a message's custom purpose; it no longer shows "Unavailable purpose" for every purpose an operator defined themselves (#793).
