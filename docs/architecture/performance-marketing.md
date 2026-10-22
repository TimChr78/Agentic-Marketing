# Performance marketing: Google, Meta and Microsoft ads

Status: design for wave 2, Phase 9 ([roadmap-wave-2.md](roadmap-wave-2.md)). The groundwork is built in Phase 8: ad purposes, click-id capture, the consent banner with Google Consent Mode v2, and OAuth 2.0 connections. Phase 9 builds conversions to Meta, Google and Microsoft from a `conversion_map`, audience sync to Meta and Google, and spend import with ROAS (see the roadmap for what is left).

The platform already knows who converted, why, and whether they consented. Performance marketing uses that **first-party, consented data** in three ways:
- **Conversion feedback:** tell ad platforms which clicks became signups, leads and orders (server-side), so their bidding optimises for real outcomes.
- **Audiences:** sync segments to ad platforms (Customer Match, Custom Audiences) for targeting, exclusion and lookalikes.
- **Spend and ROAS:** import cost and clicks per campaign and join them with our own conversions and revenue.

All three go through the consent ledger. Nothing is sent for a person without the purpose that covers it.

## Platforms and APIs (verified 2026-10-22)

| Platform | Conversions (server-side) | Audiences | Spend and reporting | Notes |
|---|---|---|---|---|
| **Google Ads** | **Data Manager API**: offline conversion import and enhanced conversions for leads moved there; the Google Ads API blocks new uploads from **15 June 2026**. Click ids `gclid`/`gbraid`/`wbraid` plus hashed e-mail and phone; consent fields per request or member | **Data Manager API** `audienceMembers:ingest` (Customer Match): up to 10,000 members per request, `termsOfService` acceptance, consent per request or member | Google Ads API (GAQL reports: campaign cost, clicks, conversions) | OAuth 2.0 (`datamanager` and `adwords` scopes); developer token for reporting |
| **Meta (Facebook, Instagram)** | **Conversions API** (`/{pixel_id}/events`): `event_id` deduplicates against the Pixel; hashed `em`/`ph`, `fbc`/`fbp`, `action_source` (website, system_generated, email) | Marketing API custom audiences (customer file): hashed identifiers, add and remove. Since 6 Jan 2026, updating *flagged* customer-file audiences and building lookalikes from flagged seeds fails, so handle that error | Marketing API Insights (`act_…/insights`). The 7d_view and 28d_view windows were removed in Jan 2026 | System-user access token (long-lived) or OAuth. Meta also offers a one-click "Meta-enabled" CAPI; ours is the "own setup" path |
| **Microsoft Advertising (Bing)** | **Offline conversion import** via the Bulk or Campaign Management API with `msclkid`. The newer server-side Conversions API is behind **per-account pilot approval** | Customer Match lists (hashed e-mail) via Bulk API, where the account is eligible | Reporting API (campaign performance) | OAuth 2.0 (Microsoft identity) and developer token |
| **Later (optional)** | LinkedIn (Conversions API, Matched Audiences), TikTok (Events API), Pinterest, Reddit | Same pattern | Same pattern | Same connector shape |

