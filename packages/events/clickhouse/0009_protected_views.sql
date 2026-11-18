-- Protected reads (#1037, 0.17.0 part 2).
--
-- Every application read of person-linked data goes through one of these views instead of the
-- base table — unless the workspace has never allocated an erasure generation, in which case the
-- shared read layer reads the base table directly (there is nothing to exclude, and the view costs
-- a ledger scan). A row is excluded when any subject key it carries, or any key the backfill side
-- table supplies for its identity, matches an `erased_subjects` row of the same workspace. The
-- filter runs before aggregation, so an erased person contributes nothing to a count, a rate, a
-- sum, a holdout arm or an export — including rows written after the erasure.
--
-- The views are parameterized on `{ws:UUID}`: the caller passes the workspace it is already
-- reading (`FROM events_protected(ws={ws:UUID})`), and the exclusion set is the workspace's ledger
-- built once per query by `IN (SELECT …)`. ClickHouse captures it as a single set
-- (`Capture[Set]`) and the filter is one `arrayExists` over the row's at most 16 subject keys.
-- Nothing materialises the ledger per row: an earlier version joined a `groupUniqArray` of the
-- whole ledger onto every row, and 100,000 exclusion hashes made a filtered count request
-- 10.13 GiB against a 3.41 GiB limit. A second version used one anti-join per kind; it was
-- correct but added sixteen joins to every read.
--
-- The exclusion is exact: every key is HMAC_exclusion(kind, value) under the workspace exclusion
-- key, so a value can only match its own kind, and `key_version` is deliberately ignored — an
-- erased identifier stays excluded under every retained key version.
--
-- Both side reads use the table's ordering prefix: `erased_subjects` and `subject_key_backfill`
-- are ordered by `workspace_id` first, and both subqueries name `workspace_id = {ws:UUID}` (the
-- backfill one also filters `table_name`). FINAL is applied to each read inside the view, so the
-- view returns one logical row per replacing key; a caller must not add FINAL to the view itself
-- (it would merge the view's output again). Workspace isolation otherwise stays with the existing
-- row policies on the base tables, which apply to the reads inside the view.
--
-- Subject keys are the row's own columns when `subject_coverage = 'full'`; otherwise they are
-- coalesced with the `subject_key_backfill` side entry, so a historical row that was never
-- rewritten is still excluded. The side join is fed by runtime filters built from the base rows
-- (workspace and identity), so it does not scan the workspace's whole backfill. A row that is
-- neither complete nor backfilled stays visible: the contract's conservative rule, counted by
-- `am doctor`'s subject-key coverage check and gated by part 3.
--
-- Adding a column to events, message_events or journey_events needs a new migration that recreates
-- the matching view: `SELECT e.*` is expanded when the view is created. A test compares the view's
-- columns with the table's and fails when they drift.
CREATE VIEW IF NOT EXISTS events_protected AS
SELECT e.*
FROM events AS e FINAL
LEFT JOIN (
  SELECT workspace_id AS side_workspace_id,
         key1 AS side_key1,
         key2 AS side_key2,
         key3 AS side_key3,
         key4 AS side_key4,
         subject_profile AS side_subject_profile,
         subject_anonymous AS side_subject_anonymous,
         subject_user AS side_subject_user,
         subject_previous AS side_subject_previous,
         subject_email AS side_subject_email,
         subject_phone AS side_subject_phone,
         subject_gclid AS side_subject_gclid,
         subject_gbraid AS side_subject_gbraid,
         subject_wbraid AS side_subject_wbraid,
         subject_fbc AS side_subject_fbc,
         subject_fbp AS side_subject_fbp,
         subject_msclkid AS side_subject_msclkid,
         subject_li_fat_id AS side_subject_li_fat_id,
         subject_ttclid AS side_subject_ttclid,
         subject_ttp AS side_subject_ttp,
         subject_epik AS side_subject_epik
  FROM subject_key_backfill FINAL
  WHERE workspace_id = {ws:UUID} AND table_name = 'events'
) AS s
  ON s.side_workspace_id = e.workspace_id
 AND s.side_key1 = e.name
 AND s.side_key2 = e.anonymous_id
 AND s.side_key3 = toString(e.timestamp)
 AND s.side_key4 = e.event_id
WHERE NOT arrayExists(
  k -> k != '' AND k IN (
    SELECT key FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}
  ),
  [
    if(e.subject_coverage = 'full', e.subject_profile, coalesce(nullIf(e.subject_profile, ''), s.side_subject_profile)),
    if(e.subject_coverage = 'full', e.subject_anonymous, coalesce(nullIf(e.subject_anonymous, ''), s.side_subject_anonymous)),
    if(e.subject_coverage = 'full', e.subject_user, coalesce(nullIf(e.subject_user, ''), s.side_subject_user)),
    if(e.subject_coverage = 'full', e.subject_previous, coalesce(nullIf(e.subject_previous, ''), s.side_subject_previous)),
    if(e.subject_coverage = 'full', e.subject_email, coalesce(nullIf(e.subject_email, ''), s.side_subject_email)),
    if(e.subject_coverage = 'full', e.subject_phone, coalesce(nullIf(e.subject_phone, ''), s.side_subject_phone)),
    if(e.subject_coverage = 'full', e.subject_gclid, coalesce(nullIf(e.subject_gclid, ''), s.side_subject_gclid)),
    if(e.subject_coverage = 'full', e.subject_gbraid, coalesce(nullIf(e.subject_gbraid, ''), s.side_subject_gbraid)),
    if(e.subject_coverage = 'full', e.subject_wbraid, coalesce(nullIf(e.subject_wbraid, ''), s.side_subject_wbraid)),
    if(e.subject_coverage = 'full', e.subject_fbc, coalesce(nullIf(e.subject_fbc, ''), s.side_subject_fbc)),
    if(e.subject_coverage = 'full', e.subject_fbp, coalesce(nullIf(e.subject_fbp, ''), s.side_subject_fbp)),
    if(e.subject_coverage = 'full', e.subject_msclkid, coalesce(nullIf(e.subject_msclkid, ''), s.side_subject_msclkid)),
    if(e.subject_coverage = 'full', e.subject_li_fat_id, coalesce(nullIf(e.subject_li_fat_id, ''), s.side_subject_li_fat_id)),
    if(e.subject_coverage = 'full', e.subject_ttclid, coalesce(nullIf(e.subject_ttclid, ''), s.side_subject_ttclid)),
    if(e.subject_coverage = 'full', e.subject_ttp, coalesce(nullIf(e.subject_ttp, ''), s.side_subject_ttp)),
    if(e.subject_coverage = 'full', e.subject_epik, coalesce(nullIf(e.subject_epik, ''), s.side_subject_epik))
  ]
);

CREATE VIEW IF NOT EXISTS message_events_protected AS
SELECT m.*
FROM message_events AS m FINAL
LEFT JOIN (
  SELECT workspace_id AS side_workspace_id,
         key1 AS side_key1,
         key2 AS side_key2,
         key3 AS side_key3,
         subject_profile AS side_subject_profile,
         subject_anonymous AS side_subject_anonymous,
         subject_user AS side_subject_user,
         subject_previous AS side_subject_previous,
         subject_email AS side_subject_email,
         subject_phone AS side_subject_phone,
         subject_gclid AS side_subject_gclid,
         subject_gbraid AS side_subject_gbraid,
         subject_wbraid AS side_subject_wbraid,
         subject_fbc AS side_subject_fbc,
         subject_fbp AS side_subject_fbp,
         subject_msclkid AS side_subject_msclkid,
         subject_li_fat_id AS side_subject_li_fat_id,
         subject_ttclid AS side_subject_ttclid,
         subject_ttp AS side_subject_ttp,
         subject_epik AS side_subject_epik
  FROM subject_key_backfill FINAL
  WHERE workspace_id = {ws:UUID} AND table_name = 'message_events'
) AS s
  ON s.side_workspace_id = m.workspace_id
 AND s.side_key1 = m.message_id
 AND s.side_key2 = m.type
 AND s.side_key3 = m.event_id
WHERE NOT arrayExists(
  k -> k != '' AND k IN (
    SELECT key FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}
  ),
  [
    if(m.subject_coverage = 'full', m.subject_profile, coalesce(nullIf(m.subject_profile, ''), s.side_subject_profile)),
    if(m.subject_coverage = 'full', m.subject_anonymous, coalesce(nullIf(m.subject_anonymous, ''), s.side_subject_anonymous)),
    if(m.subject_coverage = 'full', m.subject_user, coalesce(nullIf(m.subject_user, ''), s.side_subject_user)),
    if(m.subject_coverage = 'full', m.subject_previous, coalesce(nullIf(m.subject_previous, ''), s.side_subject_previous)),
    if(m.subject_coverage = 'full', m.subject_email, coalesce(nullIf(m.subject_email, ''), s.side_subject_email)),
    if(m.subject_coverage = 'full', m.subject_phone, coalesce(nullIf(m.subject_phone, ''), s.side_subject_phone)),
    if(m.subject_coverage = 'full', m.subject_gclid, coalesce(nullIf(m.subject_gclid, ''), s.side_subject_gclid)),
    if(m.subject_coverage = 'full', m.subject_gbraid, coalesce(nullIf(m.subject_gbraid, ''), s.side_subject_gbraid)),
    if(m.subject_coverage = 'full', m.subject_wbraid, coalesce(nullIf(m.subject_wbraid, ''), s.side_subject_wbraid)),
    if(m.subject_coverage = 'full', m.subject_fbc, coalesce(nullIf(m.subject_fbc, ''), s.side_subject_fbc)),
    if(m.subject_coverage = 'full', m.subject_fbp, coalesce(nullIf(m.subject_fbp, ''), s.side_subject_fbp)),
    if(m.subject_coverage = 'full', m.subject_msclkid, coalesce(nullIf(m.subject_msclkid, ''), s.side_subject_msclkid)),
    if(m.subject_coverage = 'full', m.subject_li_fat_id, coalesce(nullIf(m.subject_li_fat_id, ''), s.side_subject_li_fat_id)),
    if(m.subject_coverage = 'full', m.subject_ttclid, coalesce(nullIf(m.subject_ttclid, ''), s.side_subject_ttclid)),
    if(m.subject_coverage = 'full', m.subject_ttp, coalesce(nullIf(m.subject_ttp, ''), s.side_subject_ttp)),
    if(m.subject_coverage = 'full', m.subject_epik, coalesce(nullIf(m.subject_epik, ''), s.side_subject_epik))
  ]
);

