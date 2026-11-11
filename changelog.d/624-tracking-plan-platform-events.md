---
section: Fixed
issues: [623, 624, 627]
---
- A strict tracking plan no longer rejects the platform's own signup, confirmation, import and e-mail carrier events, so newsletter signups keep working and imported consent is recorded.
- Tracking plans gain a `declaredProperties` setting for a declared property that is missing although required, or has the wrong type. When it is absent, plans that block unknown properties keep blocking and other plans warn; the unknown-event setting no longer affects this.
- Retention removes unconfirmed form signups that supplied a client anonymous id only when the stored event history proves an unconfirmed signup with no other activity; confirmed subscribers and people with other activity stay, and kept candidates can no longer hide an older signup.
