import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The web tests share the host with the server suite (in CI and locally), and under that load a
// lazy chunk or a chained read can take longer than Testing Library's one-second default. The
// waits still end as soon as their condition holds; only a genuinely stuck UI waits the full five
// seconds. Four separate tests flaked on the default before this (Phase 25/26).
configure({ asyncUtilTimeout: 5_000 });

// Vitest runs without globals, so Testing Library cannot register its own cleanup. Unmount after
// every test here, once: a test file that forgets would otherwise leave timers (the skeleton reveal,
// polling) firing after the environment is torn down ("window is not defined", #564).
afterEach(cleanup);
