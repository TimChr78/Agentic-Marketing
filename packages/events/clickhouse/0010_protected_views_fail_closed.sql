-- Protected reads fail closed on an uncovered row (#1195).
--
-- 0009's views kept a row that was neither complete (`subject_coverage = 'full'`) nor covered by a
-- `subject_key_backfill` side entry visible, on the conservative rule that it carries no key that
-- could match. That rule is wrong for a workspace with a completed erasure: a legacy-shaped writer
-- (an undrained pre-0.17.0 replica, a restored pre-0.17 table, manual SQL) can insert a row that
-- still names the erased person after the coverage gate recorded zero. Until the next backfill pass
-- hashed it — up to an hour later — the protected reads returned it.
--
-- The view now treats such a row as unverified and removes it once the workspace has published
-- exclusions. A row is covered when its own writer filled the subject columns (`full`) or when the
-- backfill left a side entry for its identity; the `side_found` marker distinguishes a missing side
-- entry from a side entry whose keys are all empty (which is a real, examined result for a row with
-- no supported identifier). Rows with no identifier at all are written as `full` by the current
-- writer, so ordinary anonymous traffic is not affected. The one-row existence check keeps the
-- fail-closed rule scoped to a workspace that actually has something to exclude: before its first
-- publication the erased subject is still readable (the contract's deliberate ordering), so hiding
-- legacy rows adds no privacy in that window.
--
-- Nothing else changes: the views are still parameterized on `{ws:UUID}`, dedupe with FINAL, and
-- exclude with one set per query over the row's at most sixteen subject keys. CREATE OR REPLACE swaps
-- each view atomically, so a read during the upgrade never finds a view missing (#1200 review).
CREATE OR REPLACE VIEW events_protected AS
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
         subject_epik AS side_subject_epik,
         1 AS side_found
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
)
AND (e.subject_coverage = 'full' OR s.side_found = 1
     OR NOT EXISTS (SELECT 1 FROM erased_subjects WHERE workspace_id = {ws:UUID} LIMIT 1));

CREATE OR REPLACE VIEW message_events_protected AS
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
         subject_epik AS side_subject_epik,
         1 AS side_found
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
)
AND (m.subject_coverage = 'full' OR s.side_found = 1
     OR NOT EXISTS (SELECT 1 FROM erased_subjects WHERE workspace_id = {ws:UUID} LIMIT 1));

CREATE OR REPLACE VIEW journey_events_protected AS
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
         subject_epik AS side_subject_epik,
         1 AS side_found
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
)
AND (j.subject_coverage = 'full' OR s.side_found = 1
     OR NOT EXISTS (SELECT 1 FROM erased_subjects WHERE workspace_id = {ws:UUID} LIMIT 1));
