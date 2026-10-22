import { createHash } from 'node:crypto';

export const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
export const STREAM = 'EVENTS';
export const SHARDS = 16;
export const WORKSPACE = 'ws_fjeldvej';

/** Segment-spec style event as accepted by the ingest gateway. */
export interface InEvent {
  type: 'track' | 'page' | 'identify';
  event?: string;
  messageId: string;
  anonymousId: string;
  userId?: string;
  timestamp: string;
  properties?: Record<string, unknown>;
  context?: Record<string, unknown>;
  /** Per-profile sequence number, only used by the spike to check ordering. */
  seq: number;
}

/** Event on the bus after ingest: enriched and tenant-stamped. */
export interface BusEvent extends InEvent {
  workspaceId: string;
  receivedAt: string;
}

export const shardOf = (anonymousId: string) => createHash('md5').update(anonymousId).digest().readUInt32BE(0) % SHARDS;
export const subjectFor = (workspaceId: string, anonymousId: string) => `events.${workspaceId}.${shardOf(anonymousId)}`;

const names = ['page_viewed', 'product_viewed', 'product_viewed', 'product_viewed', 'search', 'product_added', 'checkout_started', 'order_completed'];
const categories = ['shoes', 'jackets', 'tents', 'backpacks'];

/**
 * Deterministic event generator: `profiles` visitors; each block of `profiles` consecutive events
 * touches every visitor once (7919 is coprime with the profile count), so seq = block + 1.
 */
export function* generateEvents(total: number, profiles: number, startMs: number, offset = 0) {
  for (let i = offset; i < offset + total; i++) {
    const p = (i * 7919) % profiles;
    const name = names[(i * 31 + p) % names.length];
    const ev: InEvent = {
      type: name === 'page_viewed' ? 'page' : 'track',
      event: name,
      messageId: `m_${i.toString(36)}_${p.toString(36)}`,
      anonymousId: `anon_${p.toString(36).padStart(5, '0')}`,
      timestamp: new Date(startMs + i * 37).toISOString(),
      properties: {
        category: categories[(i + p) % categories.length],
        sku: `SKU-${(i % 400).toString().padStart(4, '0')}`,
        price: 499 + (i % 30) * 50,
        currency: 'DKK',
      },
      context: { page: { path: `/${categories[p % 4]}` }, userAgent: 'Mozilla/5.0 (spike)', locale: 'da-DK' },
      seq: Math.floor(i / profiles) + 1,
    };
    yield ev;
  }
}
