import { createHash } from 'node:crypto';
import { logger } from '@agentic-marketing/telemetry';
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager, RetentionPolicy, StorageType } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import type { BusEvent } from './schema';

// The event bus (ADR-0003): NATS JetStream, validated in spike 4. Events go to
// `events.<workspace>.<shard>`; the shard is a hash of the visitor so per-visitor order holds
// for consumers that read one shard sequentially.

export const SHARDS = 16;
const nanos = (ms: number) => ms * 1_000_000;

export const shardOf = (key: string) => createHash('md5').update(key).digest().readUInt32BE(0) % SHARDS;
export const subjectOf = (e: Pick<BusEvent, 'workspaceId' | 'anonymousId' | 'userId'>, namespace = 'events') =>
  `${namespace}.${e.workspaceId}.${shardOf(e.anonymousId || e.userId)}`;

export interface ConsumerOptions {
  /** Durable consumer name; one per worker kind (and shard). */
  name: string;
  /** Only events of this shard, for consumers that need per-visitor order. */
  shard?: number;
  /** Largest batch handed to the handler. */
  maxBatch?: number;
  /** How long a batch may take before JetStream re-delivers it. Keep handlers well inside it. */
  ackWaitMs?: number;
  /** Wait up to this long to fill a batch. */
  maxWaitMs?: number;
}

