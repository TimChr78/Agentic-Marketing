import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// #931 review round 3 (A2/A3): the real OTLP HTTP exporter, against a local capture server. When
// no endpoint variable carries userinfo the SDK must resolve the endpoint and headers exactly as
// before; only a credential-bearing endpoint is passed explicitly, without userinfo.

const requests: { url: string; headers: Record<string, string | string[] | undefined> }[] = [];
const ENV_KEYS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let server: Server;
let base = '';
const basic = (value: string) => `Basic ${Buffer.from(value).toString('base64')}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  requests.length = 0;
});

/** One real export through a freshly imported telemetry module, flushed by shutdown. */
async function exportOnce(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  requests.length = 0;
  const { trace } = await import('@opentelemetry/api');
  trace.disable();
  const { initTelemetry, shutdownTelemetry } = await import('../src/index');
  initTelemetry('test');
  const span = trace.getTracer('capture').startSpan('capture');
  span.end();
  await shutdownTelemetry();
  trace.disable();
  return requests;
}

describe('the real OTLP exporter (#931 A2/A3)', () => {
  it('keeps the SDK endpoint resolution: generic endpoint plus /v1/traces', async () => {
    const sent = await exportOnce({ OTEL_EXPORTER_OTLP_ENDPOINT: base });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('/v1/traces');
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  it('keeps slash handling and a generic endpoint path', async () => {
    const sent = await exportOnce({ OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/collect/` });
    expect(sent[0]!.url).toBe('/collect/v1/traces');
  });

  it('uses the trace-specific endpoint as-is', async () => {
    const sent = await exportOnce({ OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/ignored`, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/custom` });
    expect(sent[0]!.url).toBe('/custom');
  });

  it('lets the SDK decode percent-encoded env headers', async () => {
    const sent = await exportOnce({
      OTEL_EXPORTER_OTLP_ENDPOINT: base,
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic%20YWxpY2U6cGFzcw%3D%3D',
    });
    expect(sent[0]!.headers.authorization).toBe('Basic YWxpY2U6cGFzcw==');
  });

  it('moves userinfo from the generic endpoint into a Basic header without touching the path', async () => {
    const sent = await exportOnce({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://alice:p%40ss@${new URL(base).host}` });
    expect(sent[0]!.url).toBe('/v1/traces');
    expect(sent[0]!.headers.authorization).toBe(basic('alice:p@ss'));
    expect(sent[0]!.headers.host).toBe(new URL(base).host);
  });

  it('moves userinfo from a trace-specific endpoint and keeps its path', async () => {
    const sent = await exportOnce({
      OTEL_EXPORTER_OTLP_ENDPOINT: `${base}/ignored`,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://alice:p%40ss@${new URL(base).host}/custom`,
    });
    expect(sent[0]!.url).toBe('/custom');
    expect(sent[0]!.headers.authorization).toBe(basic('alice:p@ss'));
  });

  it('lets an env Authorization win over URL userinfo', async () => {
    const sent = await exportOnce({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://alice:p%40ss@${new URL(base).host}`,
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20env-token',
    });
    expect(sent[0]!.headers.authorization).toBe('Bearer env-token');
  });

  it('lets a trace-specific env Authorization win too', async () => {
    const sent = await exportOnce({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://alice:p%40ss@${new URL(base).host}`,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer%20trace-token',
    });
    expect(sent[0]!.headers.authorization).toBe('Bearer trace-token');
  });

  // Round 3: the SDK percent-decodes header names, so `%61uthorization` is Authorization too.
  it('lets an env Authorization with a percent-encoded name win over URL userinfo', async () => {
    const sent = await exportOnce({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://alice:p%40ss@${new URL(base).host}`,
      OTEL_EXPORTER_OTLP_HEADERS: '%61uthorization=Bearer%20env-token',
    });
    expect(sent[0]!.headers.authorization).toBe('Bearer env-token');
  });

  it('lets a trace-specific env Authorization with a percent-encoded name win too', async () => {
    const sent = await exportOnce({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://alice:p%40ss@${new URL(base).host}`,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: '%41uthorization=Bearer%20trace-token',
    });
    expect(sent[0]!.headers.authorization).toBe('Bearer trace-token');
  });
});
