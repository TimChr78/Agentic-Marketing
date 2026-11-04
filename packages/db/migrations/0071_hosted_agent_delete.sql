-- agents.deleteHosted (#362) deletes the agent and cascades its hosted configuration/history.
-- The original agents grant allowed only SELECT/INSERT/UPDATE, so the command failed with a
-- permission error even after its live-claim check passed. Command authorization still requires
-- a person with workspace:admin; existing FORCE RLS keeps this DELETE workspace-scoped.
GRANT DELETE ON agents TO am_app;