CREATE VIEW IF NOT EXISTS journey_events_protected AS
SELECT j.*
FROM journey_events AS j FINAL
LEFT JOIN (
  SELECT workspace_id AS side_workspace_id,
         key1 AS side_key1,
         key2 AS side_key2,
         key3 AS side_key3,
         key4 AS side_key4,
         subject_profile AS side_subject_profile,
         subject_anonymous AS side_subject_anonymous,
         subject_user AS side_subject_user,
         subject_previous AS side_subject_previous,
         subject_email AS side_subject_email,
         subject_phone AS side_subject_phone,
         subject_gclid AS side_subject_gclid,
         subject_gbraid AS side_subject_gbraid,
         subject_wbraid AS side_subject_wbraid,
         subject_fbc AS side_subject_fbc,
         subject_fbp AS side_subject_fbp,
         subject_msclkid AS side_subject_msclkid,
         subject_li_fat_id AS side_subject_li_fat_id,
         subject_ttclid AS side_subject_ttclid,
         subject_ttp AS side_subject_ttp,
         subject_epik AS side_subject_epik
  FROM subject_key_backfill FINAL
  WHERE workspace_id = {ws:UUID} AND table_name = 'journey_events'
) AS s
  ON s.side_workspace_id = j.workspace_id
 AND s.side_key1 = j.journey_id
 AND s.side_key2 = toString(j.participant_id)
 AND s.side_key3 = toString(j.seq)
 AND s.side_key4 = j.type
