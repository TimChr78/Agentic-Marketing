import { migrateClickHouse } from '@agentic-marketing/events';
import { openbaoKeyProvider } from '@agentic-marketing/secrets';
import { logger } from '@agentic-marketing/telemetry';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config';
import { checkClickHouse, checkEgress, checkNats, checkValkey } from '../src/ops/checks';

// #931 review (A3/A4): a configured URL can carry userinfo or a query token. Clients that fetch it
// move the credentials into a header, and a failure is reported as origin + cause code, so neither
// a thrown error, a log line, a span event nor `am doctor` output contains the secret.

const USER = 'url-user';
const PASSWORD = 'secret-9137';
const TOKEN = 'abc-9137';
const AUTHORITY = `${USER}:${PASSWORD}`;
const OPENBAO = `http://${AUTHORITY}@127.0.0.1:9/bao?token=${TOKEN}`;
const CLICKHOUSE = `http://${AUTHORITY}@127.0.0.1:9/?token=${TOKEN}`;
const VALKEY = `redis://${AUTHORITY}@127.0.0.1:9/?token=${TOKEN}`;
const NATS = `nats://${AUTHORITY}@127.0.0.1:9`;
const EGRESS = `http://${AUTHORITY}@127.0.0.1:9/api?token=${TOKEN}`;

/** Messages and cause chain, without stack file paths (`packages/secrets` itself contains "secret"). */
function errorMessages(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; current && i < 10; i += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n');
}

function errorChain(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; current && i < 10; i += 1) {
    if (current instanceof Error) {
      parts.push(current.name, current.message, current.stack ?? '');
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join('\n');
}

/** The credential values themselves, which must never appear anywhere, paths included. */
function expectNoCredentials(text: string) {
  for (const needle of [PASSWORD, TOKEN, AUTHORITY, 'token=' + TOKEN]) expect(text).not.toContain(needle);
}

/** Doctor messages, JSON and logs have no file paths, so the bare words must be absent too. */
function expectClean(text: string) {
  for (const needle of [PASSWORD, TOKEN, AUTHORITY, 'secret', 'abc']) expect(text).not.toContain(needle);
}

const config = (part: Record<string, unknown>) => part as Config;

const cases: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: 'OPENBAO_ADDR',
    run: () => openbaoKeyProvider({ addr: OPENBAO, key: 'kek', token: 'root' }).wrap(Buffer.alloc(32)),
  },
  {
    name: 'CLICKHOUSE_URL (doctor)',
    run: () => checkClickHouse(config({ clickhouse: { url: CLICKHOUSE, database: 'am', rowPolicies: 'auto' } })),
  },
  {
    name: 'CLICKHOUSE_URL (runtime client)',
    run: () => migrateClickHouse(CLICKHOUSE, 'am'),
  },
  {
    name: 'VALKEY_URL (doctor)',
    run: () => checkValkey(config({ valkey: { url: VALKEY, prefix: 'am' } })),
  },
  {
    name: 'NATS_URL (doctor)',
    run: () => checkNats(config({ nats: { url: NATS } })),
  },
  {
    name: 'provider API base (doctor egress)',
    run: () => checkEgress([{ adapter: 'cloudflare', config: { apiBase: EGRESS } } as never]),
  },
];

describe('configured URL credentials stay out of errors, logs, spans and doctor output (A3/A4)', () => {
  const logs: string[] = [];
  const spies = (['info', 'warn', 'error', 'debug', 'trace'] as const).map((level) =>
    vi.spyOn(logger, level).mockImplementation(((first: unknown, second?: unknown) => {
      logs.push(JSON.stringify([first, second]));
    }) as never),
  );
  afterEach(() => {
    logs.length = 0;
    for (const spy of spies) spy.mockClear();
  });
  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it.each(cases)('$name never exposes the credential or query token', async ({ run }) => {
    let failure: unknown;
    let outcome: unknown;
    try {
      outcome = await run();
    } catch (err) {
      failure = err;
    }
    if (failure !== undefined) {
      expectNoCredentials(errorChain(failure));
      expectClean(errorMessages(failure));
      // The executor records the exception on the command span; recordException copies the same
      // message and stack, so this is the object the span receives.
      const recorded: unknown[] = [];
      const span = { recordException: (err: unknown) => recorded.push(err) };
      span.recordException(failure);
      expectNoCredentials(errorChain(recorded[0]));
      expectClean(errorMessages(recorded[0]));
    }
    // Doctor prints both the check object as JSON and its message/hint as a table row.
    expectClean(JSON.stringify(failure ?? outcome ?? ''));
    expectClean(logs.join('\n'));
  });

  it('doctor check output for ClickHouse has no credentials in JSON or table form', async () => {
    const check = await checkClickHouse(config({ clickhouse: { url: CLICKHOUSE, database: 'am', rowPolicies: 'auto' } }));
    expectClean(JSON.stringify(check));
    expectClean(`${check.message} ${check.hint ?? ''}`);
  });
});
