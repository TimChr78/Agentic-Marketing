# ADR-0002: TypeScript modular monolith with role-based processes

- Status: Proposed
- Date: 2026-10-21

## Context
One developer, maintainability first, self-hosters want few moving parts, but ingestion/decide must scale independently later.

## Decision
- One TypeScript monorepo, one OCI image. A `ROLE` setting (`api`, `ingest`, `decide`, `worker`, `scheduler`, or `all`) selects which modules run.
- Modules talk via typed interfaces and bus events, own their tables, and never query each other's tables directly.
- Infrastructure behind ports (`EventBus`, `DurableRuntime`, `KeyProvider`, `ObjectStore`, `ChannelAdapter`, `LlmProvider`) so implementations can change.

## Alternatives
- Microservices — operational and cognitive overhead unjustifiable for one person.
- Go for hot paths from day one — two languages to maintain; Node handles the initial scale. Contracts (HTTP + bus schemas) allow a later Go rewrite of `ingest`/`decide` without touching the rest.

## Consequences
Simple to develop, test and deploy; module discipline must be enforced (lint rule on cross-package imports, e.g. dependency-cruiser).
