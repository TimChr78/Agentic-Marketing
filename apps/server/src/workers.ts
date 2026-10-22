import { runSink } from '@agentic-marketing/events';
import { logger } from '@agentic-marketing/telemetry';
import type { createServer } from './app';

/** Event consumers of the worker role. Each runs until `signal` aborts. */
export function startWorkers(srv: ReturnType<typeof createServer>, signal: AbortSignal): Promise<void>[] {
  const run = (name: string, p: Promise<void>) =>
    p.catch((err) => {
      logger.error({ err, worker: name }, 'worker stopped');
      throw err;
    });
  logger.info('worker role: ClickHouse sink');
  return [run('clickhouse-sink', runSink(srv.bus, srv.events, signal))];
}
