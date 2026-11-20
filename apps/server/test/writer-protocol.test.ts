import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../../packages/db/test/disposable';
import { WRITER_PROTOCOL_VERSION, writerProtocolMismatch } from '../src/writerProtocol';

// #1066: the migration records the writer protocol version in the database. A server that
// implements an older protocol refuses to start writers instead of running beside a newer one
// across a drained upgrade.

let d: Awaited<ReturnType<typeof createDisposableDb>>;

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('writer_protocol');
}, 120_000);

afterAll(async () => {
  await d?.close();
});

describe.skipIf(!hasTestDatabase())('writer protocol guard (#1066)', () => {
  it('records the version this build implements at migration time', async () => {
    const { rows } = await d.db.admin.query<{ protocol_version: number }>('SELECT protocol_version FROM writer_protocol');
    expect(rows).toEqual([{ protocol_version: WRITER_PROTOCOL_VERSION }]);
    expect(await writerProtocolMismatch(d.db.admin)).toBeNull();
  });

  it('refuses a database that records a newer protocol and names UPGRADING.md', async () => {
    await d.db.admin.query('UPDATE writer_protocol SET protocol_version = $1', [WRITER_PROTOCOL_VERSION + 1]);
    const problem = await writerProtocolMismatch(d.db.admin);
    expect(problem).not.toBeNull();
    expect(problem).toContain(String(WRITER_PROTOCOL_VERSION + 1));
    expect(problem).toContain(String(WRITER_PROTOCOL_VERSION));
    expect(problem).toContain('UPGRADING.md');
    expect(problem).toMatch(/refus/i);

    await d.db.admin.query('UPDATE writer_protocol SET protocol_version = $1', [WRITER_PROTOCOL_VERSION]);
    expect(await writerProtocolMismatch(d.db.admin)).toBeNull();
  });

  it('treats a database that has not run the migration as unknown, not as newer', async () => {
    const old = await createDisposableDb('writer_protocol_old', { upTo: '0113_erasure_completion.sql' });
    try {
      expect(await writerProtocolMismatch(old.db.admin)).toBeNull();
    } finally {
      await old.close();
    }
  }, 120_000);
});
