import type { z } from 'zod';
import type { SafeResponse } from './egress';

// The connector SDK (channels-and-personalization.md §6). A connector declares its settings and
// secrets as schemas (the UI, REST and MCP show them), how it authenticates, and what it can do:
// receive webhooks and turn them into events (a source), and/or offer actions that journeys can
// call. Connectors never touch the database or the network directly: they get settings, decrypted
// secrets and an egress-guarded `request`.

/** A Segment-spec event (track, identify, page…) as the ingest gateway accepts it. */
export type InboundItem = Record<string, unknown> & { type: string };

export interface InboundContext<S, K> {
  settings: S;
  secrets: K;
  headers: Record<string, string | undefined>;
  /** The raw body, exactly as received (signatures are computed over it). */
  body: string;
}

export interface ActionContext<S, K> {
  settings: S;
  secrets: K;
  request: (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
  ) => Promise<SafeResponse>;
}

// biome-ignore lint/suspicious/noExplicitAny: connectors are heterogeneous; each action's input schema validates at run time
export interface ConnectorAction<S = any, K = any> {
  label: string;
  description: string;
  input: z.ZodType;
  /** Returns what the journey stores as the step's result. Throwing takes the step's error edge. */
  // biome-ignore lint/suspicious/noExplicitAny: validated by `input` before run is called
  run(input: any, ctx: ActionContext<S, K>): Promise<unknown>;
}

// biome-ignore lint/suspicious/noExplicitAny: a registry holds connectors with different settings and secrets
export interface Connector<S = any, K = any> {
  id: string;
  label: string;
  description: string;
  auth: 'none' | 'api_key' | 'signing_secret' | 'oauth2';
  settings: z.ZodType<S>;
  secrets: z.ZodType<K>;
  /** Receives webhooks at /hooks/in/<connection>/<token>. */
  inbound?: {
    /** Returns why a request is not authentic, or null. */
    verify(ctx: InboundContext<S, K>): string | null;
    map(payload: unknown, ctx: InboundContext<S, K>): Promise<InboundItem[]> | InboundItem[];
  };
  actions?: Record<string, ConnectorAction<S, K>>;
  /** Calls per minute per connection that actions stay under. */
  rateLimit?: number;
}

export function defineConnector<S, K>(c: Connector<S, K>): Connector<S, K> {
  return c;
}
