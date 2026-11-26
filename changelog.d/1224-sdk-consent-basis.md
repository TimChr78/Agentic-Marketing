---
section: Fixed
issues: [1224]
---
- The browser SDK no longer disagrees with the gateway about a tracking purpose published on a legitimate-interest or contract basis: the consent banner records it on "Accept all", offers it as an objectable choice (so a refusal is sent), and the SDK keeps sending events for it unless the visitor refused. A workspace whose web purposes are all on a non-consent basis now shows the banner and tracks, instead of sending nothing forever.
