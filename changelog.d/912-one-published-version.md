---
section: Fixed
issues: [912]
---
- Artifact versions are now guaranteed by the database to have at most one `published` row per artifact: migration 0093 supersedes the extra published versions of an artifact (keeping the one it points at, or the highest version) and adds a partial unique index, so a writer that publishes outside the publish lock gets a conflict instead of quietly creating a second live version.
