import { newId } from '@agentic-marketing/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDisposableDb, hasTestDatabase } from '../../db/test/disposable';
import { listAiCalls } from '../src/commands';

// #1243: `ai.calls` paged with a strict `created_at < before` on a millisecond value and no id
// tie-breaker, while sorting by (created_at DESC, id DESC). Rows written by one statement share
// created_at (a prompt test run, a batch of journey steps), so a page boundary inside a group
// dropped the rest of it. The list must offer the full-precision cursor with an id tie-breaker.

let d: Awaited<ReturnType<typeof createDisposableDb>>;
let ws = '';
const ids = [newId('aic'), newId('aic'), newId('aic')].sort();

beforeAll(async () => {
  if (!hasTestDatabase()) return;
  d = await createDisposableDb('ai_calls_cursor');
  ws = d.workspace;
  // One statement, one now(): what prompts.test writes for a three-case run.
  await d.db.admin.query(
    `INSERT INTO ai_calls (workspace_id, id, kind, status, created_at)
     SELECT $1, unnest($2::text[]), 'test', 'done', now()`,
    [ws, ids],
  );
}, 120_000);

afterAll(async () => {
  await d?.close();
});

const page = (input: { limit: number; before?: string; cursor?: string }) =>
  d.db.withWorkspace(ws, (tx) => listAiCalls.handler(input as never, { tx, principal: { workspaceId: ws } } as never));

describe.skipIf(!hasTestDatabase())('ai.calls pages every row that shares a timestamp (#1243)', () => {
  it('follows nextCursor through a same-timestamp group without dropping a row', async () => {
    const first = await page({ limit: 2 });
    // Newest first: id DESC inside the shared timestamp.
    expect(first.calls.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).toBeTruthy();

    const second = await page({ limit: 2, cursor: first.nextCursor! });
    expect(second.calls.map((c) => c.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  }, 60_000);

  it('still accepts the existing `before` input', async () => {
    const first = await page({ limit: 2 });
    const older = await page({ limit: 2, before: first.calls[1]!.createdAt });
    // The legacy boundary stays a strict timestamp comparison; it must not throw or change shape.
    expect(Array.isArray(older.calls)).toBe(true);
  }, 60_000);

  it('pages distinct microseconds inside one millisecond', async () => {
    const us = await createDisposableDb('ai_calls_cursor_us');
    try {
      // Three rows in the same millisecond (.123), one microsecond apart. A cursor built from a
      // millisecond Date would encode .123000 and the second page would skip .123456.
      const microseconds = [newId('aic'), newId('aic'), newId('aic')].sort();
      await us.db.admin.query(
        `INSERT INTO ai_calls (workspace_id, id, kind, status, created_at)
         VALUES ($1, $2, 'test', 'done', '2026-08-01T12:00:00.123456Z'),
                ($1, $3, 'test', 'done', '2026-08-01T12:00:00.123457Z'),
                ($1, $4, 'test', 'done', '2026-08-01T12:00:00.123458Z')`,
        [us.workspace, microseconds[0], microseconds[1], microseconds[2]],
      );
      const pageOf = (input: { limit: number; cursor?: string }) =>
        us.db.withWorkspace(us.workspace, (tx) =>
          listAiCalls.handler(input as never, { tx, principal: { workspaceId: us.workspace } } as never),
        );
      const first = await pageOf({ limit: 2 });
      expect(first.calls.map((c) => c.id)).toEqual([microseconds[2], microseconds[1]]);
      expect(first.nextCursor).toBeTruthy();
      const second = await pageOf({ limit: 2, cursor: first.nextCursor! });
      expect(second.calls.map((c) => c.id)).toEqual([microseconds[0]]);
      expect(second.nextCursor).toBeNull();
    } finally {
      await us.close();
    }
  }, 60_000);
});
