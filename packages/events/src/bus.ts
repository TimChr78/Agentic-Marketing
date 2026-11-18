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
  /** How long one pull waits on the server for messages (default 1 s). */
  pullExpiresMs?: number;
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

/**
 * One pull's messages. The pinned client returns its iterator immediately and waits for messages
 * inside it, so a shutdown ends the wait by stopping the batch, not by racing the fetch: `stop`
 * and `close` are what its queued iterator provides (#1028 review).
 */
export interface MessageBatch extends AsyncIterable<FetchedMessage> {
  /** Ends the iteration; the pinned JetStream client's `ConsumerMessages` provides it. */
  stop?: (err?: Error) => void;
  /** Some iterators only expose an async close. */
  close?: () => Promise<unknown> | unknown;
}

/** The parts of a JetStream consumer the loop uses, so it can be tested with a fake. */
export interface PullConsumer {
  fetch(opts: { max_messages: number; expires: number }): Promise<MessageBatch>;
}
export interface FetchedMessage {
  data: Uint8Array;
  ack(): void;
  nak(delayMs?: number): void;
}

/**
 * The pull, or null when `signal` aborts first. A consumer whose connection is reconnecting can
 * leave `fetch` waiting for a server that is not there yet, so a worker that is shutting down must
 * not be held by it (#1028); whatever was pulled before the abort is still handled.
 */