Sources:
- [Google: about offline conversion imports](https://support.google.com/google-ads/answer/2998031?hl=en) and [enhanced conversions for leads](https://support.google.com/google-ads/answer/15713840?hl=en);
- [PPC Land: Google blocks new offline conversion imports via the Ads API from June 15](https://ppc.land/google-blocks-new-offline-conversion-imports-via-ads-api-from-june-15/);
- [Data Manager API: audienceMembers.ingest](https://developers.google.com/data-manager/api/reference/rest/v1/audienceMembers/ingest);
- [Meta Pixel and Conversions API: conversion tracking](https://developers.facebook.com/documentation/meta-pixel/implementation/conversion-tracking);
- [Graph API release notes (aggregated)](https://releasebot.io/updates/meta/graph-api);
- [PPC Land: Microsoft gates its new conversions API behind per-account pilot approval](https://ppc.land/microsoft-gates-its-new-conversions-api-behind-per-account-pilot-approval/).

Re-verify each API version when building: all three platforms change these APIs often.

## Data model

- **Click ids as identifiers.**
  - Ingest and the SDK capture `gclid`, `gbraid`, `wbraid`, `fbclid`, `msclkid` from landing URLs, and the `_fbc`/`_fbp` cookie values when the site sets them.
  - They are stored as identifier types (`gclid`, `fbc`, `fbp`, `msclkid`…) with first and last seen. Like every identifier, they are only stored with the consent the source requires; the click id itself is pseudonymous.
  - Forms take hidden `gclid` / `fbclid` / `msclkid` fields, so no-JS sites capture them too.
- **Purposes** (new defaults, both consent-based in the EEA):
  - `ad_measurement`: send conversions to ad platforms; maps to Google `ad_user_data` and Meta's data-processing signals;
  - `ad_targeting`: put a person in ad-platform audiences; maps to Google `ad_personalization`.

  The consent mapping per platform lives in one place.
- **`ad_account` connections** (connector SDK with the **OAuth2 token store**, a wave 2 prerequisite): Google Ads customer id and login customer id, Meta ad account and pixel id, Microsoft account and customer id. Tokens are sealed and refreshed by a worker.
- **`conversion_map` artifact** (versioned and approved like everything else). It maps our events to each platform's conversion action, for example:
  ```json
  {"rules":[
    {"event":"Order Completed","value":"properties.total","currency":"properties.currency",
     "google":{"conversionAction":"customers/123/conversionActions/456"},
     "meta":{"eventName":"Purchase"},"microsoft":{"goal":"Purchase"}},
    {"event":"Subscription Confirmed","google":{"conversionAction":"…/789"},"meta":{"eventName":"Lead"}}]}
  ```
- **`audience_sync` artifact**: segment → platform audience (create or attach), with identifiers e-mail, phone, address and mobile id, and whether removals are synced.

## Flows

1. **Conversion upload** (post-resolve hook):
   - a mapped event for a person with `ad_measurement` allowed is queued in `deliveries` (kind `ad_conversion`), keyed by event and platform;
   - the worker batches per platform and account;
   - each conversion carries the click id (or hashed e-mail and phone for enhanced conversions), value and currency, event time, event id for de-duplication, and consent flags;
   - retries and dead letters work like webhooks; partial-failure responses are stored per row.
2. **Audience sync:**
   - segment enter and exit events become add and remove deltas;
   - a nightly full reconcile catches drift;
   - members without `ad_targeting` are excluded (and removed when they withdraw);
   - hashing (SHA-256, normalised per each platform's rules) happens at send time; identifiers are opened from the sealed store only inside the worker;
   - minimum audience sizes and platform errors (flagged audiences, terms not accepted) show as actionable statuses.
3. **Spend import** (scheduler, daily plus intraday refresh):
   - per account and campaign, ad group and day, store cost, impressions, clicks and platform conversions in ClickHouse (`ad_spend`);
   - our attribution (last non-direct touch by click id or UTM within a configurable window, plus "platform-reported" side by side) joins our conversions and revenue;
   - result: CPA, ROAS and conversion lag by campaign and channel.
4. **Agents (MCP):**
   - read tools: `ads.performance`, `ads.audiences`, `ads.conversions.status`;
   - drafts: conversion maps and audience syncs (approval required);
   - **no budget or bid changes in v1**. Proposals are written as notes for a person; write access to campaigns is a later, separately approved step.

## Guardrails

- **Consent per person and purpose, always.** In the EEA, Customer Match and enhanced conversions require that the person consented to sharing with the platform. The platform passes the consent fields and never uploads people without them.
- **Hashing and minimisation:**
  - only the identifiers the platform needs, hashed;
  - never free-text traits;
  - a per-connection allow-list of which identifiers may leave.
- **Records of processing:** each ad platform is a recipient with a region and a transfer basis; `profiles.export` lists the uploads made about a person (like AI decisions); erasure queues removals from synced audiences.
- **Test mode:** Google `validateOnly`, Meta `test_event_code` and Microsoft sandbox are used by `ads.test` before anything is enabled.

## For MarTechSignal

MarTechSignal runs no ads today, so this phase is for future paid acquisition, e.g. promoting the newsletter. Paid acquisition would use:
- `Subscription Confirmed` as the conversion (`Lead`), not form submission, so bids optimise for confirmed subscribers;
- an exclusion audience of current subscribers;
- a lookalike from confirmed, engaged readers.

All of it is server-side, so the site keeps its no-pixel promise.
