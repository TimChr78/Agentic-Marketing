---
section: Fixed
issues: []
---
- The release script that closes a release's remaining issues no longer stops with `spawnSync gh ENOBUFS` when a release merged many pull requests: it reads `gh` and `git` output with a 256 MiB limit instead of Node's 1 MiB default.
