import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import pino from 'pino';

export const logger = pino({
  // Compose and Kubernetes pass unset variables as empty strings; an empty level is not a pino
  // level, so fall back to info exactly as for an absent variable.
  level: process.env.LOG_LEVEL?.trim() || 'info',
  // Never log credentials, even by accident.
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.apiKey', '*.value'],
});

let sdk: NodeSDK | undefined;

/**
 * The scheme, host and port of a URL, for logs (#808). An OTLP endpoint may carry credentials in
 * the userinfo or a token in the query string; neither may reach the logs. Anything that is not a
 * URL is reported as such instead of echoed.
 */
export function endpointOrigin(endpoint: string): string {
  try {
    // Something like `otel.example:4318` parses as a scheme with no host, whose origin is "null".
    const origin = new URL(endpoint).origin;
    return origin === 'null' ? '(invalid URL)' : origin;
  } catch {
    return '(invalid URL)';
  }
}

/**
 * A URL as it may go into a log: the origin and the path, without userinfo, query string or
 * fragment (0.14.11 round 4). A configured public URL can carry credentials or a token in its
 * query, and neither may reach the startup logs. The trailing slash of the root path is dropped so
 * `https://app.example.com/` reads as its origin. Anything that is not a URL is reported as such.
 */
export function endpointLocation(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.origin === 'null') return '(invalid URL)';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '(invalid URL)';
  }
}

/**
 * A configured URL with its userinfo moved into an `Authorization: Basic …` header. Node's fetch
 * rejects a URL that carries credentials, and the rejection's text includes the
 * full URL; clients built from `OPENBAO_ADDR`, `CLICKHOUSE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT` and
 * similar values therefore fetch the credential-free URL and send the header instead. The query
 * string stays: it is part of the address, not a credential.
 */
export function splitUrlCredentials(endpoint: string): { url: string; headers: Record<string, string> } {
  const url = new URL(endpoint);
  const headers: Record<string, string> = {};
  if (url.username || url.password) {
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  return { url: url.toString(), headers };
}

/**
 * A failure from a client built from a configured URL, safe to log, return or record on a span.
 * Only the endpoint's origin and the cause's code (or the error's name) are kept: no message, so
 * userinfo, a query token or a thrown URL cannot reach a log line or `span.recordException`.
 */
export function endpointFailure(err: unknown, endpoint: string): string {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  const name = err instanceof Error ? err.name : 'Error';
  return `${endpointOrigin(endpoint)} (${code ?? name})`;
}

/**
 * Start OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise the API stays a no-op.
 * Works with any OTLP backend (Grafana Tempo, SigNoz, Jaeger, …).
 */
export function initTelemetry(serviceName: string) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || sdk) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  // A URL with userinfo is rejected by fetch and the error repeats it; send the credentials as a
  // header instead, keeping any headers the operator configured in OTEL_EXPORTER_OTLP_HEADERS.
  const { url, headers } = splitUrlCredentials(endpoint);
  const configured = Object.fromEntries(
    (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '')
      .split(',')
      .map((pair) => pair.split('='))
      .filter((pair) => pair.length === 2 && pair[0].trim())
      .map(([key, value]) => [key.trim(), value.trim()]),
  );
  const exporterHeaders = { ...configured, ...headers };
  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(Object.keys(exporterHeaders).length ? { url, headers: exporterHeaders } : { url }),
  });
  sdk.start();
  logger.info({ endpoint: endpointOrigin(endpoint) }, 'OpenTelemetry tracing enabled');
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
}
