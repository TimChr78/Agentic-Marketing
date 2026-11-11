---
section: Fixed
issues: [623, 624, 627]
---
- A strict tracking plan no longer rejects the platform's own signup, confirmation, import and e-mail carrier events, so newsletter signups keep working and imported consent is recorded.
- A tracking plan's declared `required` and `type` properties are now validated independently of the unknown-event and unknown-property settings, so the same malformed event behaves the same whatever those settings are.
- Retention removes unconfirmed form signups that supplied a client anonymous id, while keeping confirmed subscribers and people with other activity.
