---
section: Changed
issues: []
---
- ClickHouse is updated to 26.8.41.14, the latest build of the 26.8 LTS line, in `docker-compose.yml` and the test stack. CI now tests on exactly the pinned image instead of the floating `26.8` tag. Dependabot now proposes Compose image updates weekly, staying on the 26.8 line; the move to the next LTS is planned in #1113.
