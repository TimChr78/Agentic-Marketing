-- 0.17.6 (#1155): the conversion delivery's idempotency key gained the destination's action, so
-- two rules on one event and one connection queue their own delivery instead of colliding:
--
--   old: adc:<platform>:<connection>:<message id>
--   new: adc:<platform>:<connection>:<action>:<message id>
--
-- The profiles worker is at-least-once. A batch processed before the upgrade and redelivered after
-- it computes the new key, does not find the row queued under the old one, and queues a conversion
-- that may already have been sent. Rewrite the rows already in the outbox.
--
-- The destination is on the payload, so the action is derived with the same rule as `actionKeyOf`
-- in packages/ads/src/conversions.ts: the first of these that is present, else the empty string.
-- An old-format key is exactly the prefix the row itself spells out — its `action` is the platform,
-- its `target_id` the connection, and the message id the payload's `eventId` — so an already
-- rewritten key (which has one more component) never matches, and the update is harmless twice.
--
-- A redelivery after the upgrade may already have queued the new-format row next to the old one.
-- That row is the one the runtime keeps deduplicating against, so the old duplicate is deleted
-- rather than rewritten: leaving it would keep a second pending send of the same conversion. The
-- `NOT EXISTS` in the update covers a row that appears between the delete and the update.
DO $$
DECLARE
  w record;
BEGIN
  FOR w IN SELECT id FROM workspaces LOOP
    PERFORM set_config('app.workspace_id', w.id::text, true);

    DELETE FROM deliveries d
    WHERE d.workspace_id = w.id
      AND d.kind = 'ad_conversion'
      AND d.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' || (d.payload->>'eventId')
      AND EXISTS (
        SELECT 1
        FROM deliveries n
        WHERE n.workspace_id = d.workspace_id
          AND n.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' ||
            COALESCE(
              d.payload->'destination'->>'conversionAction',
              d.payload->'destination'->>'eventName',
              d.payload->'destination'->>'conversionName',
              d.payload->'destination'->>'conversionId',
              d.payload->'destination'->>'event',
              ''
            ) || ':' || (d.payload->>'eventId')
      );

    UPDATE deliveries d
    SET idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' ||
      COALESCE(
        d.payload->'destination'->>'conversionAction',
        d.payload->'destination'->>'eventName',
        d.payload->'destination'->>'conversionName',
        d.payload->'destination'->>'conversionId',
        d.payload->'destination'->>'event',
        ''
      ) || ':' || (d.payload->>'eventId')
    WHERE d.workspace_id = w.id
      AND d.kind = 'ad_conversion'
      AND d.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' || (d.payload->>'eventId')
      AND NOT EXISTS (
        SELECT 1
        FROM deliveries n
        WHERE n.workspace_id = d.workspace_id
          AND n.idempotency_key = 'adc:' || d.action || ':' || d.target_id || ':' ||
            COALESCE(
              d.payload->'destination'->>'conversionAction',
              d.payload->'destination'->>'eventName',
              d.payload->'destination'->>'conversionName',
              d.payload->'destination'->>'conversionId',
              d.payload->'destination'->>'event',
              ''
            ) || ':' || (d.payload->>'eventId')
      );
  END LOOP;
END $$;
