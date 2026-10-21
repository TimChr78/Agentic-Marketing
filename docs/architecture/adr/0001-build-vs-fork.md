# ADR-0001: Build a new core, use Dittofeed as reference

- Status: Accepted (owner decision 2026-10-21)
- Date: 2026-10-21

## Context
Several open-source engagement platforms exist. The closest match is **Dittofeed** (MIT, TypeScript, Postgres + ClickHouse + Temporal, journeys, segments, email/SMS). Others: Mautic (GPL, PHP, monolithic), listmonk (AGPL, newsletters only), Novu (notification infra, not a CDP/journey tool), Laudspeaker.
Our differentiators are cross-cutting: a command registry driving MCP/REST/UI, versioned artifacts with approval policies, a consent/lawful-basis ledger enforced in one send gateway, in-session web personalization, and AI journey steps.

## Decision
Build a new core. Study Dittofeed's segmentation and ClickHouse modelling as prior art (MIT allows reuse of code with attribution where it fits).

## Alternatives
- **Fork Dittofeed** — fastest to first email journey; but retrofitting agent-first command layer, artifact versioning, consent enforcement and RLS tenancy touches nearly every module, and it brings Temporal as an operational dependency. Revisit if Phase 2 is taking too long.
- **Extend Mautic** — PHP, legacy architecture, GPL; not agent-native.

## Consequences
More initial work; full control over foundations that are hardest to retrofit. Confirmed by the owner.
