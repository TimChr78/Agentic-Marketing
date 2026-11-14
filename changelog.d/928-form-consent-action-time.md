---
section: Fixed
issues: [928]
---
- Form signups and double opt-in confirmations now record the time the person submitted or confirmed, not the time the queue worker got to the event, so a delayed or redelivered signup can no longer outrank a later unsubscribe. Provider unsubscribe and complaint callbacks and SMS STOP texts record their own action time too.
- An imported consent timestamp is kept as the historical evidence it is, but a future date is clamped to the import time at validation and again when the ledger row is written, so a post-dated import cannot outrank a later withdrawal.
- Consent records are unchanged for rows written before this fix: the ledger stays append-only, and the new timestamps apply to new writes only.
- When two consent records share the exact same recorded time, a withdrawal, objection or denial now wins the tie over a grant, as the consent precedence rule already said.
