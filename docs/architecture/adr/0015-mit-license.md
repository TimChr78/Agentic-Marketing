# ADR-0015: MIT for the whole project

- Status: Accepted (owner decision 2026-10-30, issue #171)
- Date: 2026-10-30
- Supersedes: [ADR-0009](0009-project-license.md)

## Context
ADR-0009 chose AGPL-3.0 for the server, MIT for the SDKs and a CLA, to keep a closed hosted fork out and dual-licensing open. Release 0.1.0 shipped under MIT instead (`LICENSE`, `package.json`, the image label), and every release since has. The ADR was never updated, so the repository and the architecture docs disagreed (#171).

## Decision
The whole project, server and SDKs alike, is MIT-licensed. No CLA. Contributions are accepted under the same licence (inbound = outbound).

The owner does not want a licence that places obligations on people who run or change the software. MIT matches what has shipped since 0.1.0, so nothing changes for self-hosters or contributors.

## Consequences
- Anyone may run, change and host the platform, including as a closed hosted service. That is accepted.
- A future hosted or commercial offering cannot rely on the licence for protection; it would compete on operation and service.
- Dependencies stay permissive, as ADR-0009 already required.
- `LICENSE`, `package.json`, the README and the image label (`org.opencontainers.image.licenses=MIT`) already say MIT.
