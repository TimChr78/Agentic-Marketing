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
 *
 * The SDK resolves the endpoint (generic + /v1/traces, or the trace-specific variable as-is) and its
 * own environment headers. That stays untouched unless an effective endpoint carries userinfo: only
 * then is the URL passed explicitly, without userinfo, with the URL-derived Basic header unless an
 * Authorization is already configured in OTEL_EXPORTER_OTLP[_TRACES]_HEADERS (that wins).
 */
export function initTelemetry(serviceName: string) {
  const generic = nonEmpty(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!generic || sdk) return;
  const specific = nonEmpty(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const effective = specific ?? generic;
  if (!hasUrlCredentials(effective)) {
    // Exactly as before: the exporter reads the environment itself.
    sdk = new NodeSDK({ serviceName, traceExporter: new OTLPTraceExporter() });
  } else {
    const { url, headers } = splitUrlCredentials(tracesEndpointUrl(specific, generic));
    const urlAuth = headers.authorization;
    sdk = new NodeSDK({
      serviceName,
      traceExporter: new OTLPTraceExporter(urlAuth && !envHasAuthorization() ? { url, headers: { authorization: urlAuth } } : { url }),
    });
  }
  sdk.start();
  logger.info({ endpoint: endpointOrigin(effective) }, 'OpenTelemetry tracing enabled');
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function hasUrlCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

/** The tracer exporter's own endpoint rules: trace-specific as-is, else generic + /v1/traces. */
function tracesEndpointUrl(specific: string | undefined, generic: string): string {
  if (specific) return new URL(specific).toString();
  return new URL(`${generic.endsWith('/') ? generic : `${generic}/`}v1/traces`).toString();
}

/** Whether OTEL_EXPORTER_OTLP[_TRACES]_HEADERS already sets Authorization (decoded, case-insensitive). */
function envHasAuthorization(): boolean {
  const names = [process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS, process.env.OTEL_EXPORTER_OTLP_HEADERS]
    .flatMap((raw) => (raw ?? '').split(','))
    .map((pair) => decodedHeaderName(pair.split('=')[0] ?? ''))
    .filter(Boolean);
  return names.includes('authorization');
}

/** A header name as the SDK reads it: percent-decoded (`%61uthorization`), trimmed, lower-cased. */
function decodedHeaderName(raw: string): string {
  const name = raw.trim();
  try {
    return decodeURIComponent(name).trim().toLowerCase();
  } catch {
    return name.toLowerCase();
  }
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
}
