# ADR-0007: Single send gateway enforcing lawful basis

- Status: Accepted (built; the send gateway enforces it since Phase 2)
- Date: 2026-10-21

## Context
GDPR/ePrivacy compliance must not depend on every journey, campaign, agent or API caller remembering to check consent. Communication must support both consent and legitimate interest as bases.

## Decision
All outbound messages go through one **send gateway** which, for every message: deduplicates by idempotency key, resolves the message's declared purpose → lawful basis, checks the consent/objection ledger and LI policy conditions, suppression lists, frequency caps and quiet hours, renders content, calls the channel adapter and logs the decision (including suppressions with reason). Channel adapters are not reachable any other way.

## Consequences
One choke point to audit and test thoroughly; every send can be explained ("why did/didn't X receive Y?"). Purposes must be configured before sending — the setup wizard provides templates.
