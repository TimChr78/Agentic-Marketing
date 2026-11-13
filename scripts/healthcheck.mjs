#!/usr/bin/env node
// The image HEALTHCHECK. Only the `api` and `ingest` roles start an HTTP listener
// (apps/server/src/main.ts), so a worker-only or scheduler-only container has no /readyz to reach.
// It is healthy while its process runs: Docker's restart policy covers a process that exits, and a
// probe could only report a listener that does not exist. The Helm chart guards its probes with the
// same role rule (#645); this is that rule in the image (#870).
//
// A listener role still probes /readyz, which reports 503 until migrations and seeding are done.

const roles = (process.env.ROLE || 'all')
  .split(',')
  .map((role) => role.trim())
  .filter(Boolean);

if (!roles.includes('all') && !roles.includes('api') && !roles.includes('ingest')) {
  console.log(`healthy: ROLE=${process.env.ROLE || 'all'} starts no HTTP listener`);
  process.exit(0);
}

const port = Number(process.env.PORT || 3000);
// Docker's --timeout=3s kills the probe; answer a little sooner so the container reports a failed
// healthcheck instead of a killed process. HEALTHCHECK_TIMEOUT_MS lets a test keep it short.
const timeout = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 2500);

fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(timeout) })
  .then((response) => process.exit(response.ok ? 0 : 1))
  .catch(() => process.exit(1));
