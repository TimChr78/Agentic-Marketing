---
section: Fixed
issues: [1267]
---
- `am doctor --env-file - < .env` no longer lets a piped `.env` replace the values Compose sets in the container. The template's development `DATABASE_URL` (`localhost:5432`) and the other Compose-supplied keys are ignored when the process already has them, so the documented pre-upgrade check reports the real database instead of failing with "Postgres is unreachable".
