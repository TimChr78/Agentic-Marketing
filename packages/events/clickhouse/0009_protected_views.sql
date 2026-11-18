-- Protected reads (#1037, 0.17.0 part 2).
--
-- Every application read of person-linked data goes through one of these views instead of the
-- base table. A row is excluded when any subject key it carries, or any key the backfill side
-- table supplies for its identity, matches an `erased_subjects` row of the same workspace. The
-- filter runs before aggregation, so an erased person contributes nothing to a count, a rate, a
-- sum, a holdout arm or an export — including rows written after the erasure.
--
-- The exclusion is one LEFT ANTI JOIN per subject kind. Each join's right side is only that
-- kind's keys, and the join is on (workspace_id, key), so the planner reads `erased_subjects` with
-- `kind = … AND workspace_id = …` — the table's ordering prefix — and never materialises the whole
-- ledger into a per-row array. (A groupUniqArray joined onto every row allocates greedily: with
-- 100k exclusion hashes a filtered count exhausted a 3.4 GiB limit.) A kind filter is exact, not
-- an approximation: every key is HMAC_exclusion(kind, value) under the workspace exclusion key, so
-- a value can only match a row of its own kind.
--
-- The join to `subject_key_backfill` is restricted by the base rows too: ClickHouse builds runtime
-- filters from the scanned event identities (workspace, name/message/journey keys, timestamp or
-- seq, event id) and applies them to the side-table read, so a narrow query does not scan the
-- workspace's whole backfill. The side join is only consulted when `subject_coverage` is not
-- `full`; a writer's complete row is never overridden by a backfill.
--
-- `key_version` is deliberately ignored: an erased identifier stays excluded under every retained
-- exclusion key version. FINAL is applied to each side inside the view, so the view returns one
-- logical row per replacing key. A caller must not add FINAL to the view: it would merge the
-- view's output again. Workspace isolation stays with the existing row policies on the base
-- tables, which apply to the reads inside the view.
--
-- Rows that are neither `full` nor backfilled (no side entry) stay visible: the contract's
-- conservative rule for historical rows, counted by the `am doctor` subject-key coverage check and
-- gated by part 3.
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
  WHERE table_name = 'events'
) AS s
  ON s.side_workspace_id = e.workspace_id
 AND s.side_key1 = e.name
 AND s.side_key2 = e.anonymous_id
 AND s.side_key3 = toString(e.timestamp)
 AND s.side_key4 = e.event_id
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'profile'
) AS er_profile
  ON er_profile.er_workspace_id = e.workspace_id
 AND er_profile.er_key = if(e.subject_coverage = 'full', e.subject_profile, coalesce(nullIf(e.subject_profile, ''), s.side_subject_profile))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'anonymous_id'
) AS er_anonymous_id
  ON er_anonymous_id.er_workspace_id = e.workspace_id
 AND er_anonymous_id.er_key = if(e.subject_coverage = 'full', e.subject_anonymous, coalesce(nullIf(e.subject_anonymous, ''), s.side_subject_anonymous))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'user_id'
) AS er_user_id
  ON er_user_id.er_workspace_id = e.workspace_id
 AND er_user_id.er_key = if(e.subject_coverage = 'full', e.subject_user, coalesce(nullIf(e.subject_user, ''), s.side_subject_user))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'alias_previous_id'
) AS er_alias_previous_id
  ON er_alias_previous_id.er_workspace_id = e.workspace_id
 AND er_alias_previous_id.er_key = if(e.subject_coverage = 'full', e.subject_previous, coalesce(nullIf(e.subject_previous, ''), s.side_subject_previous))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'email'
) AS er_email
  ON er_email.er_workspace_id = e.workspace_id
 AND er_email.er_key = if(e.subject_coverage = 'full', e.subject_email, coalesce(nullIf(e.subject_email, ''), s.side_subject_email))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'phone'
) AS er_phone
  ON er_phone.er_workspace_id = e.workspace_id
 AND er_phone.er_key = if(e.subject_coverage = 'full', e.subject_phone, coalesce(nullIf(e.subject_phone, ''), s.side_subject_phone))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'gclid'
) AS er_gclid
  ON er_gclid.er_workspace_id = e.workspace_id
 AND er_gclid.er_key = if(e.subject_coverage = 'full', e.subject_gclid, coalesce(nullIf(e.subject_gclid, ''), s.side_subject_gclid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'gbraid'
) AS er_gbraid
  ON er_gbraid.er_workspace_id = e.workspace_id
 AND er_gbraid.er_key = if(e.subject_coverage = 'full', e.subject_gbraid, coalesce(nullIf(e.subject_gbraid, ''), s.side_subject_gbraid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'wbraid'
) AS er_wbraid
  ON er_wbraid.er_workspace_id = e.workspace_id
 AND er_wbraid.er_key = if(e.subject_coverage = 'full', e.subject_wbraid, coalesce(nullIf(e.subject_wbraid, ''), s.side_subject_wbraid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'fbc'
) AS er_fbc
  ON er_fbc.er_workspace_id = e.workspace_id
 AND er_fbc.er_key = if(e.subject_coverage = 'full', e.subject_fbc, coalesce(nullIf(e.subject_fbc, ''), s.side_subject_fbc))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'fbp'
) AS er_fbp
  ON er_fbp.er_workspace_id = e.workspace_id
 AND er_fbp.er_key = if(e.subject_coverage = 'full', e.subject_fbp, coalesce(nullIf(e.subject_fbp, ''), s.side_subject_fbp))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'msclkid'
) AS er_msclkid
  ON er_msclkid.er_workspace_id = e.workspace_id
 AND er_msclkid.er_key = if(e.subject_coverage = 'full', e.subject_msclkid, coalesce(nullIf(e.subject_msclkid, ''), s.side_subject_msclkid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'li_fat_id'
) AS er_li_fat_id
  ON er_li_fat_id.er_workspace_id = e.workspace_id
 AND er_li_fat_id.er_key = if(e.subject_coverage = 'full', e.subject_li_fat_id, coalesce(nullIf(e.subject_li_fat_id, ''), s.side_subject_li_fat_id))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'ttclid'
) AS er_ttclid
  ON er_ttclid.er_workspace_id = e.workspace_id
 AND er_ttclid.er_key = if(e.subject_coverage = 'full', e.subject_ttclid, coalesce(nullIf(e.subject_ttclid, ''), s.side_subject_ttclid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'ttp'
) AS er_ttp
  ON er_ttp.er_workspace_id = e.workspace_id
 AND er_ttp.er_key = if(e.subject_coverage = 'full', e.subject_ttp, coalesce(nullIf(e.subject_ttp, ''), s.side_subject_ttp))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'epik'
) AS er_epik
  ON er_epik.er_workspace_id = e.workspace_id
 AND er_epik.er_key = if(e.subject_coverage = 'full', e.subject_epik, coalesce(nullIf(e.subject_epik, ''), s.side_subject_epik));

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
  WHERE table_name = 'message_events'
) AS s
  ON s.side_workspace_id = m.workspace_id
 AND s.side_key1 = m.message_id
 AND s.side_key2 = m.type
 AND s.side_key3 = m.event_id
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'profile'
) AS er_profile
  ON er_profile.er_workspace_id = m.workspace_id
 AND er_profile.er_key = if(m.subject_coverage = 'full', m.subject_profile, coalesce(nullIf(m.subject_profile, ''), s.side_subject_profile))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'anonymous_id'
) AS er_anonymous_id
  ON er_anonymous_id.er_workspace_id = m.workspace_id
 AND er_anonymous_id.er_key = if(m.subject_coverage = 'full', m.subject_anonymous, coalesce(nullIf(m.subject_anonymous, ''), s.side_subject_anonymous))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'user_id'
) AS er_user_id
  ON er_user_id.er_workspace_id = m.workspace_id
 AND er_user_id.er_key = if(m.subject_coverage = 'full', m.subject_user, coalesce(nullIf(m.subject_user, ''), s.side_subject_user))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'alias_previous_id'
) AS er_alias_previous_id
  ON er_alias_previous_id.er_workspace_id = m.workspace_id
 AND er_alias_previous_id.er_key = if(m.subject_coverage = 'full', m.subject_previous, coalesce(nullIf(m.subject_previous, ''), s.side_subject_previous))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'email'
) AS er_email
  ON er_email.er_workspace_id = m.workspace_id
 AND er_email.er_key = if(m.subject_coverage = 'full', m.subject_email, coalesce(nullIf(m.subject_email, ''), s.side_subject_email))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'phone'
) AS er_phone
  ON er_phone.er_workspace_id = m.workspace_id
 AND er_phone.er_key = if(m.subject_coverage = 'full', m.subject_phone, coalesce(nullIf(m.subject_phone, ''), s.side_subject_phone))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'gclid'
) AS er_gclid
  ON er_gclid.er_workspace_id = m.workspace_id
 AND er_gclid.er_key = if(m.subject_coverage = 'full', m.subject_gclid, coalesce(nullIf(m.subject_gclid, ''), s.side_subject_gclid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'gbraid'
) AS er_gbraid
  ON er_gbraid.er_workspace_id = m.workspace_id
 AND er_gbraid.er_key = if(m.subject_coverage = 'full', m.subject_gbraid, coalesce(nullIf(m.subject_gbraid, ''), s.side_subject_gbraid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'wbraid'
) AS er_wbraid
  ON er_wbraid.er_workspace_id = m.workspace_id
 AND er_wbraid.er_key = if(m.subject_coverage = 'full', m.subject_wbraid, coalesce(nullIf(m.subject_wbraid, ''), s.side_subject_wbraid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'fbc'
) AS er_fbc
  ON er_fbc.er_workspace_id = m.workspace_id
 AND er_fbc.er_key = if(m.subject_coverage = 'full', m.subject_fbc, coalesce(nullIf(m.subject_fbc, ''), s.side_subject_fbc))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'fbp'
) AS er_fbp
  ON er_fbp.er_workspace_id = m.workspace_id
 AND er_fbp.er_key = if(m.subject_coverage = 'full', m.subject_fbp, coalesce(nullIf(m.subject_fbp, ''), s.side_subject_fbp))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'msclkid'
) AS er_msclkid
  ON er_msclkid.er_workspace_id = m.workspace_id
 AND er_msclkid.er_key = if(m.subject_coverage = 'full', m.subject_msclkid, coalesce(nullIf(m.subject_msclkid, ''), s.side_subject_msclkid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'li_fat_id'
) AS er_li_fat_id
  ON er_li_fat_id.er_workspace_id = m.workspace_id
 AND er_li_fat_id.er_key = if(m.subject_coverage = 'full', m.subject_li_fat_id, coalesce(nullIf(m.subject_li_fat_id, ''), s.side_subject_li_fat_id))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'ttclid'
) AS er_ttclid
  ON er_ttclid.er_workspace_id = m.workspace_id
 AND er_ttclid.er_key = if(m.subject_coverage = 'full', m.subject_ttclid, coalesce(nullIf(m.subject_ttclid, ''), s.side_subject_ttclid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'ttp'
) AS er_ttp
  ON er_ttp.er_workspace_id = m.workspace_id
 AND er_ttp.er_key = if(m.subject_coverage = 'full', m.subject_ttp, coalesce(nullIf(m.subject_ttp, ''), s.side_subject_ttp))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'epik'
) AS er_epik
  ON er_epik.er_workspace_id = m.workspace_id
 AND er_epik.er_key = if(m.subject_coverage = 'full', m.subject_epik, coalesce(nullIf(m.subject_epik, ''), s.side_subject_epik));

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
  WHERE table_name = 'journey_events'
) AS s
  ON s.side_workspace_id = j.workspace_id
 AND s.side_key1 = j.journey_id
 AND s.side_key2 = toString(j.participant_id)
 AND s.side_key3 = toString(j.seq)
 AND s.side_key4 = j.type
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'profile'
) AS er_profile
  ON er_profile.er_workspace_id = j.workspace_id
 AND er_profile.er_key = if(j.subject_coverage = 'full', j.subject_profile, coalesce(nullIf(j.subject_profile, ''), s.side_subject_profile))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'anonymous_id'
) AS er_anonymous_id
  ON er_anonymous_id.er_workspace_id = j.workspace_id
 AND er_anonymous_id.er_key = if(j.subject_coverage = 'full', j.subject_anonymous, coalesce(nullIf(j.subject_anonymous, ''), s.side_subject_anonymous))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'user_id'
) AS er_user_id
  ON er_user_id.er_workspace_id = j.workspace_id
 AND er_user_id.er_key = if(j.subject_coverage = 'full', j.subject_user, coalesce(nullIf(j.subject_user, ''), s.side_subject_user))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'alias_previous_id'
) AS er_alias_previous_id
  ON er_alias_previous_id.er_workspace_id = j.workspace_id
 AND er_alias_previous_id.er_key = if(j.subject_coverage = 'full', j.subject_previous, coalesce(nullIf(j.subject_previous, ''), s.side_subject_previous))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'email'
) AS er_email
  ON er_email.er_workspace_id = j.workspace_id
 AND er_email.er_key = if(j.subject_coverage = 'full', j.subject_email, coalesce(nullIf(j.subject_email, ''), s.side_subject_email))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'phone'
) AS er_phone
  ON er_phone.er_workspace_id = j.workspace_id
 AND er_phone.er_key = if(j.subject_coverage = 'full', j.subject_phone, coalesce(nullIf(j.subject_phone, ''), s.side_subject_phone))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'gclid'
) AS er_gclid
  ON er_gclid.er_workspace_id = j.workspace_id
 AND er_gclid.er_key = if(j.subject_coverage = 'full', j.subject_gclid, coalesce(nullIf(j.subject_gclid, ''), s.side_subject_gclid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'gbraid'
) AS er_gbraid
  ON er_gbraid.er_workspace_id = j.workspace_id
 AND er_gbraid.er_key = if(j.subject_coverage = 'full', j.subject_gbraid, coalesce(nullIf(j.subject_gbraid, ''), s.side_subject_gbraid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'wbraid'
) AS er_wbraid
  ON er_wbraid.er_workspace_id = j.workspace_id
 AND er_wbraid.er_key = if(j.subject_coverage = 'full', j.subject_wbraid, coalesce(nullIf(j.subject_wbraid, ''), s.side_subject_wbraid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'fbc'
) AS er_fbc
  ON er_fbc.er_workspace_id = j.workspace_id
 AND er_fbc.er_key = if(j.subject_coverage = 'full', j.subject_fbc, coalesce(nullIf(j.subject_fbc, ''), s.side_subject_fbc))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'fbp'
) AS er_fbp
  ON er_fbp.er_workspace_id = j.workspace_id
 AND er_fbp.er_key = if(j.subject_coverage = 'full', j.subject_fbp, coalesce(nullIf(j.subject_fbp, ''), s.side_subject_fbp))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'msclkid'
) AS er_msclkid
  ON er_msclkid.er_workspace_id = j.workspace_id
 AND er_msclkid.er_key = if(j.subject_coverage = 'full', j.subject_msclkid, coalesce(nullIf(j.subject_msclkid, ''), s.side_subject_msclkid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'li_fat_id'
) AS er_li_fat_id
  ON er_li_fat_id.er_workspace_id = j.workspace_id
 AND er_li_fat_id.er_key = if(j.subject_coverage = 'full', j.subject_li_fat_id, coalesce(nullIf(j.subject_li_fat_id, ''), s.side_subject_li_fat_id))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'ttclid'
) AS er_ttclid
  ON er_ttclid.er_workspace_id = j.workspace_id
 AND er_ttclid.er_key = if(j.subject_coverage = 'full', j.subject_ttclid, coalesce(nullIf(j.subject_ttclid, ''), s.side_subject_ttclid))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'ttp'
) AS er_ttp
  ON er_ttp.er_workspace_id = j.workspace_id
 AND er_ttp.er_key = if(j.subject_coverage = 'full', j.subject_ttp, coalesce(nullIf(j.subject_ttp, ''), s.side_subject_ttp))
LEFT ANTI JOIN (
  SELECT workspace_id AS er_workspace_id, key AS er_key
  FROM erased_subjects FINAL
  WHERE kind = 'epik'
) AS er_epik
  ON er_epik.er_workspace_id = j.workspace_id
 AND er_epik.er_key = if(j.subject_coverage = 'full', j.subject_epik, coalesce(nullIf(j.subject_epik, ''), s.side_subject_epik));

