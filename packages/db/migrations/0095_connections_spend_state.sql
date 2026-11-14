-- Spend import completeness, server-owned (#917 review round 2). The import records which date
-- ranges it could not fetch completely; ads.performance reads them. It lives in its own column, not
-- in `settings`, so a rename or any other connections.update cannot strip it and a caller can never
-- set it: the connector's settings schema does not see this column, and connectionOut never returns
-- it. Table-level grants already cover the new column.
ALTER TABLE connections ADD COLUMN IF NOT EXISTS spend_state jsonb NOT NULL DEFAULT '{}';
