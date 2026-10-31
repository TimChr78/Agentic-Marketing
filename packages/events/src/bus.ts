import { createHash } from 'node:crypto';
import { logger } from '@agentic-marketing/telemetry';
import { AckPolicy, DeliverPolicy, type JsMsg, jetstream, jetstreamManager, RetentionPolicy, StorageType } from '@nats-io/jetstream';
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

/** Pause before fetching again after a failed pull. */
const FETCH_RETRY_MS = 1_000;

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
      try {
        await jsm.consumers.info(STREAM, o.name);
        await jsm.consumers.update(STREAM, o.name, consumerConfig);
      } catch {
        await jsm.consumers.add(STREAM, consumerConfig);
      }
      const consumer = await js.consumers.get(STREAM, o.name);
      while (!signal.aborted) {
        const msgs: JsMsg[] = [];
        const started = Date.now();
        // Always fetch at least once (the fetch itself waits up to a second for messages), then keep
        // filling the batch while there is time left.
        try {
          do {
            const batch = await consumer.fetch({ max_messages: (o.maxBatch ?? 1000) - msgs.length, expires: 1000 });
            for await (const m of batch) msgs.push(m);
          } while (msgs.length < (o.maxBatch ?? 1000) && Date.now() - started < (o.maxWaitMs ?? 1000) && !signal.aborted);
        } catch (err) {
          // A pull can fail without the server being gone, e.g. "heartbeats missed" while the host
          // is busy. Keep consuming: what was fetched is handled below, anything not acked is
          // re-delivered, so a transient error never stops the worker.
          logger.warn({ err, consumer: o.name, fetched: msgs.length }, 'event fetch failed; retrying');
          if (!msgs.length) {
            await new Promise((r) => setTimeout(r, FETCH_RETRY_MS));
            continue;
          }
        }
        if (!msgs.length) continue;
        try {
          await handler(msgs.map((m) => JSON.parse(dec.decode(m.data)) as BusEvent));
          for (const m of msgs) m.ack();
        } catch (err) {
          logger.error({ err, consumer: o.name, events: msgs.length }, 'event handler failed; batch will be re-delivered');
          for (const m of msgs) m.nak(2_000);
        }
      }
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
