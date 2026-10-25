# ADR-0014: One rule for the current consent status, per channel and across channels

- Status: Accepted (0.2.1, issue #103)
- Date: 2026-10-25

## Context
The consent ledger keeps a current row per person, purpose and channel (`consent_state`).
- Forms, imports, the SDK and most `consent.record` calls write the all-channels row (channel `''`).
- An unsubscribe writes a channel row: the one-click link and provider unsubscribe or complaint events write `(purpose, 'email', withdrawn)` (or `objected` under legitimate interest). The form's `('', granted)` row stays.

Up to 0.2.0 the readers disagreed. The send gateway took the newer of `''` and its own channel, so it blocked mail correctly. Segment evaluation (JS and SQL) and audience syncs read only `''`, so an unsubscribed person stayed in "has consent" segments: in recipient counts, `broadcasts.preview`, "Segment Entered/Exited" journey triggers and **audience syncs to ad platforms**. Other readers had their own variants (first row found, newest of any channel).

## Decision
One rule, implemented once in `@agentic-marketing/profiles` and used by every reader:
`currentConsent(rows, purpose, channel?)` in JS and `consentStatusSql(profileId, purpose, channel?)` in SQL, with `purposeAllowed` / `purposeAllowedSql` on top. A test runs the same cases through both evaluators.

1. **For a channel C** (the send gateway for e-mail, SMS and push; journey webhook steps use `webhook`): the newer of the `''` row and the C row. This is the gateway's behaviour since 0.1, unchanged.
2. **Without a channel** (segment `consent` conditions, audience syncs, outbound webhooks, AI context, ad conversions, consent change detection for forms, imports and the SDK): start from the `''` row. If a channel row is at least as new as it, a **refusal on any channel wins** over a grant (`withdrawn`, `objected`, `denied`), newest first. With no `''` row, the same applies to all channel rows.
3. Equal timestamps resolve to the refusal.

Consequences of rule 2, on purpose:
- An unsubscribe from one e-mail ends "has consent for marketing_email" everywhere a channel isn't named, so segments, previews, exports of segment members and audience syncs drop the person, as the gateway already did.
- A later form signup (a new `''` grant, newer than the unsubscribe) restores it. Before 0.2.1 the form hook compared against the `''` row only and ignored such a signup as "unchanged"; it now compares against the current status.
- A channel-specific *grant* never lifts an all-channels refusal for channel-less readers. It only counts for sends on that channel (rule 1). Channel-less readers err on the side of not processing.
- A newer refusal on a channel the purpose doesn't use (e.g. `sms` for `marketing_email`) also counts. We don't try to interpret which channels a purpose "really" covers.

## Rollout
- Migration `0026_consent_segments_recompute.sql` forgets the last run of each published segment that tests consent (directly or through another segment), so the segment scheduler recomputes them on its next round (about 30 s after start). People who unsubscribed before the upgrade leave those segments with a "Segment Exited" event.
- Unsubscribes (link, provider webhook unsubscribe or complaint) now re-evaluate the person's segments right away instead of on the next scheduled run, and form confirmations and imports re-evaluate consent segments in the streaming path.

## Alternatives considered
- **Make a channel withdrawal also rewrite the `''` row** when the consent came from an all-channels source. Rejected: the ledger is append-only evidence, and a synthetic record would claim the person withdrew on every channel.
- **Newest row across all channels.** Simple, but a later channel grant (e.g. an SMS opt-in) would silently re-admit someone who unsubscribed from e-mail into e-mail segments.
