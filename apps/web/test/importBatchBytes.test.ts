import { describe, expect, it } from 'vitest';
import { batchImportRows, IMPORT_BATCH_BYTES, IMPORT_BODY_LIMIT_BYTES, oversizedImportRow, toImportRows } from '../src/lib/csvImport';

// #1250: the REST route refuses a body over 1 MB, so a batch must be cut by its encoded size as
// well as by the command's 5,000-row maximum. A Kit export of 5,000 such rows is ~1.34 MB.

const row = (i: number) => ({
  email: `firstname.lastname${i}@sub.example.co.uk`,
  traits: { firstName: 'Alexandria' },
  consent: [
    {
      purpose: 'marketing_email',
      status: 'granted' as const,
      recordedAt: '2026-01-15T09:30:00.000Z',
      proof: { system: 'Kit', status: 'active', subscribed_at: '2026-01-15T09:30:00.000Z' },
    },
  ],
});

const bodyBytes = (rows: unknown[]) => new TextEncoder().encode(JSON.stringify({ label: 'Kit export', rows })).length;

describe('import batching (#1250)', () => {
  it('cuts a 5,000-row Kit export into request bodies under the 1 MB limit', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => row(i));
    const batches = batchImportRows(rows);

    expect(batches.flat()).toEqual(rows);
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(5000);
    for (const batch of batches) {
      // Headroom under the route's 1,048,576-byte limit, including the label and JSON wrapper.
      expect(bodyBytes(batch)).toBeLessThanOrEqual(1024 * 1024);
      expect(bodyBytes(batch)).toBeLessThanOrEqual(IMPORT_BATCH_BYTES + 1024);
    }
  });

  it('keeps a small import in one batch and never splits a single row', () => {
    const small = Array.from({ length: 12 }, (_, i) => row(i));
    expect(batchImportRows(small)).toEqual([small]);

    const huge = { ...row(0), traits: { firstName: 'x'.repeat(IMPORT_BATCH_BYTES) } };
    expect(batchImportRows([row(1), huge, row(2)])).toEqual([[row(1)], [huge], [row(2)]]);
  });

  it('finds a row that cannot fit in one request even alone', () => {
    const huge = { ...row(0), traits: { firstName: 'x'.repeat(IMPORT_BODY_LIMIT_BYTES) } };
    const rows = [row(1), huge, row(2)];
    expect(oversizedImportRow(rows, 'Kit export')).toEqual({ index: 1 });
    expect(oversizedImportRow([row(0)], 'Kit export')).toBeNull();
  });

  it('numbers refused rows by their line in the CSV, counting the header', () => {
    const parsed = [['email_address'], ['ada@example.com'], ['not-an-email'], ['grace@example.com']];
    const prepared = toImportRows(
      parsed,
      { email: 0, firstName: -1, subscribedAt: -1, status: -1 },
      {
        purpose: 'marketing_email',
        system: 'Kit',
        activeOnly: false,
      },
    );
    expect(prepared.rowNumbers).toEqual([2, 4]);
    expect(prepared.skipped).toEqual([{ row: 3, reason: 'no valid e-mail' }]);
  });
});