export interface EventBus {
  publish(events: BusEvent[]): Promise<{ accepted: number; duplicates: number }>;
  /**
   * Hands batches to `handler` until `signal` aborts. A batch is acknowledged when the handler
   * resolves and re-delivered when it throws: at-least-once, so handlers must be idempotent.
   */
  consume(opts: ConsumerOptions, handler: (events: BusEvent[]) => Promise<void>, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

/** Pause before fetching again after a failed pull; it grows with each failure in a row, up to a cap. */
const FETCH_RETRY_MS = 1_000;
const FETCH_RETRY_MAX_MS = 15_000;
/** Failed pulls in a row after which the worker gives up, so the process restarts and recreates it. */
export const MAX_FETCH_FAILURES = 20;

/** What to do about a failed pull (#307). */
export type FetchFailure = 'transient' | 'missing_consumer' | 'fatal';

/**
 * Transient errors (a missed heartbeat while the host is busy, a timeout, a dropped connection
 * that the client reconnects) are retried; a consumer that no longer exists (deleted, or the
 * stream was reset) is created again; a refused authorization or a permissions error is fatal,
 * so the worker stops and the process restarts with whatever fixed it.
 */
export function classifyFetchError(err: unknown): FetchFailure {
  const e = err as { message?: string; code?: string | number; api_error?: { err_code?: number } } | null;
  const text = `${e?.message ?? ''} ${e?.code ?? ''}`.toLowerCase();
  if (e?.api_error?.err_code === 10014 || text.includes('consumer not found') || text.includes('consumer deleted'))
    return 'missing_consumer';
  if (text.includes('authorization') || text.includes('permission') || text.includes('authentication')) return 'fatal';
  return 'transient';
}

/** The parts of a JetStream consumer the loop uses, so it can be tested with a fake. */
export interface PullConsumer {
  fetch(opts: { max_messages: number; expires: number }): Promise<AsyncIterable<FetchedMessage>>;
}
export interface FetchedMessage {
  data: Uint8Array;
  ack(): void;
  nak(delayMs?: number): void;
}

/**
 * Fetches batches and hands them to `handler` until `signal` aborts. A failed pull is classified
 * (#307): transient errors are retried with a growing pause, a missing consumer is recreated, and
 * a fatal error or too many failures in a row reject, so `startWorkers` reports the worker as
 * stopped and the process restarts instead of retrying silently forever.
 */
export async function consumeLoop(
  ensureConsumer: () => Promise<PullConsumer>,
  o: Pick<ConsumerOptions, 'name' | 'maxBatch' | 'maxWaitMs'>,
  decode: (data: Uint8Array) => BusEvent,
  handler: (events: BusEvent[]) => Promise<void>,
  signal: AbortSignal,
  opts: { retryMs?: number } = {},
): Promise<void> {
  let consumer = await ensureConsumer();
  let failures = 0;
  const maxBatch = o.maxBatch ?? 1000;
  while (!signal.aborted) {
    const msgs: FetchedMessage[] = [];
    const started = Date.now();
    // Always fetch at least once (the fetch itself waits up to a second for messages), then keep
    // filling the batch while there is time left.
    try {
      do {
        const batch = await consumer.fetch({ max_messages: maxBatch - msgs.length, expires: 1000 });
        for await (const m of batch) msgs.push(m);
      } while (msgs.length < maxBatch && Date.now() - started < (o.maxWaitMs ?? 1000) && !signal.aborted);
      failures = 0;
    } catch (err) {
      failures++;
      const kind = classifyFetchError(err);
      if (kind === 'fatal' || failures >= MAX_FETCH_FAILURES) {
        logger.error({ err, consumer: o.name, failures }, 'event fetch keeps failing; stopping the worker');
        throw err;
      }
      logger.warn({ err, consumer: o.name, fetched: msgs.length, failures, kind }, 'event fetch failed; retrying');
      if (kind === 'missing_consumer') consumer = await ensureConsumer().catch(() => consumer);
      // What was fetched before the error is still handled; anything not acked is re-delivered.
      if (!msgs.length) {
        await new Promise((r) => setTimeout(r, Math.min((opts.retryMs ?? FETCH_RETRY_MS) * failures, FETCH_RETRY_MAX_MS)));
        continue;
      }
    }
    if (!msgs.length) continue;
    try {
      await handler(msgs.map((m) => decode(m.data)));
      for (const m of msgs) m.ack();
    } catch (err) {
      logger.error({ err, consumer: o.name, events: msgs.length }, 'event handler failed; batch will be re-delivered');
      for (const m of msgs) m.nak(2_000);
    }
  }
}

/** `namespace` names the stream and its subjects, so several installs (or test runs) can share a NATS server. */
/**
 * The event bus on NATS JetStream. Events carry personal traits until the profile workers seal
 * them, so the stream keeps them only as long as a worker outage could last (`retentionHours`,
 * default 24); put the JetStream store on an encrypted volume.
 */
export async function natsBus(opts: { url: string; namespace?: string; retentionHours?: number }): Promise<EventBus> {
  const ns = opts.namespace ?? 'events';
  const STREAM = ns.toUpperCase();
  const nc: NatsConnection = await connect({ servers: opts.url, name: 'agentic-marketing' });
  const jsm = await jetstreamManager(nc);
  const config = {
    name: STREAM,
    subjects: [`${ns}.>`],
    storage: StorageType.File,
    retention: RetentionPolicy.Limits,
    max_age: nanos((opts.retentionHours ?? 24) * 3_600_000),
    // SDK retries within this window are dropped by JetStream (msgID = messageId).
    duplicate_window: nanos(120_000),
  };
  try {
    await jsm.streams.info(STREAM);
    await jsm.streams.update(STREAM, config);
  } catch {
    await jsm.streams.add(config);
  }
  const js = jetstream(nc);
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  return {
    async publish(events) {
      const acks = await Promise.all(
        events.map((e) => js.publish(subjectOf(e, ns), enc.encode(JSON.stringify(e)), { msgID: `${e.workspaceId}:${e.messageId}` })),
      );
      return { accepted: acks.length, duplicates: acks.filter((a) => a.duplicate).length };
    },

    async consume(o, handler, signal) {
      const filter = o.shard === undefined ? `${ns}.>` : `${ns}.*.${o.shard}`;
      const consumerConfig = {
        durable_name: o.name,
        filter_subject: filter,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: nanos(o.ackWaitMs ?? 5_000),
        max_ack_pending: (o.maxBatch ?? 1000) * 2,
      };
      // Creates the durable consumer, or updates it to this config, and returns a handle to it.
      const ensureConsumer = async () => {
        try {
          await jsm.consumers.info(STREAM, o.name);
          await jsm.consumers.update(STREAM, o.name, consumerConfig);
        } catch {
          await jsm.consumers.add(STREAM, consumerConfig);
        }
        return js.consumers.get(STREAM, o.name);
      };
      await consumeLoop(ensureConsumer, o, (data) => JSON.parse(dec.decode(data)) as BusEvent, handler, signal);
    },

    async close() {
      await nc.drain();
    },
  };
}

/** A bus that connects on first use, so processes that never touch events (the CLI) need no NATS. */
export function lazyNatsBus(opts: Parameters<typeof natsBus>[0]): EventBus {
  let bus: Promise<EventBus> | undefined;
  const get = () => {
    bus ??= natsBus(opts);
    return bus;
  };
  return {
    publish: async (events) => (await get()).publish(events),
    consume: async (o, handler, signal) => (await get()).consume(o, handler, signal),
    close: async () => {
      if (bus) await (await bus).close();
    },
  };
}

/** Deletes a namespace's stream and consumers (tests, and resetting a development install). */
export async function resetNatsNamespace(url: string, namespace: string) {
  const nc = await connect({ servers: url });
  await (await jetstreamManager(nc)).streams.delete(namespace.toUpperCase()).catch(() => {});
  await nc.close();
}
