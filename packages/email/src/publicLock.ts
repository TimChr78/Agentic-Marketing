/**
 * How long a public request waits for the workspace identity lock before answering a retryable
 * `503` (#1074). A merge or import can hold the lock for many seconds; a provider webhook or an
 * unsubscribe must not pin a pool connection for all of it, and the ESP retries on `503`.
 */
export const PUBLIC_IDENTITY_LOCK_WAIT_MS = 2_000;

/** What a shed public request tells the provider to wait before its retry. */
export const PUBLIC_IDENTITY_LOCK_RETRY_AFTER_SECONDS = '10';
