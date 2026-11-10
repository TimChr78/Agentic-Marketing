---
section: Security
issues: [594]
---
- Consent history no longer returns personal proof fields (IP address, user agent, page URL, call notes and other personal evidence) to roles without `profiles:pii`; the response says `proofWithheld` and the person page shows "Hidden for your role" instead of the fields.
