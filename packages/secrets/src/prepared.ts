import { createHash } from 'node:crypto';
import { type Db, schema } from '@agentic-marketing/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { KeyProvider } from './keys';
import { activeDataKey, type DataKeyPurpose } from './secrets';

// Prepared keys (#978, part 1). A protected transaction (the identity lock protocol that part 3
// activates) must not make network calls while it holds `identity:<workspace>`. The answer is to
// unwrap every data key it can need before the lock is taken, then give the transaction a
// memory-only provider that refuses to fall back to the configured KEK.
//
// Preparation has two short transactions: one provisions any missing active key (wrapping is a
// provider call), the next reads the wrapped rows. Unwrapping happens after that transaction has
// closed, so no database transaction is held across a KMS/OpenBao request.

/** The default purposes a person/consent batch reads: per-person keys and the matching HMAC key. */
export const DEFAULT_PREPARED_PURPOSES: readonly DataKeyPurpose[] = ['identity', 'matching'];

/** A data key changed after preparation: retry the whole prepare-and-run pair. */
export class KeysChangedError extends Error {
  readonly retryable = true;

  constructor(message = 'A data key changed after preparation. Retry the protected transaction with freshly prepared keys.') {
    super(message);
    this.name = 'KeysChangedError';
  }
}

/** True for `KeysChangedError` even when a bundler made two copies of the class. */
export function isKeysChangedError(error: unknown): error is KeysChangedError {
  return (
    error instanceof KeysChangedError ||
    (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'KeysChangedError')
  );
}

export interface PrepareKeysOptions {
  /** The profiles the protected transaction will open or reseal; their per-person keys are prepared. */
  profileIds?: Iterable<string>;
  /**
   * Active data keys the protected transaction will read. Default: identity and matching.
   * Identity values (e-mail, phone) need no per-value key: their match hash uses the matching key.
   */
  purposes?: readonly DataKeyPurpose[];
}

/** The result of preparation: a memory-only provider plus what it was prepared from. */
export interface PreparedKeys {
  readonly workspaceId: string;
  /** Safe to pass to `personCrypto` or any other code that accepts a `KeyProvider`. */
  readonly provider: KeyProvider;
  readonly purposes: readonly DataKeyPurpose[];
  readonly dataKeyIds: readonly string[];
  readonly profileIds: readonly string[];
}

/** Identifies a wrapped key by the KEK it needs and its exact bytes, so a re-wrap is a new reference. */
const reference = (wrapped: Buffer, kekId: string) => `${kekId}:${createHash('sha256').update(wrapped).digest('hex')}`;

/**
 * Builds a provider that can only answer from memory. `wrap` throws: a missing active key must have
 * been provisioned by preparation, never created under the protected transaction. `unwrap` never
 * reaches the configured provider; a key it does not hold is a retryable `KeysChangedError`.
 */
function preparedProvider(kp: KeyProvider, entries: ReadonlyMap<string, Buffer>): KeyProvider {
  return {
    id: kp.id,
    ...(kp.owns ? { owns: (kekId: string) => Boolean(kp.owns?.(kekId)) } : {}),
    async wrap() {
      throw new KeysChangedError(
        'A data key had to be created or wrapped inside a protected transaction. Prepare the workspace keys first.',
      );
    },
    async unwrap(wrapped, kekId) {
      const key = entries.get(reference(wrapped, kekId));
      if (!key) throw new KeysChangedError('A prepared transaction needed a data key that was not prepared (or changed since).');
      return key;
    },
  };
}

/**
 * Loads and unwraps the active keys for `purposes` and the per-person keys of `profileIds`.
 *
 * Missing active keys are provisioned in their own short transaction. The wrapped rows are read in
 * a second short transaction; the provider calls happen after it closes. The returned provider is
 * memory-only, so the protected transaction cannot reach the KEK.
 */
