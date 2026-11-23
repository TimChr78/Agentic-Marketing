/**
 * Where ClickHouse lives, resolved one way for every backup and restore step (#1204 review).
 *
 * `CLICKHOUSE_URL` is optional: without it the load, the export and the restore's reconciliation
 * all fall back to {@link DEFAULT_CLICKHOUSE_URL}. The restore's drain has to probe the same point
 * those steps write to, so it resolves the endpoint through this module instead of skipping
 * ClickHouse when the variable is unset.
 */

/** The ClickHouse endpoint a deployment without `CLICKHOUSE_URL` uses everywhere. */
export const DEFAULT_CLICKHOUSE_URL = 'http://localhost:8123';

/** A connection detail without credentials: they travel as an Authorization header, never a URL. */
export interface ClickHouseEndpoint {
  url: URL;
  headers: Record<string, string>;
}

/** The raw ClickHouse URL, defaulted the way every backup/restore step defaults it. */
export function clickhouseUrl(raw: string | undefined): string {
  return raw?.trim() || DEFAULT_CLICKHOUSE_URL;
}

/**
 * The URL and headers one ClickHouse request uses. Credentials in the URL are moved to a Basic
 * Authorization header, so a password never appears in a log line or an error message.
 */
export function clickhouseEndpoint(raw: string | undefined): ClickHouseEndpoint {
  const url = new URL(clickhouseUrl(raw));
  const headers: Record<string, string> = {};
  if (url.username || url.password) {
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    url.username = '';
    url.password = '';
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return { url, headers };
}
