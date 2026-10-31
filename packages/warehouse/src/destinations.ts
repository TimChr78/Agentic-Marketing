import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, Socket } from 'node:net';
import { gzipSync } from 'node:zlib';
import type { WarehouseDataset } from '@agentic-marketing/db';
import { type EgressPolicy, egressFetch, isBlockedAddress } from '@agentic-marketing/integrations';
import { AwsClient } from 'aws4fetch';
import pg from 'pg';
import { z } from 'zod';
import { DATASETS, type Row } from './datasets';

// Where exports go. Postgres receives upserts into am_* tables (with the workspace id in every key),
// snapshots replaced in one transaction and erasures applied as deletes. S3-compatible storage
// receives gzipped NDJSON files that BigQuery, Snowflake, Redshift, DuckDB or Spark load as they
// are; erasures arrive as files of their own, for the warehouse to apply.

export interface Destination {
  /** Incremental rows, written as an upsert (Postgres) or appended (files). */
  write(dataset: WarehouseDataset, rows: Row[]): Promise<void>;
  /** A full snapshot replaces the previous one; rows arrive in several calls between begin and end. */
  beginSnapshot(dataset: WarehouseDataset): Promise<void>;
  writeSnapshot(dataset: WarehouseDataset, rows: Row[]): Promise<void>;
  endSnapshot(dataset: WarehouseDataset): Promise<void>;
  erase(erasures: { id: string; profileIds: string[]; at: string }[]): Promise<void>;
  close(): Promise<void>;
}

export const postgresConfig = z.object({
  schema: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('agentic_marketing'),
});
export const postgresSecrets = z.object({ url: z.string().regex(/^postgres(ql)?:\/\//, 'a postgres:// connection URL') });
export const s3Config = z.object({
  bucket: z.string().min(3).max(63),
  region: z.string().default('us-east-1'),
  endpoint: z.url().optional().describe('For R2, GCS (interoperability), MinIO…; path-style requests'),
  prefix: z.string().max(200).default('agentic-marketing/'),
});
export const s3Secrets = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) });

const table = (d: WarehouseDataset) => `am_${d}`;

export type DestinationLookup = (host: string) => Promise<LookupAddress[]>;

const resolveHost: DestinationLookup = (host) => lookup(host, { all: true });

export interface PostgresDeps {
  /** Resolve the destination host. Tests substitute a resolver that changes its answer. */
  lookup?: DestinationLookup;
  /** Create the pg client. Tests substitute a fake to inspect the connection config. */
  createClient?: (config: pg.ClientConfig) => pg.Client;
}

const explicitlyAllowed = (host: string, egress: EgressPolicy) =>
  egress.allowedHosts.map((h) => h.trim().toLowerCase()).includes(host.toLowerCase());

/**
 * Resolve the destination once and check every answer, so a mixed public/private answer cannot
 * slip through. The validated address is returned and pinned for the connection; resolving again
 * in pg would let a rebinding answer reach a private address.
 */
async function resolveDestination(host: string, egress: EgressPolicy, resolve: DestinationLookup): Promise<LookupAddress> {
  const literal = isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await resolve(host);
  if (!addresses.length) throw new Error(`${host} did not resolve`);
  if (!explicitlyAllowed(host, egress)) {
    const bad = addresses.find((a) => isBlockedAddress(a.address, egress));
    if (bad) throw new Error(`${host} resolves to private address ${bad.address}; allow it with EGRESS_ALLOWED_HOSTS`);
  }
  return addresses[0]!;
}

/**
 * A pg `stream` that dials the address that passed the egress check. pg asks for the host name
 * from the connection string; ignoring it here is the point. TLS still verifies the original host
 * name because pg passes that name, not the pinned address, to `tls.connect`.
 */
class PinnedSocket extends Socket {
  readonly #address: string;

  constructor(address: string) {
    super();
    this.#address = address;
  }