export async function prepareKeys(
  db: Pick<Db, 'withWorkspace'>,
  workspaceId: string,
  kp: KeyProvider,
  options: PrepareKeysOptions = {},
): Promise<PreparedKeys> {
  const purposes = [...new Set(options.purposes ?? DEFAULT_PREPARED_PURPOSES)];
  const profileIds = [...new Set(options.profileIds ?? [])];

  // Provisioning is its own short transaction: first use of a purpose wraps a new data key, which
  // may be an HTTP call to KMS or OpenBao. Never do that under the identity lock.
  await db.withWorkspace(workspaceId, async (tx) => {
    for (const purpose of purposes) {
      const [active] = await tx
        .select({ id: schema.dataKeys.id })
        .from(schema.dataKeys)
        .where(and(eq(schema.dataKeys.workspaceId, workspaceId), eq(schema.dataKeys.active, true), eq(schema.dataKeys.purpose, purpose)));
      if (!active) await activeDataKey(tx, workspaceId, kp, purpose);
    }
  });

  const rows = await db.withWorkspace(workspaceId, async (tx) => {
    const active = purposes.length
      ? await tx
          .select()
          .from(schema.dataKeys)
          .where(
            and(eq(schema.dataKeys.workspaceId, workspaceId), eq(schema.dataKeys.active, true), inArray(schema.dataKeys.purpose, purposes)),
          )
      : [];
    const profileKeys = profileIds.length
      ? await tx
          .select()
          .from(schema.profileKeys)
          .where(and(eq(schema.profileKeys.workspaceId, workspaceId), inArray(schema.profileKeys.profileId, profileIds)))
      : [];
    const ids = [...new Set([...active.map((k) => k.id), ...profileKeys.map((k) => k.dataKeyId)])];
    const dataKeys = ids.length
      ? await tx
          .select()
          .from(schema.dataKeys)
          .where(and(eq(schema.dataKeys.workspaceId, workspaceId), inArray(schema.dataKeys.id, ids)))
      : [];
    return { dataKeys };
  });

  // Unwrap after the read transaction closed, one at a time so a large batch does not burst a
  // remote KMS, and count exactly one provider call per distinct data key.
  const entries = new Map<string, Buffer>();
  for (const row of rows.dataKeys) entries.set(reference(row.wrappedKey, row.kekId), await kp.unwrap(row.wrappedKey, row.kekId));

  return {
    workspaceId,
    provider: preparedProvider(kp, entries),
    purposes,
    dataKeyIds: [...new Set(rows.dataKeys.map((k) => k.id))],
    profileIds,
  };
}

/**
 * Runs `prepare` then `run`, retrying the whole pair when a key changed between them. `run` must own
 * its transaction: a `KeysChangedError` thrown inside it has to roll that transaction back before
 * the retry starts, or the retry would resume half-written work.
 */
export async function withPreparedKeys<T>(
  prepare: () => Promise<PreparedKeys>,
  run: (prepared: PreparedKeys) => Promise<T>,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? 3));
  for (let attempt = 1; ; attempt++) {
    const prepared = await prepare();
    try {
      return await run(prepared);
    } catch (error) {
      if (!isKeysChangedError(error) || attempt >= attempts) throw error;
    }
  }
}

export interface KeyProviderCall {
  readonly method: 'wrap' | 'unwrap';
  readonly kekId: string;
}

/** A provider that records every call before delegating, for the no-provider-calls guard. */
export interface RecordingKeyProvider extends KeyProvider {
  readonly calls: KeyProviderCall[];
  reset(): void;
}

export function recordingKeyProvider(inner: KeyProvider): RecordingKeyProvider {
  const calls: KeyProviderCall[] = [];
  return {
    id: inner.id,
    ...(inner.owns ? { owns: (kekId: string) => Boolean(inner.owns?.(kekId)) } : {}),
    calls,
    reset() {
      calls.length = 0;
    },
    async wrap(dataKey) {
      calls.push({ method: 'wrap', kekId: inner.id });
      return inner.wrap(dataKey);
    },
    async unwrap(wrapped, kekId) {
      calls.push({ method: 'unwrap', kekId });
      return inner.unwrap(wrapped, kekId);
    },
  };
}

/**
 * Asserts that `fn` made no key-provider call. Used by tests (and later by the protocol tests) to
 * prove a protected block never falls back to KMS/OpenBao/local unwrapping.
 */
export async function assertNoProviderCalls<T>(provider: RecordingKeyProvider, fn: () => Promise<T>): Promise<T> {
  const before = provider.calls.length;
  const result = await fn();
  const calls = provider.calls.slice(before);
  if (calls.length)
    throw new Error(
      `A protected block made ${calls.length} key-provider call(s): ${calls.map((c) => `${c.method}(${c.kekId})`).join(', ')}.`,
    );
  return result;
}
