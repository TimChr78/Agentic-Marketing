import { createServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createTcpServer, type Server as TcpServer } from 'node:net';
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

// The failure-path tests above prove the text is clean. These capture servers prove the credential
// still authenticates the outgoing request after it moved out of the URL (#931 round 3).

interface HttpCapture {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

function startHttpCapture(): Promise<{ server: Server; base: string; requests: HttpCapture[] }> {
  const requests: HttpCapture[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Ok.');
    });
  });
  return new Promise((ready) =>
    server.listen(0, '127.0.0.1', () => ready({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests })),
  );
}

/** Minimal RESP server: records AUTH/PING and answers PONG/OK. */
function startValkeyCapture(): Promise<{ server: TcpServer; port: number; commands: string[][] }> {
  const commands: string[][] = [];
  const parse = (buffer: string): { args: string[]; consumed: number } | null => {
    if (!buffer.startsWith('*')) return null;
    const first = buffer.indexOf('\r\n');
    if (first < 0) return null;
    const count = Number(buffer.slice(1, first));
    let at = first + 2;
    const args: string[] = [];
    for (let i = 0; i < count; i += 1) {
      if (buffer[at] !== '$') return null;
      const end = buffer.indexOf('\r\n', at);
      if (end < 0) return null;
      const length = Number(buffer.slice(at + 1, end));
      const start = end + 2;
      if (buffer.length < start + length + 2) return null;
      args.push(buffer.slice(start, start + length));
      at = start + length + 2;
    }
    return { args, consumed: at };
  };
  const server = createTcpServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let parsed = parse(buffer); parsed; parsed = parse(buffer)) {
        buffer = buffer.slice(parsed.consumed);
        commands.push(parsed.args);
        socket.write(parsed.args[0]?.toLowerCase() === 'ping' ? '+PONG\r\n' : '+OK\r\n');
      }
    });
  });
  return new Promise((ready) =>
    server.listen(0, '127.0.0.1', () => ready({ server, port: (server.address() as AddressInfo).port, commands })),
  );
}

describe('credential-bearing clients still authenticate (#931 round 3)', () => {
  it('doctor ClickHouse sends the URL userinfo as Basic', async () => {
    const { server, base, requests } = await startHttpCapture();
    try {
      const url = base.replace('http://', 'http://alice:p%40ss@');
      const check = await checkClickHouse(config({ clickhouse: { url, database: 'am', rowPolicies: 'auto' } }));
      expect(check.status).toBe('ok');
      expect(requests.at(-1)!.url).toBe('/ping');
      expect(requests.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from('alice:p@ss').toString('base64')}`);
    } finally {
      server.close();
    }
  });

  it('doctor ClickHouse sends no Authorization without userinfo', async () => {
    const { server, base, requests } = await startHttpCapture();
    try {
      await checkClickHouse(config({ clickhouse: { url: base, database: 'am', rowPolicies: 'auto' } }));
      expect(requests.at(-1)!.headers.authorization).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('the egress check sends a provider base URL userinfo as Basic', async () => {
    const { server, base, requests } = await startHttpCapture();
    try {
      const apiBase = base.replace('http://', 'http://alice:p%40ss@') + '/api';
      const checks = await checkEgress([{ adapter: 'cloudflare', config: { apiBase } } as never]);
      expect(checks[0]!.status).toBe('ok');
      expect(requests.at(-1)!.url).toBe('/api');
      expect(requests.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from('alice:p@ss').toString('base64')}`);
    } finally {
      server.close();
    }
  });

  it('the doctor Valkey check still sends AUTH from the URL userinfo', async () => {
    const { server, port, commands } = await startValkeyCapture();
    try {
      const check = await checkValkey(config({ valkey: { url: `redis://alice:p%40ss@127.0.0.1:${port}`, prefix: 'am' } }));
      expect(check.status).toBe('ok');
      const auth = commands.find((command) => command[0]?.toLowerCase() === 'auth');
      expect(auth).toEqual(['auth', 'alice', 'p@ss']);
    } finally {
      server.close();
    }
  });

  it('the doctor Valkey check sends no AUTH without credentials', async () => {
    const { server, port, commands } = await startValkeyCapture();
    try {
      const check = await checkValkey(config({ valkey: { url: `redis://127.0.0.1:${port}`, prefix: 'am' } }));
      expect(check.status).toBe('ok');
      expect(commands.some((command) => command[0]?.toLowerCase() === 'auth')).toBe(false);
    } finally {
      server.close();
    }
  });
});
