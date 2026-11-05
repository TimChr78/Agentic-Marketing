-- Brands and domains (#190): a person who owns a workspace may create another brand from the
-- admin UI. A brand is a workspace, so the row is created with the same database defaults as
-- `am bootstrap` (approval policy, time zone, seed list, autonomy); the command writes the
-- owner membership, a draft brand artifact and a pending primary domain in one transaction.
--
-- The app role could read and update workspaces but never insert one. Granting INSERT keeps the
-- create in the caller's transaction (RLS still requires app.workspace_id to match the new id),
-- rather than opening a second connection where a failure could leave a half-created brand.
GRANT INSERT ON workspaces TO am_app;
