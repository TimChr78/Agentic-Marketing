---
section: Changed
issues: []
---
- The bundled Valkey moves from 8.1.9 to 9.1.3, and NATS from 2.15.0 to 2.15.3; the test stack's OpenBao moves from 2.6.4 to 2.7.2. The bundled Valkey keeps no data on disk (no snapshots, no append-only file), so the major version needs no migration and can be rolled back. CI now runs every service on exactly the image Compose pins (a test enforces it), instead of separately named tags.
