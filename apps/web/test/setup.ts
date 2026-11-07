import { configure } from '@testing-library/react';

// The web tests share the host with the server suite (in CI and locally), and under that load a
// lazy chunk or a chained read can take longer than Testing Library's one-second default. The
// waits still end as soon as their condition holds; only a genuinely stuck UI waits the full five
// seconds. Four separate tests flaked on the default before this (Phase 25/26).
configure({ asyncUtilTimeout: 5_000 });