WHERE NOT arrayExists(
  k -> k != '' AND k IN (
    SELECT key FROM erased_subjects FINAL WHERE workspace_id = {ws:UUID}
  ),
  [
    if(j.subject_coverage = 'full', j.subject_profile, coalesce(nullIf(j.subject_profile, ''), s.side_subject_profile)),
    if(j.subject_coverage = 'full', j.subject_anonymous, coalesce(nullIf(j.subject_anonymous, ''), s.side_subject_anonymous)),
    if(j.subject_coverage = 'full', j.subject_user, coalesce(nullIf(j.subject_user, ''), s.side_subject_user)),
    if(j.subject_coverage = 'full', j.subject_previous, coalesce(nullIf(j.subject_previous, ''), s.side_subject_previous)),
    if(j.subject_coverage = 'full', j.subject_email, coalesce(nullIf(j.subject_email, ''), s.side_subject_email)),
    if(j.subject_coverage = 'full', j.subject_phone, coalesce(nullIf(j.subject_phone, ''), s.side_subject_phone)),
    if(j.subject_coverage = 'full', j.subject_gclid, coalesce(nullIf(j.subject_gclid, ''), s.side_subject_gclid)),
    if(j.subject_coverage = 'full', j.subject_gbraid, coalesce(nullIf(j.subject_gbraid, ''), s.side_subject_gbraid)),
    if(j.subject_coverage = 'full', j.subject_wbraid, coalesce(nullIf(j.subject_wbraid, ''), s.side_subject_wbraid)),
    if(j.subject_coverage = 'full', j.subject_fbc, coalesce(nullIf(j.subject_fbc, ''), s.side_subject_fbc)),
    if(j.subject_coverage = 'full', j.subject_fbp, coalesce(nullIf(j.subject_fbp, ''), s.side_subject_fbp)),
    if(j.subject_coverage = 'full', j.subject_msclkid, coalesce(nullIf(j.subject_msclkid, ''), s.side_subject_msclkid)),
    if(j.subject_coverage = 'full', j.subject_li_fat_id, coalesce(nullIf(j.subject_li_fat_id, ''), s.side_subject_li_fat_id)),
    if(j.subject_coverage = 'full', j.subject_ttclid, coalesce(nullIf(j.subject_ttclid, ''), s.side_subject_ttclid)),
    if(j.subject_coverage = 'full', j.subject_ttp, coalesce(nullIf(j.subject_ttp, ''), s.side_subject_ttp)),
    if(j.subject_coverage = 'full', j.subject_epik, coalesce(nullIf(j.subject_epik, ''), s.side_subject_epik))
  ]
);