async function fetchOrAbort(
  consumer: PullConsumer,
  opts: { max_messages: number; expires: number },
  signal: AbortSignal,
): Promise<MessageBatch | null> {
  if (signal.aborted) return null;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([consumer.fetch(opts), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Ends a batch that is mid-iteration. Its unacked messages are redelivered by JetStream after the
 * ack wait, which is the same at-least-once contract as a crash (#1028 review).
 */
function stopBatch(batch: MessageBatch): void {
  try {
    if (batch.stop) batch.stop();
    else if (batch.close) void Promise.resolve(batch.close()).catch(() => {});
  } catch {
    // An iterator that is already closed has nothing left to stop.
  }
}

/**
 * The messages of one fetched batch, until it ends or `signal` aborts. The wait for messages lives
 * inside the iterator, not in `fetch()`, so stopping the batch is what releases it: a consumer on a
 * connection that is reconnecting would otherwise keep a shutdown waiting (#1028 review).
 */
async function* messagesOrAbort(batch: MessageBatch, signal: AbortSignal): AsyncGenerator<FetchedMessage> {
  if (signal.aborted) {
    stopBatch(batch);
    return;
  }
  const onAbort = () => stopBatch(batch);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const message of batch) yield message;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** A pause before the next pull, cut short by an abort, so a back-off never holds a shutdown. */
async function pauseUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * What a consumer loop is doing, kept per process so a shutdown that waits for it can say what it
 * is waiting on instead of only naming the loop (#1028). The names carry no tenant data.
 */
export type ConsumerPhase = 'starting' | 'pulling' | 'waiting' | 'handling' | 'backing-off' | 'stopped';

const phases = new Map<string, { phase: ConsumerPhase; since: number }>();

function setPhase(name: string, phase: ConsumerPhase): void {
  phases.set(name, { phase, since: Date.now() });
}

/** Every consumer loop this process started, its phase and how long it has been in it. */
export function consumerPhases(): { name: string; phase: ConsumerPhase; forMs: number }[] {
  const now = Date.now();
  return [...phases].map(([name, entry]) => ({ name, phase: entry.phase, forMs: now - entry.since }));
}

/**
 * The consumer, or null when `signal` aborts first. Creating or updating a durable consumer is a
 * NATS API call, and on a connection that is reconnecting it can wait for a server that is not
 * there, so a shutdown must not be held by it (#1028).
 */
async function ensureConsumerOrAbort(ensure: () => Promise<PullConsumer>, signal: AbortSignal): Promise<PullConsumer | null> {
  if (signal.aborted) return null;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([ensure(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetches batches and hands them to `handler` until `signal` aborts. A failed pull is classified
 * (#307): transient errors are retried with a growing pause, a missing consumer is recreated, and
 * a fatal error or too many failures in a row reject, so `startWorkers` reports the worker as
 * stopped and the process restarts instead of retrying silently forever.
 */
export async function consumeLoop(
  ensureConsumer: () => Promise<PullConsumer>,
  o: Pick<ConsumerOptions, 'name' | 'maxBatch' | 'maxWaitMs' | 'pullExpiresMs'>,
  decode: (data: Uint8Array) => BusEvent,
  handler: (events: BusEvent[]) => Promise<void>,
  signal: AbortSignal,
  opts: { retryMs?: number } = {},
): Promise<void> {
  try {
    setPhase(o.name, 'starting');
    const created = await ensureConsumerOrAbort(ensureConsumer, signal);
    if (!created) return;
    let consumer = created;
    let failures = 0;
    const maxBatch = o.maxBatch ?? 1000;
    while (!signal.aborted) {
      const msgs: FetchedMessage[] = [];
      const started = Date.now();
      // Always fetch at least once (the fetch itself waits up to a second for messages), then keep
      // filling the batch while there is time left.
      try {
        do {
          setPhase(o.name, 'pulling');
          const batch = await fetchOrAbort(consumer, { max_messages: maxBatch - msgs.length, expires: o.pullExpiresMs ?? 1000 }, signal);
          if (!batch) break;
          setPhase(o.name, 'waiting');
          for await (const message of messagesOrAbort(batch, signal)) msgs.push(message);
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
        if (kind === 'missing_consumer') {
          setPhase(o.name, 'starting');
          const recreated = await ensureConsumerOrAbort(ensureConsumer, signal).catch(() => consumer);
          if (!recreated) return;
          consumer = recreated;
        }
        // What was fetched before the error is still handled; anything not acked is re-delivered.
        if (!msgs.length) {
          setPhase(o.name, 'backing-off');
          await pauseUnlessAborted(Math.min((opts.retryMs ?? FETCH_RETRY_MS) * failures, FETCH_RETRY_MAX_MS), signal);
          continue;
        }
      }
      // A shutdown does not start new work: whatever was pulled but not acked is re-delivered.
      if (signal.aborted) return;
      if (!msgs.length) continue;
      try {
        setPhase(o.name, 'handling');
        await handler(msgs.map((m) => decode(m.data)));
        for (const m of msgs) m.ack();
      } catch (err) {
        logger.error({ err, consumer: o.name, events: msgs.length }, 'event handler failed; batch will be re-delivered');
        for (const m of msgs) m.nak(2_000);
      }
    }
  } finally {
    setPhase(o.name, 'stopped');
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
  await connect({ servers: url }).then(async (nc) => {
    try {
      await (await jetstreamManager(nc)).streams.delete(namespace.toUpperCase()).catch(() => {});
    } finally {
      await nc.close();
    }
  });
}

/** Where a durable consumer is in the stream. A diagnostic/test helper, never part of a gate. */
export interface NatsConsumerState {
  lastSequence: number;
  ackFloor: number;
  pending: number;
}

/** Reads a durable consumer's position, for tests that must know a worker consumed a message. */
export async function natsConsumerState(url: string, namespace: string, consumer: string): Promise<NatsConsumerState> {
  const nc = await connect({ servers: url });
  try {
    const jsm = await jetstreamManager(nc);
    const stream = namespace.toUpperCase();
    const [info, streamInfo] = await Promise.all([jsm.consumers.info(stream, consumer), jsm.streams.info(stream)]);
    return {
      lastSequence: streamInfo.state.last_seq,
      ackFloor: info.ack_floor.stream_seq,
      pending: info.num_pending + info.num_ack_pending,
    };
  } finally {
    await nc.close();
  }
}

/**
 * Deletes every stream whose name starts with [prefix] (case-insensitive), e.g. one run's
 * `am_<run>_` namespace. Package tests create streams that no database name can reveal, so global
 * teardown uses the prefix rather than a list of databases.
 */
export async function resetNatsPrefix(url: string, prefix: string) {
  const nc = await connect({ servers: url });
  try {
    const jsm = await jetstreamManager(nc);
    const wanted = prefix.toUpperCase();
    for await (const stream of jsm.streams.list()) {
      if (stream.config.name.toUpperCase().startsWith(wanted)) {
        await jsm.streams.delete(stream.config.name).catch(() => {});
      }
    }
  } finally {
    await nc.close();
  }
}
