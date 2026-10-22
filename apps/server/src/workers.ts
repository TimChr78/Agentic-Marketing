import { runSink } from '@agentic-marketing/events';
import { runProfileWorkers } from '@agentic-marketing/profiles';
import { logger } from '@agentic-marketing/telemetry';
import type { createServer } from './app';

/** Event consumers of the worker role. Each runs until `signal` aborts. */
export function startWorkers(srv: ReturnType<typeof createServer>, signal: AbortSignal): Promise<void>[] {
  const run = (name: string, p: Promise<void>) =>
    p.catch((err) => {
      logger.error({ err, worker: name }, 'worker stopped');
      throw err;
    });
  logger.info('worker role: ClickHouse sink, profile workers');
  return [
    run('clickhouse-sink', runSink(srv.bus, srv.events, signal)),
    ...runProfileWorkers({ bus: srv.bus, db: srv.db, kp: srv.keyProvider }, signal).map((p, i) => run(`profiles-${i}`, p)),
  ];
}
