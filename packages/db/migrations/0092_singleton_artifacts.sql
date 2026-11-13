-- Singleton artifacts are one per workspace (#869). Until now that was only an application check:
-- config.import could insert two rows of one type in one bundle, and two concurrent
-- artifacts.create calls could both pass the read. Resolve the duplicates that already exist, then
-- let the database enforce the invariant.
--
-- Which row survives, per (workspace_id, type), is deterministic:
--   * a published row wins over a draft (the live configuration is what people see);
--   * among published rows, the oldest created_at wins (ties broken by id);
--   * with no published row, the oldest created_at wins (ties broken by id).
-- The rest are archived, not deleted: their versions, approvals and audit history stay readable.
-- Their names gain " (archived duplicate <id>)" so an operator can tell them apart when restoring
-- or inspecting one. Archived rows are excluded from the unique index, so a workspace can archive
-- its live singleton and create a new one.
-- artifacts FORCEs row-level security. A migration role that is not a superuser and has no
-- BYPASSRLS would see no rows here, so the duplicate cleanup would silently do nothing and the
-- index creation would then fail. Read and write as the table owner with FORCE off for this
-- statement, then turn it back on before the migration commits (as 0072, 0083 and 0087 do).
ALTER TABLE artifacts NO FORCE ROW LEVEL SECURITY;

WITH ranked AS (
  SELECT workspace_id,
         id,
         row_number() OVER (
           PARTITION BY workspace_id, type
           ORDER BY (published_version IS NOT NULL) DESC, created_at ASC, id ASC
         ) AS position
    FROM artifacts
   WHERE archived = false
     AND type IN ('brand', 'business_context', 'conversion_map', 'delivery_policy', 'purposes', 'tracking_plan')
)
UPDATE artifacts a
   SET archived = true,
       name = a.name || ' (archived duplicate ' || a.id || ')',
       updated_at = now()
  FROM ranked r
 WHERE a.workspace_id = r.workspace_id
   AND a.id = r.id
   AND r.position > 1;

ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;

-- Must match SINGLETON_TYPES in packages/artifacts/src/types.ts. `singleton-index.test.ts` reads
-- this predicate from pg_index and fails if the two drift.
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_singleton_type
  ON artifacts (workspace_id, type)
  WHERE archived = false
    AND type IN ('brand', 'business_context', 'conversion_map', 'delivery_policy', 'purposes', 'tracking_plan');
