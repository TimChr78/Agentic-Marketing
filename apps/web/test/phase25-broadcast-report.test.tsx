// The Phase 25 report test lives beside the feature (#500). The web Vitest project currently
// includes only `apps/web/test`, so this thin entry makes it part of `--project web` without
// changing the integration-owned test configuration. The integrator may fold the include instead.
import '../src/features/broadcasts/report/report.test';
