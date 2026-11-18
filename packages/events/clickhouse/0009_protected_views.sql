-- Protected reads (#1037, 0.17.0 part 2).
--
-- Every application read of person-linked data goes through one of these views instead of the
-- base table. A row is excluded when any subject key it carries, or any key the backfill side
-- table supplies for its identity, matches an `erased_subjects` row of the same workspace. The
-- filter runs before aggregation, so an erased person contributes nothing to a count, a rate, a
-- sum, a holdout arm or an export — including rows written after the erasure.
--
-- The match is on the key value alone, not on (kind, key): every key is HMAC_exclusion(kind,
-- value) under the workspace exclusion key, so a value is bound to its kind by the HMAC input.
-- `key_version` is deliberately ignored: an erased identifier stays excluded under every retained
-- exclusion key version.
--
-- Subject keys are the row's own columns when `subject_coverage = 'full'`. Otherwise the row's
-- values are coalesced with the backfill side table, which is keyed by the table's complete
-- replacing key (events: name, anonymous_id, timestamp, event_id; message_events: message_id,
-- type, event_id; journey_events: journey_id, participant_id, seq, type). A row that is neither
-- `full` nor backfilled (no side entry) stays visible: the contract's conservative rule for
-- historical rows, counted by the `am doctor` subject-key coverage check and gated by part 3.
--
-- FINAL is applied to each side inside the view, so the view returns one logical row per replacing
-- key. A caller must not add FINAL to the view: it would merge the view's output again. Workspace
-- isolation stays with the existing row policies on the base tables, which apply to the reads
-- inside the view.
--
-- Adding a column to events, message_events or journey_events needs a new migration that recreates
-- the matching view: `SELECT e.*` is expanded when the view is created. A test compares the view's
-- columns with the table's and fails when they drift.
CREATE VIEW IF NOT EXISTS events_protected AS
SELECT e.*
FROM events AS e FINAL
LEFT JOIN (
  SELECT workspace_id AS side_workspace_id,
         table_name AS side_table_name,
         key1 AS side_key1,
         key2 AS side_key2,
         key3 AS side_key3,
         key4 AS side_key4,
         subject_profile AS side_profile,
         subject_anonymous AS side_anonymous,
         subject_user AS side_user,
         subject_previous AS side_previous,
         subject_email AS side_email,
         subject_phone AS side_phone,
         subject_gclid AS side_gclid,
         subject_gbraid AS side_gbraid,
         subject_wbraid AS side_wbraid,
         subject_fbc AS side_fbc,
         subject_fbp AS side_fbp,
         subject_msclkid AS side_msclkid,
         subject_li_fat_id AS side_li_fat_id,
         subject_ttclid AS side_ttclid,
         subject_ttp AS side_ttp,
         subject_epik AS side_epik
  FROM subject_key_backfill FINAL
  WHERE table_name = 'events'
) AS s
  ON s.side_workspace_id = e.workspace_id
 AND s.side_key1 = e.name
 AND s.side_key2 = e.anonymous_id
 AND s.side_key3 = toString(e.timestamp)
 AND s.side_key4 = e.event_id
LEFT JOIN (
  SELECT workspace_id AS erased_workspace_id, groupUniqArray(key) AS erased_keys
  FROM erased_subjects FINAL
  GROUP BY workspace_id
) AS er ON er.erased_workspace_id = e.workspace_id
WHERE NOT arrayExists(
  k -> k != '' AND has(ifNull(er.erased_keys, emptyArrayString()), k),
  [
    if(e.subject_coverage = 'full', e.subject_profile, coalesce(nullIf(e.subject_profile, ''), s.side_profile)),
    if(e.subject_coverage = 'full', e.subject_anonymous, coalesce(nullIf(e.subject_anonymous, ''), s.side_anonymous)),
    if(e.subject_coverage = 'full', e.subject_user, coalesce(nullIf(e.subject_user, ''), s.side_user)),
    if(e.subject_coverage = 'full', e.subject_previous, coalesce(nullIf(e.subject_previous, ''), s.side_previous)),
    if(e.subject_coverage = 'full', e.subject_email, coalesce(nullIf(e.subject_email, ''), s.side_email)),
    if(e.subject_coverage = 'full', e.subject_phone, coalesce(nullIf(e.subject_phone, ''), s.side_phone)),
    if(e.subject_coverage = 'full', e.subject_gclid, coalesce(nullIf(e.subject_gclid, ''), s.side_gclid)),
    if(e.subject_coverage = 'full', e.subject_gbraid, coalesce(nullIf(e.subject_gbraid, ''), s.side_gbraid)),
    if(e.subject_coverage = 'full', e.subject_wbraid, coalesce(nullIf(e.subject_wbraid, ''), s.side_wbraid)),
    if(e.subject_coverage = 'full', e.subject_fbc, coalesce(nullIf(e.subject_fbc, ''), s.side_fbc)),
    if(e.subject_coverage = 'full', e.subject_fbp, coalesce(nullIf(e.subject_fbp, ''), s.side_fbp)),
    if(e.subject_coverage = 'full', e.subject_msclkid, coalesce(nullIf(e.subject_msclkid, ''), s.side_msclkid)),
    if(e.subject_coverage = 'full', e.subject_li_fat_id, coalesce(nullIf(e.subject_li_fat_id, ''), s.side_li_fat_id)),
    if(e.subject_coverage = 'full', e.subject_ttclid, coalesce(nullIf(e.subject_ttclid, ''), s.side_ttclid)),
    if(e.subject_coverage = 'full', e.subject_ttp, coalesce(nullIf(e.subject_ttp, ''), s.side_ttp)),
    if(e.subject_coverage = 'full', e.subject_epik, coalesce(nullIf(e.subject_epik, ''), s.side_epik))
  ]
);

CREATE VIEW IF NOT EXISTS message_events_protected AS
SELECT m.*
FROM message_events AS m FINAL
LEFT JOIN (
  SELECT workspace_id AS side_workspace_id,
         table_name AS side_table_name,
         key1 AS side_key1,
         key2 AS side_key2,
         key3 AS side_key3,
         subject_profile AS side_profile,
         subject_anonymous AS side_anonymous,
         subject_user AS side_user,
         subject_previous AS side_previous,
         subject_email AS side_email,
         subject_phone AS side_phone,
         subject_gclid AS side_gclid,
         subject_gbraid AS side_gbraid,
         subject_wbraid AS side_wbraid,
         subject_fbc AS side_fbc,
         subject_fbp AS side_fbp,
         subject_msclkid AS side_msclkid,
         subject_li_fat_id AS side_li_fat_id,
         subject_ttclid AS side_ttclid,
         subject_ttp AS side_ttp,
         subject_epik AS side_epik
  FROM subject_key_backfill FINAL
  WHERE table_name = 'message_events'
) AS s
  ON s.side_workspace_id = m.workspace_id
 AND s.side_key1 = m.message_id
 AND s.side_key2 = m.type
 AND s.side_key3 = m.event_id
LEFT JOIN (
  SELECT workspace_id AS erased_workspace_id, groupUniqArray(key) AS erased_keys
  FROM erased_subjects FINAL
  GROUP BY workspace_id
) AS er ON er.erased_workspace_id = m.workspace_id
WHERE NOT arrayExists(
  k -> k != '' AND has(ifNull(er.erased_keys, emptyArrayString()), k),
  [
    if(m.subject_coverage = 'full', m.subject_profile, coalesce(nullIf(m.subject_profile, ''), s.side_profile)),
    if(m.subject_coverage = 'full', m.subject_anonymous, coalesce(nullIf(m.subject_anonymous, ''), s.side_anonymous)),
    if(m.subject_coverage = 'full', m.subject_user, coalesce(nullIf(m.subject_user, ''), s.side_user)),
    if(m.subject_coverage = 'full', m.subject_previous, coalesce(nullIf(m.subject_previous, ''), s.side_previous)),
    if(m.subject_coverage = 'full', m.subject_email, coalesce(nullIf(m.subject_email, ''), s.side_email)),
    if(m.subject_coverage = 'full', m.subject_phone, coalesce(nullIf(m.subject_phone, ''), s.side_phone)),
    if(m.subject_coverage = 'full', m.subject_gclid, coalesce(nullIf(m.subject_gclid, ''), s.side_gclid)),
    if(m.subject_coverage = 'full', m.subject_gbraid, coalesce(nullIf(m.subject_gbraid, ''), s.side_gbraid)),
    if(m.subject_coverage = 'full', m.subject_wbraid, coalesce(nullIf(m.subject_wbraid, ''), s.side_wbraid)),
    if(m.subject_coverage = 'full', m.subject_fbc, coalesce(nullIf(m.subject_fbc, ''), s.side_fbc)),
    if(m.subject_coverage = 'full', m.subject_fbp, coalesce(nullIf(m.subject_fbp, ''), s.side_fbp)),
    if(m.subject_coverage = 'full', m.subject_msclkid, coalesce(nullIf(m.subject_msclkid, ''), s.side_msclkid)),
    if(m.subject_coverage = 'full', m.subject_li_fat_id, coalesce(nullIf(m.subject_li_fat_id, ''), s.side_li_fat_id)),
    if(m.subject_coverage = 'full', m.subject_ttclid, coalesce(nullIf(m.subject_ttclid, ''), s.side_ttclid)),
    if(m.subject_coverage = 'full', m.subject_ttp, coalesce(nullIf(m.subject_ttp, ''), s.side_ttp)),
    if(m.subject_coverage = 'full', m.subject_epik, coalesce(nullIf(m.subject_epik, ''), s.side_epik))
  ]
);

CREATE VIEW IF NOT EXISTS journey_events_protected AS
SELECT j.*
FROM journey_events AS j FINAL
LEFT JOIN (
  SELECT workspace_id AS side_workspace_id,
         table_name AS side_table_name,
         key1 AS side_key1,
         key2 AS side_key2,
         key3 AS side_key3,
         key4 AS side_key4,
         subject_profile AS side_profile,
         subject_anonymous AS side_anonymous,
         subject_user AS side_user,
         subject_previous AS side_previous,
         subject_email AS side_email,
         subject_phone AS side_phone,
         subject_gclid AS side_gclid,
         subject_gbraid AS side_gbraid,
         subject_wbraid AS side_wbraid,
         subject_fbc AS side_fbc,
         subject_fbp AS side_fbp,
         subject_msclkid AS side_msclkid,
         subject_li_fat_id AS side_li_fat_id,
         subject_ttclid AS side_ttclid,
         subject_ttp AS side_ttp,
         subject_epik AS side_epik
  FROM subject_key_backfill FINAL
  WHERE table_name = 'journey_events'
) AS s
  ON s.side_workspace_id = j.workspace_id
 AND s.side_key1 = j.journey_id
 AND s.side_key2 = toString(j.participant_id)
 AND s.side_key3 = toString(j.seq)
 AND s.side_key4 = j.type
LEFT JOIN (
  SELECT workspace_id AS erased_workspace_id, groupUniqArray(key) AS erased_keys
  FROM erased_subjects FINAL
  GROUP BY workspace_id
) AS er ON er.erased_workspace_id = j.workspace_id
WHERE NOT arrayExists(
  k -> k != '' AND has(ifNull(er.erased_keys, emptyArrayString()), k),
  [
    if(j.subject_coverage = 'full', j.subject_profile, coalesce(nullIf(j.subject_profile, ''), s.side_profile)),
    if(j.subject_coverage = 'full', j.subject_anonymous, coalesce(nullIf(j.subject_anonymous, ''), s.side_anonymous)),
    if(j.subject_coverage = 'full', j.subject_user, coalesce(nullIf(j.subject_user, ''), s.side_user)),
    if(j.subject_coverage = 'full', j.subject_previous, coalesce(nullIf(j.subject_previous, ''), s.side_previous)),
    if(j.subject_coverage = 'full', j.subject_email, coalesce(nullIf(j.subject_email, ''), s.side_email)),
    if(j.subject_coverage = 'full', j.subject_phone, coalesce(nullIf(j.subject_phone, ''), s.side_phone)),
    if(j.subject_coverage = 'full', j.subject_gclid, coalesce(nullIf(j.subject_gclid, ''), s.side_gclid)),
    if(j.subject_coverage = 'full', j.subject_gbraid, coalesce(nullIf(j.subject_gbraid, ''), s.side_gbraid)),
    if(j.subject_coverage = 'full', j.subject_wbraid, coalesce(nullIf(j.subject_wbraid, ''), s.side_wbraid)),
    if(j.subject_coverage = 'full', j.subject_fbc, coalesce(nullIf(j.subject_fbc, ''), s.side_fbc)),
    if(j.subject_coverage = 'full', j.subject_fbp, coalesce(nullIf(j.subject_fbp, ''), s.side_fbp)),
    if(j.subject_coverage = 'full', j.subject_msclkid, coalesce(nullIf(j.subject_msclkid, ''), s.side_msclkid)),
    if(j.subject_coverage = 'full', j.subject_li_fat_id, coalesce(nullIf(j.subject_li_fat_id, ''), s.side_li_fat_id)),
    if(j.subject_coverage = 'full', j.subject_ttclid, coalesce(nullIf(j.subject_ttclid, ''), s.side_ttclid)),
    if(j.subject_coverage = 'full', j.subject_ttp, coalesce(nullIf(j.subject_ttp, ''), s.side_ttp)),
    if(j.subject_coverage = 'full', j.subject_epik, coalesce(nullIf(j.subject_epik, ''), s.side_epik))
  ]
);
