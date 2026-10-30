# Security & privacy

> This document describes technical measures. It is not legal advice; lawful-basis rules (especially for legitimate interest and ePrivacy) must be validated with a privacy professional per jurisdiction.

## 1. GDPR by design — mapping

| GDPR / ePrivacy requirement | Platform mechanism |
|---|---|
| Lawful basis (Art. 6) | **Consent & lawful-basis ledger** per profile × purpose × channel; every message/journey declares a purpose; send gateway enforces |
| Legitimate interest | Purpose configured with basis `legitimate_interest` + linked **LIA record** (assessment text, owner, review date); right to object always honoured and recorded |
| Email marketing under LI (ePrivacy Art. 13(2) "soft opt-in") | Policy template: only existing customers, similar products, opt-out offered at collection and in every message (one-click unsubscribe mandatory) |
| Cookies / tracking consent (ePrivacy Art. 5(3)) | SDK: no non-essential storage/tracking before consent; TCF / Consent Mode / custom CMP signals; cookieless mode |
| Data minimization (Art. 5) | Tracking plan with allowed properties; attribute schema with PII classes; IP truncation; drop-unknown option |
| Storage limitation | Retention per data class: ClickHouse TTL, Postgres retention jobs, profile inactivity expiry |
| Right of access / portability (Art. 15, 20) | DSR command: export profile, identifiers, consent history, events, messages as JSON/CSV |
| Right to erasure (Art. 17) | DSR erasure: delete profile rows, **crypto-shred** per-profile key, ClickHouse delete by identifiers, suppression-hash kept to prevent re-contact (documented exception) |
| Records of processing (Art. 30) | Purposes, sub-processors (ESPs, LLM providers), data categories configurable and exportable |
| Security of processing (Art. 32) | Encryption at rest/in transit, RBAC, audit log, see below |
| Automated decision-making (Art. 22) | AI decisions limited to marketing content/timing; logged with rationale; `ai_processing` purpose can be disabled per profile/workspace |
| Data residency / transfers | Self-hosted: where you run it. LLM/ESP providers flagged with region; EU-only provider policy option |

## 2. Consent & lawful-basis ledger

```
purposes(workspace_id, key, name, basis: consent|legitimate_interest|contract|legal_obligation,
         channels[], lia_id?, requires_double_opt_in, description)
consent_records(workspace_id, profile_id, purpose_key, channel, status: granted|denied|withdrawn|objected,
                basis, source (form, sdk, import, api, unsubscribe link), proof jsonb (ip-trunc, ua, text-version, double-opt-in token),
                recorded_at, recorded_by)        -- append-only
consent_state(workspace_id, profile_id, purpose_key, channel, effective_status, updated_at)  -- materialized
suppressions(workspace_id, channel, value_hash, reason, at)  -- survives erasure (hash only)
```

The current status of a purpose combines the all-channels row (`''`) and the channel rows by one rule, [ADR-0014](adr/0014-consent-channel-precedence.md): for a channel, the newer of `''` and that channel; without a channel (segments, audience syncs), a newer refusal on any channel wins.

Evaluation in the send gateway: `consent` basis → needs `granted`; `legitimate_interest` → allowed unless `objected/withdrawn`, and the LI policy conditions hold (e.g. `is_customer` trait for soft opt-in). Double opt-in flows are built-in journeys.

## 3. Encryption & keys

- **In transit:** TLS everywhere (Caddy auto-TLS for self-host); internal connections TLS-capable.
- **At rest:** rely on disk/volume encryption for the base layer, plus **application-level field encryption** for PII:
  - Envelope encryption: a **KEK** from a pluggable key provider (env/file for small installs, AWS KMS, GCP KMS, OpenBao/HashiCorp Vault transit) wraps **DEKs**.
  - **Per-profile DEK** for PII fields in Postgres and ClickHouse (`properties` PII fields). Erasure = delete the DEK → data in events and **backups** becomes unreadable (crypto-shredding).
  - Lookup via HMAC hashes (`value_hash`) so matching doesn't need decryption.
