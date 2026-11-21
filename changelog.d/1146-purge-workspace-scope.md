---
section: Security
issues: [1146]
---
- The physical erasure purge now scopes its matching count and delete subquery to the workspace being purged even when ClickHouse row policies are off, so another workspace's rows can neither inflate the reported deletion count nor consume the bounded batch.
