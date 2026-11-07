import { testPortOffset } from '../packages/db/test/run';

// One source of truth for the seeded e2e server's addresses: Playwright's configs, the helpers and
// the server itself all import this module, so TEST_PORT_OFFSET moves the API, the fixtures port
// and every default URL together. E2E_PORT still wins when a caller names a port explicitly.

export interface E2EPorts {
  /** The seeded server's port (the API and the built UI). */
  port: number;
  /** Where the browser and Playwright point, e.g. http://localhost:3100. */
  base: string;
  /** The test-only fixtures port (links, /ready) is always the next port. */
  fixturesPort: number;
  /** Fixtures origin; E2E_FIXTURES overrides it for a server started elsewhere. */
  fixturesBase: string;
}

export function portsFor(env: Record<string, string | undefined> = process.env): E2EPorts {
  // An explicit E2E_BASE names an already-running server; its port decides the fixtures port, as
  // it did before the offset existed. E2E_PORT still wins when both are set.
  const basePort = env.E2E_BASE ? Number(new URL(env.E2E_BASE).port || 80) : null;
  const port = Number(env.E2E_PORT ?? basePort ?? 3100 + testPortOffset(env));
  const fixturesPort = port + 1;
  return {
    port,
    base: env.E2E_BASE ?? `http://localhost:${port}`,
    fixturesPort,
    fixturesBase: env.E2E_FIXTURES ?? `http://127.0.0.1:${fixturesPort}`,
  };
}

export const { port: e2ePort, base: e2eBase, fixturesPort: e2eFixturesPort, fixturesBase: e2eFixturesBase } = portsFor();
