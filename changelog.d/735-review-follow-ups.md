---
section: Fixed
issues: [732, 735]
---
- Returning to a segment tab re-reads each watched segment once, not once for focus and again for visibility. A bundled purposes rollback now shows the same “moves the live … back” warning as templates, segments and blocks.
- An e2e settle timeout now names the condition still pending, the skeleton selectors or the on-screen images that never finished, so a flaky route explains itself.