  override connect(...args: unknown[]): this {
    // pg calls `connect(port, host)`; the port and name have already been parsed and checked.
    const port = typeof args[0] === 'number' ? args[0] : undefined;
    if (port === undefined) throw new Error('pinned postgres socket expects a TCP port');
    const family = isIP(this.#address);
    return super.connect({ port, host: this.#address, ...(family ? { family: family as 4 | 6 } : {}) }) as this;
  }
}

export function pinnedStream(address: string): () => Socket {
  return () => new PinnedSocket(address);
}

export async function postgresDestination(
  ws: string,
  config: z.output<typeof postgresConfig>,
  secrets: z.output<typeof postgresSecrets>,
  egress: EgressPolicy,
  deps: PostgresDeps = {},
): Promise<Destination> {
  const url = new URL(secrets.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const answer = await resolveDestination(host, egress, deps.lookup ?? resolveHost);
  const client = (deps.createClient ?? ((c: pg.ClientConfig) => new pg.Client(c)))({
    connectionString: secrets.url,
    stream: pinnedStream(answer.address),
  });
  await client.connect();
  const schemaName = `"${config.schema}"`;
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  for (const [d, spec] of Object.entries(DATASETS)) {
    const cols = Object.entries(spec.columns).map(([c, type]) => `"${c}" ${type}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schemaName}.${table(d as WarehouseDataset)} (workspace_id uuid NOT NULL, ${cols.join(', ')},
         exported_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, ${spec.key.map((k) => `"${k}"`).join(', ')}))`,
    );
  }
  await client.query(`CREATE TABLE IF NOT EXISTS ${schemaName}.am_erasures (workspace_id uuid NOT NULL, id text NOT NULL,
    profile_ids text[] NOT NULL, at timestamptz NOT NULL, PRIMARY KEY (workspace_id, id))`);

  async function upsert(dataset: WarehouseDataset, rows: Row[]) {
    const spec = DATASETS[dataset];
    const cols = Object.keys(spec.columns);
    const quoted = cols.map((c) => `"${c}"`).join(', ');
    const recordType = Object.entries(spec.columns)
      .map(([c, t]) => `"${c}" ${t}`)
      .join(', ');
    const updates = cols
      .filter((c) => !spec.key.includes(c))
      .map((c) => `"${c}" = excluded."${c}"`)
      .concat('exported_at = now()')
      .join(', ');
    await client.query(
      `INSERT INTO ${schemaName}.${table(dataset)} (workspace_id, ${quoted})
       SELECT $1, ${quoted} FROM jsonb_to_recordset($2::jsonb) AS x(${recordType})
       ON CONFLICT (workspace_id, ${spec.key.map((k) => `"${k}"`).join(', ')}) DO UPDATE SET ${updates}`,
      [ws, JSON.stringify(rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))))],
    );
  }

  return {
    write: upsert,
    writeSnapshot: upsert,
    async beginSnapshot(dataset) {
      // The snapshot replaces the old rows atomically: readers see either the old set or the new one.
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${schemaName}.${table(dataset)} WHERE workspace_id = $1`, [ws]);
    },
    async endSnapshot() {
      await client.query('COMMIT');
    },
    async erase(erasures) {
      if (!erasures.length) return;
      const people = erasures.flatMap((e) => e.profileIds);
      await client.query('BEGIN');
      // Events are keyed by the person's ids, which are known through the exported identifiers.
      await client.query(
        `DELETE FROM ${schemaName}.am_events e USING ${schemaName}.am_identifiers i
         WHERE e.workspace_id = $1 AND i.workspace_id = $1 AND i.profile_id = ANY($2)
           AND ((i.type = 'user_id' AND e.user_id = i.value) OR (i.type = 'anonymous_id' AND e.anonymous_id = i.value))`,
        [ws, people],
      );
      for (const d of ['identifiers', 'consent', 'segment_memberships', 'message_events', 'profiles'] as const)
        await client.query(`DELETE FROM ${schemaName}.${table(d)} WHERE workspace_id = $1 AND profile_id = ANY($2)`, [ws, people]);
      for (const e of erasures)
        await client.query(
          `INSERT INTO ${schemaName}.am_erasures (workspace_id, id, profile_ids, at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [ws, e.id, e.profileIds, e.at],
        );
      await client.query('COMMIT');
    },
    async close() {
      await client.end();
    },
  };
}

export function s3Destination(
  ws: string,
  config: z.output<typeof s3Config>,
  secrets: z.output<typeof s3Secrets>,
  egress: EgressPolicy,
  runId: string,
): Destination {
  const aws = new AwsClient({ ...secrets, region: config.region, service: 's3' });
  const f = egressFetch(egress);
  const base = config.endpoint
    ? `${config.endpoint.replace(/\/$/, '')}/${config.bucket}/`
    : `https://${config.bucket}.s3.${config.region}.amazonaws.com/`;
  const prefix = `${config.prefix}${config.prefix && !config.prefix.endsWith('/') ? '/' : ''}workspace=${ws}/`;
  const parts = new Map<string, number>();
  const day = new Date().toISOString().slice(0, 10);

  async function put(key: string, rows: unknown[]) {
    const body = gzipSync(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    const req = await aws.sign(`${base}${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' },
      body,
    });
    const res = await f(req.url, { method: 'PUT', headers: req.headers, body });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const next = (k: string) => {
    const n = (parts.get(k) ?? 0) + 1;
    parts.set(k, n);
    return String(n).padStart(5, '0');
  };

  return {
    async write(dataset, rows) {
      await put(`${prefix}${dataset}/dt=${day}/${runId}-${next(dataset)}.ndjson.gz`, rows);
    },
    async beginSnapshot() {},
    async writeSnapshot(dataset, rows) {
      await put(`${prefix}${dataset}/snapshot=${runId}/part-${next(`${dataset}:snapshot`)}.ndjson.gz`, rows);
    },
    async endSnapshot(dataset) {
      // Marks the snapshot complete; loaders read the newest snapshot= folder that has it.
      await put(`${prefix}${dataset}/snapshot=${runId}/_complete.ndjson.gz`, []);
    },
    async erase(erasures) {
      if (erasures.length) await put(`${prefix}erasures/dt=${day}/${runId}.ndjson.gz`, erasures);
    },
    async close() {},
  };
}
