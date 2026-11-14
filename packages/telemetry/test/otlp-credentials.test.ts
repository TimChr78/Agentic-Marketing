import { afterEach, describe, expect, it, vi } from 'vitest';

// #931 review A3: OTEL_EXPORTER_OTLP_ENDPOINT may carry userinfo. The exporter is built from the
// credential-free URL, with the credentials in an Authorization header, so its own errors cannot
// repeat the secret. The exporter is mocked so the test sees exactly what initTelemetry passes.

const captured = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor(options: unknown) {
      captured.options.push(options);
    }
    export(_spans: unknown, callback: (result: { code: number }) => void) {
      callback({ code: 0 });
    }
    shutdown() {
      return Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const originalHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;

afterEach(() => {
  vi.resetModules();
  captured.options.length = 0;
  if (original === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
  if (originalHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  else process.env.OTEL_EXPORTER_OTLP_HEADERS = originalHeaders;
});

describe('the OTLP endpoint credentials (#931 A3)', () => {
  it('sends userinfo as a header and keeps the credential-free URL', async () => {
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://user:secret@otel.example:4318/v1/traces?token=abc';
    const { initTelemetry, shutdownTelemetry } = await import('../src/index');
    initTelemetry('test');
    expect(captured.options[0]).toEqual({
      url: 'http://otel.example:4318/v1/traces?token=abc',
      headers: { authorization: `Basic ${Buffer.from('user:secret').toString('base64')}` },
    });
    await shutdownTelemetry();
  });

  it('keeps the headers configured in OTEL_EXPORTER_OTLP_HEADERS', async () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-api-key=otel-key';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://user:secret@otel.example:4318/v1/traces';
    const { initTelemetry, shutdownTelemetry } = await import('../src/index');
    initTelemetry('test');
    expect(captured.options[0]).toMatchObject({ headers: { 'x-api-key': 'otel-key' } });
    await shutdownTelemetry();
  });
});
