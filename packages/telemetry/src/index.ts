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
 * Start OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise the API stays a no-op.
 * Works with any OTLP backend (Grafana Tempo, SigNoz, Jaeger, …).
 */
export function initTelemetry(serviceName: string) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || sdk) return;
  sdk = new NodeSDK({ serviceName, traceExporter: new OTLPTraceExporter() });
  sdk.start();
  logger.info({ endpoint: endpointOrigin(process.env.OTEL_EXPORTER_OTLP_ENDPOINT) }, 'OpenTelemetry tracing enabled');
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
}