- **Secrets** (ESP keys, LLM keys, OAuth tokens, webhook secrets): encrypted with workspace DEK, write-only via API, key rotation command in CLI.
- BYOK/customer-managed KEK for SaaS: later phase, already enabled by the key provider interface.

**Erasure tombstones (#210).** An erasure keeps one tombstone per identifier of the person: an HMAC-SHA256 hash keyed with the workspace's matching data key, never the raw user id, e-mail address or phone number. For `ERASURE_GRACE_HOURS` (24 by default, configurable; with `0` only events from before the erasure are dropped) after the erasure, an event that names only erased identifiers and happened before that window is dropped by the resolver instead of creating a new profile, so events already on the bus, SDK retries, offline queues or late provider webhooks cannot recreate the person. After the window, new activity is treated as a new person, and the hourly retention job deletes tombstones once the window plus seven days has passed.

## 4. Identity, authentication & authorization

- **Auth:** Better Auth (MIT) — email/password + passkeys + TOTP MFA in v1; organizations/workspaces; OIDC/SAML SSO and SCIM in a later phase.
- **Principals:** `user`, `agent` (owned by a user/workspace, scoped tokens), `service` (SDK write keys, server keys, connectors).
- **Authorization:** RBAC with built-in roles (owner, admin, marketer, analyst, approver, viewer) mapping to permission strings checked in the command layer; per-agent scope sets. Designed so it can move to relationship-based authz (OpenFGA, Apache-2.0) if fine-grained sharing is needed.
- **Tenant isolation:** `workspace_id` + Postgres RLS (session variable set by the command layer); ClickHouse row policies; NATS subjects per workspace; Valkey key prefixes.
- **Audit log:** append-only, hash-chained table of every command (principal, effect, input hash, result, ip, user agent), exportable; separate from analytics.

## 5. Application security controls

| Threat | Control |
|---|---|
| SSRF via webhooks / HTTP nodes / connector URLs | Egress proxy or resolver guard blocking private/link-local/metadata ranges; per-workspace allow-lists |
| Template injection | LiquidJS sandbox (no filesystem, no code), output escaping by default, render time & loop limits |
| Prompt injection via profile/event data reaching LLMs | Data is passed as clearly delimited data, LLM outputs are schema-validated and can only choose among configured options; AI nodes cannot call platform tools in v1 |
| Malicious MCP/agent behaviour | Scopes, drafts + approvals, the policy engine (audience threshold, per-agent limits, the autonomy switch), pausing an agent, AI budgets, the send gateway, the action ledger and audit ([agentic-autonomy.md](agentic-autonomy.md)) |
| Abuse of public write keys | Origin allow-list, rate limits, schema validation, payload size limits, bot filtering |
| XSS in editors/experiences | CSP, sanitization of experience HTML (DOMPurify), editors in sandboxed iframes where possible |
| Supply chain | Lockfile, Renovate, `pnpm audit`/OSV scanning, SBOM (Syft), signed images (cosign), minimal base images |
| Custom code steps (later) | Not in v1. If added: isolated runtime (separate sandboxed process / WASM) with no network by default |
| Secrets leakage | Never returned by APIs, redacted in logs/traces, secret scanning in CI |

The egress guard normalises the IPv6 forms that embed an IPv4 address (IPv4-mapped `::ffff:0:0/96`, IPv4-compatible `::/96`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`) and applies the IPv4 block list to the embedded address, both to literals and to DNS answers at connect time; the Postgres warehouse destination resolves once and pins the validated address. Outbound HTTP requests stop reading as soon as the response byte limit is crossed and use a total deadline covering connect, headers and body, so an oversized or slowly trickled response cannot keep a worker and connection open.

## 6. Operational security

- Backups: Postgres (pgBackRest or WAL-G) + ClickHouse (clickhouse-backup) encrypted; restore drill documented; crypto-shredding makes erasure effective in backups.
- Security headers, CSRF protection for cookie sessions, session revocation.
- Vulnerability disclosure policy (`SECURITY.md`) from the first public release.
- Target compliance frameworks for a future SaaS: SOC 2 / ISO 27001 — the audit log, RBAC, encryption and change management (artifact approvals) are designed to support them.
