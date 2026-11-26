---
section: Fixed
issues: [1246]
---
- A `POST /v1/<kind>` whose JSON body is `null`, an array or a scalar is answered `400 invalid_json` like the edge worker, instead of an unauthenticated request causing a 500 and an unhandled-error log line.
