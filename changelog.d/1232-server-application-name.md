---
section: Fixed
issues: [1232]
---
- The server's own connection pools announce their `application_name` even when `DATABASE_URL`
  carries a `?application_name=`, so `am restore` sees a running app's connections and refuses to
  replace the database under it.
