---
section: Changed
issues: [1002]
---
- Development: `pnpm lint` now runs oxlint's type-aware `no-floating-promises`, `no-misused-promises` and `await-thenable` rules over the backend source, so a promise that is started and forgotten, or an async callback handed to an API that expects a synchronous one, fails before it ships.
