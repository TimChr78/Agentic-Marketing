-- Phase 15 (issue #100): a public newsletter archive lives at /n/<slug>/ on the links host, which
-- all workspaces of an install share, so slugs must be unique across workspaces. A command's
-- transaction sees only its own workspace (row-level security); this function answers the one
-- question publishing a brand needs, without giving the app role any read on other tenants. It
-- runs as the migration role: tenant tables FORCE row-level security, so it sees other workspaces
-- only when that role bypasses it (a superuser, as with Compose, or BYPASSRLS); otherwise the check
-- passes and two workspaces could share a slug (no data leaks; one archive shadows the other).
CREATE FUNCTION archive_slug_taken(p_slug text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM artifacts a
    JOIN artifact_versions v ON v.workspace_id = a.workspace_id AND v.artifact_id = a.id AND v.number = a.published_version
    WHERE a.type = 'brand' AND a.archived = false
      AND a.workspace_id IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid
      AND (v.content -> 'archive' ->> 'enabled')::boolean IS TRUE
      AND v.content -> 'archive' ->> 'slug' = p_slug
  )
$$;
REVOKE ALL ON FUNCTION archive_slug_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_slug_taken(text) TO am_app;
