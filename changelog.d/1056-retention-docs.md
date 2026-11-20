---
section: Fixed
issues: [1056]
---
- The pilot guide, the smoke-test guide, the implement skill, `.env.example` and the `am smoke --cleanup` message no longer say that retention removes unconfirmed signups. Removing them has been paused since 0.15.0; retention counts them and keeps them, so erase a smoke signup as a person in the admin UI.
