import { describe, expect, it } from 'vitest';
import { portsFor } from '../../../e2e/ports';

// The e2e server, Playwright's configs and the specs must agree on one port calculation, or
// TEST_PORT_OFFSET moves only some of them and a second checkout collides (#515 review).

describe('e2e ports', () => {
  it('keeps the historical defaults when no offset is set', () => {
    expect(portsFor({})).toEqual({
      port: 3100,
      base: 'http://localhost:3100',
      fixturesPort: 3101,
      fixturesBase: 'http://127.0.0.1:3101',
    });
  });

  it('moves the server and the fixtures port together with TEST_PORT_OFFSET', () => {
    expect(portsFor({ TEST_PORT_OFFSET: '1000' })).toEqual({
      port: 4100,
      base: 'http://localhost:4100',
      fixturesPort: 4101,
      fixturesBase: 'http://127.0.0.1:4101',
    });
  });

  it('lets E2E_PORT name the port explicitly, ignoring the offset', () => {
    expect(portsFor({ E2E_PORT: '3120', TEST_PORT_OFFSET: '1000' })).toMatchObject({
      port: 3120,
      base: 'http://localhost:3120',
      fixturesPort: 3121,
    });
  });

  it('keeps E2E_BASE and E2E_FIXTURES overrides, while the fixtures bind stays next to the port', () => {
    expect(portsFor({ E2E_BASE: 'http://localhost:5173', E2E_FIXTURES: 'http://127.0.0.1:9001', TEST_PORT_OFFSET: '1000' })).toEqual({
      port: 5173,
      base: 'http://localhost:5173',
      fixturesPort: 5174,
      fixturesBase: 'http://127.0.0.1:9001',
    });
  });

  it('takes the port from an explicit E2E_BASE, so the fixtures port follows it', () => {
    expect(portsFor({ E2E_BASE: 'http://localhost:9000' })).toMatchObject({
      port: 9000,
      fixturesPort: 9001,
      fixturesBase: 'http://127.0.0.1:9001',
    });
  });
});
