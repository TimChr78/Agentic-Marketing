-- 0.17.7 (#1194): a restore fence that no backup can carry away.
--
-- `am restore` writes this row before `pg_restore` replaces Postgres and deletes it only after the
-- restored erasure ledger is confirmed visible in ClickHouse. A server that finds the row refuses
-- to start, so a restore interrupted between the two stores fails closed instead of serving a
-- person whose completed erasure is missing from `erased_subjects`.
--
-- The dump excludes this table (`pg_dump --exclude-table=public.restore_fence`), so
-- `pg_restore --clean` never drops it: it is not one of the objects the archive knows about. The
-- restore also creates it idempotently, which covers a fresh target that has not run migrations.
CREATE TABLE IF NOT EXISTS public.restore_fence (
  id integer PRIMARY KEY CHECK (id = 1),
  started_at timestamptz NOT NULL,
  backup text NOT NULL
);

REVOKE ALL ON public.restore_fence FROM PUBLIC;
