// CSV → profiles.import rows, for moving subscribers from Kit (ConvertKit), Mailchimp and the like.
// Pure functions: parsing (RFC 4180: quotes, escaped quotes, newlines in quotes), guessing which
// columns hold what, and mapping rows with their consent and proof.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  // The delimiter is whichever of , ; and tab the header line uses most (spreadsheet exports vary).
  const header = src.split(/\r?\n/, 1)[0];
  const delim = [',', ';', '\t'].sort((a, b) => header.split(b).length - header.split(a).length)[0];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export interface Mapping {
  email: number;
  firstName: number;
  subscribedAt: number;
  status: number;
}

const find = (headers: string[], names: string[]) => {
  const norm = headers.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
  return norm.findIndex((h) => names.includes(h));
};

/** Column guesses for common exports (Kit: email_address, first_name, created_at, state). -1 when absent. */
export function guessMapping(headers: string[]): Mapping {
  return {
    email: find(headers, ['email_address', 'email', 'e_mail', 'email_address_(required)', 'subscriber_email']),
    firstName: find(headers, ['first_name', 'firstname', 'first', 'name', 'fname']),
    subscribedAt: find(headers, [
      'created_at',
      'subscribed_at',
      'confirmed_at',
      'optin_time',
      'confirm_time',
      'date_added',
      'signup_date',
      'created',
    ]),
    status: find(headers, ['state', 'status', 'subscription_status']),
  };
}

/** Statuses that mean "currently subscribed" in common tools. */
export const ACTIVE = ['active', 'confirmed', 'subscribed', 'subscriber'];

/**
 * `profiles.import` accepts 5,000 rows, but the REST route refuses a body over 1 MB (#1250). A row
 * with its consent proof is ~270 bytes, so row count alone overshoots the limit; a batch is cut
 * when either limit would be crossed.
 */
export const IMPORT_BATCH_ROWS = 5000;
/** Headroom below the route's 1 MB body limit for the label and the JSON wrapper. */
export const IMPORT_BATCH_BYTES = 900_000;
/** The REST route's body limit; a single row must leave room for the label and wrapper within it. */
export const IMPORT_BODY_LIMIT_BYTES = 1024 * 1024;

/** The encoded size of a `profiles.import` request body, before a batch is sent. */
export function importRequestBytes(label: string, rows: readonly unknown[]): number {
  return new TextEncoder().encode(JSON.stringify({ label, rows })).length;
}

/**
 * The first row that is too large to send even alone, as an index into `rows` (#1250 review). The
 * caller refuses before the first request, so no earlier batch is lost to a later 413.
 */
export function oversizedImportRow(rows: readonly unknown[], label: string): { index: number } | null {
  for (let index = 0; index < rows.length; index++) {
    if (importRequestBytes(label, [rows[index]]) > IMPORT_BODY_LIMIT_BYTES) return { index };
  }
  return null;
}

export function batchImportRows<T>(rows: readonly T[], maxRows = IMPORT_BATCH_ROWS, maxBytes = IMPORT_BATCH_BYTES): T[][] {
  const encoder = new TextEncoder();
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    // The serialized row plus the comma that separates it from the next one.
    const rowBytes = encoder.encode(JSON.stringify(row)).length + 1;
    if (batch.length > 0 && (batch.length >= maxRows || bytes + rowBytes > maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += rowBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export interface ImportRow {
  email: string;
  traits: Record<string, string>;
  consent: { purpose: string; status: 'granted'; recordedAt?: string; proof: Record<string, string> }[];
}

export function toImportRows(
  rows: string[][],
  m: Mapping,
  opts: { purpose: string; system: string; activeOnly: boolean },
): { rows: ImportRow[]; rowNumbers: number[]; skipped: { row: number; reason: string }[] } {
  const out: ImportRow[] = [];
  const rowNumbers: number[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, i) => {
    // The CSV line in the file, counting the header: data row i is file row i + 2.
    const row = i + 2;
    const email = (r[m.email] ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      skipped.push({ row, reason: 'no valid e-mail' });
      return;
    }
    if (seen.has(email)) {
      skipped.push({ row, reason: 'duplicate' });
      return;
    }
    const status = m.status >= 0 ? (r[m.status] ?? '').trim().toLowerCase() : '';
    if (opts.activeOnly && m.status >= 0 && !ACTIVE.includes(status)) {
      skipped.push({ row, reason: `status "${status || 'empty'}"` });
      return;
    }
    seen.add(email);
    rowNumbers.push(row);
    const when = m.subscribedAt >= 0 ? new Date((r[m.subscribedAt] ?? '').trim()) : null;
    const firstName = m.firstName >= 0 ? (r[m.firstName] ?? '').trim() : '';
    out.push({
      email,
      traits: firstName ? { firstName } : {},
      consent: [
        {
          purpose: opts.purpose,
          status: 'granted',
          ...(when && !Number.isNaN(when.getTime()) ? { recordedAt: when.toISOString() } : {}),
          proof: {
            system: opts.system,
            ...(status ? { status } : {}),
            ...(when && !Number.isNaN(when.getTime()) ? { subscribed_at: when.toISOString() } : {}),
          },
        },
      ],
    });
  });
  return { rows: out, rowNumbers, skipped };
}
