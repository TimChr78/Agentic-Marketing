import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Never log credentials, even by accident.
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.apiKey', '*.value'],
});

let sdk: NodeSDK | undefined;

/**
 * Start OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise the API stays a no-op.
 * Works with any OTLP backend (Grafana Tempo, SigNoz, Jaeger, …).
 */
export function initTelemetry(serviceName: string) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || sdk) return;
  sdk = new NodeSDK({ serviceName, traceExporter: new OTLPTraceExporter() });
  sdk.start();
  logger.info({ endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }, 'OpenTelemetry tracing enabled');
}

export async function shutdownTelemetry() {
  await sdk?.shutdown();
}
