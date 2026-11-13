import { afterEach, describe, expect, it, vi } from 'vitest';

// The logger is created at import time, so each case needs a fresh module registry. Compose and
// Kubernetes pass unset variables as empty strings; an empty string is not a pino level.
const original = process.env.LOG_LEVEL;
const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

afterEach(() => {
  vi.resetModules();
  if (original === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = original;
  if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEndpoint;
});

async function levelFor(value: string | undefined): Promise<string> {
  vi.resetModules();
  if (value === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = value;
  const { logger } = await import('../src/index');
  return logger.level;
}

describe('telemetry log level', () => {
  it('falls back to info when LOG_LEVEL is unset, empty or whitespace', async () => {
    expect(await levelFor(undefined)).toBe('info');
    expect(await levelFor('')).toBe('info');
    expect(await levelFor('   ')).toBe('info');
  });

  it('keeps an explicit level', async () => {
    expect(await levelFor('debug')).toBe('debug');
  });
});

describe('the public URL in the logs (0.14.11 round 4)', () => {
  it('keeps the origin and path, and drops the userinfo and the query', async () => {
    const { endpointLocation } = await import('../src/index');
    expect(endpointLocation('https://user:pw@app.example.com/base?token=x#frag')).toBe('https://app.example.com/base');
    expect(endpointLocation('https://app.example.com')).toBe('https://app.example.com');
    expect(endpointLocation('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  it('says plainly when the public URL is not a URL', async () => {
    const { endpointLocation } = await import('../src/index');
    expect(endpointLocation('app.example.com')).toBe('(invalid URL)');
  });
});

describe('the OTLP endpoint in the logs (#808)', () => {
  it('drops the user, the path and the query from the endpoint', async () => {
    vi.resetModules();
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'https://user:pw@otel.example:4318/v1/traces?token=x';
    const { endpointOrigin, initTelemetry, logger, shutdownTelemetry } = await import('../src/index');
    expect(endpointOrigin('https://user:pw@otel.example:4318/v1/traces?token=x')).toBe('https://otel.example:4318');

    const logged = vi.spyOn(logger, 'info');
    try {
      initTelemetry('test');
      expect(logged).toHaveBeenCalledWith({ endpoint: 'https://otel.example:4318' }, 'OpenTelemetry tracing enabled');
    } finally {
      await shutdownTelemetry();
    }
  });

  it('says plainly when the endpoint is not a URL', async () => {
    vi.resetModules();
    const { endpointOrigin } = await import('../src/index');
    expect(endpointOrigin('otel.example:4318')).toBe('(invalid URL)');
  });
});
