---
section: Changed
---

- `/demo` now runs the real workspace shell on fixed sample data, with every page marked “Simulated demo · sample data”, zero network calls and every change refused.
- The legacy demo application, its mocked command catalogue, ambient traffic and live-site walkthrough are retired; the old demo links now open the matching real destinations, and the live walkthrough leaves a short, non-executing note on Home.
- The demo serves the reads its destinations use — Home, People, Approvals, Journeys, Templates, Analytics and Settings — from a bounded seed projection, and names anything else explicitly unavailable.
