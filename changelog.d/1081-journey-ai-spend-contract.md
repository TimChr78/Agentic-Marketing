---
section: Changed
issues: [1081]
---
- The documentation now states the spend contract exactly: the spend action class gates the direct
  paid commands (`prompts.test`, `ai.classify`, `ai.score`), while AI steps inside a journey spend
  the provider's monthly token budget when participants reach them and need no spend mandate.
  `journeys.enroll`, `journeys.enrollSegment` and `artifacts.requestPublish` say so in their tool
  descriptions.
