-- Issue #324: pin the journey and segment versions an enrollment job started with.
--
-- A bulk enrollment is a deliberate audience operation, so it must not follow a republish or an
-- archive mid-flight: the job records the published versions it started with and stops with a
-- reason if either changes. Existing jobs have no pinned versions: they keep today's behaviour and
-- pin on their next chunk.
ALTER TABLE enrollment_jobs
  ADD COLUMN journey_version integer,
  ADD COLUMN segment_version integer;
