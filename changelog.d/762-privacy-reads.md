---
section: Security
issues: [762, 763, 765]
---
- **Breaking:** `journeys.simulate` with a `profileId` now needs `profiles:read`, because a walk reveals the person's consent, topic and suppression state; a step whose detail would show personal data (such as a phone number in a profile update) is withheld without `profiles:pii`. The dry run without a `profileId` stays at `artifacts:read`.
- Read audit entries now name the people a read reached: `profiles.find` records the profile it resolved, and `segments.preview` and an unfiltered `messages.list` record one entry per sampled or listed person (at most 50), so `audit.list` can answer "who accessed which person".
- The shared personal-data detector now also finds national-format phone numbers (`555 123 4567`, `(555) 123-4567`, `020 7946 0958`) and postal addresses, so allowlisted consent-proof free text is withheld from roles without `profiles:pii`. ISO dates, plain counts and ids with letters are not treated as phones.
- Hosted agent memory notes now refuse an 8-digit Danish or Norwegian phone number (`12345678`) as well, and `agents.memory.list` redacts one in a note saved before this release.
