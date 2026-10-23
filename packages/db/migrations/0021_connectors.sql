-- Phase 11 (wave 2), part e: click ids of LinkedIn (li_fat_id), TikTok (ttclid, the _ttp
-- cookie) and Pinterest (epik), kept like the others only with ad_measurement allowed.
ALTER TABLE identifiers DROP CONSTRAINT identifiers_type_check;
ALTER TABLE identifiers ADD CONSTRAINT identifiers_type_check
  CHECK (type IN ('anonymous_id', 'user_id', 'email', 'phone', 'gclid', 'gbraid', 'wbraid', 'fbc', 'fbp', 'msclkid', 'li_fat_id', 'ttclid', 'ttp', 'epik'));
