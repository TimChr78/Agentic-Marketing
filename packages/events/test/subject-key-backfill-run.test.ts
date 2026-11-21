import { describe, expect, it } from 'vitest';
import { isSchemaMissingError, runSubjectKeyBackfill, type SubjectKeyBackfillResult } from '../src/subjectKeys';

// #1140: only a missing schema is permanent. A transient ClickHouse or Postgres error must be
// retried with backoff, or one timeout disables erasure cleanup for the whole scheduler lifetime.

const done = (): SubjectKeyBackfillResult => ({ done: true, tables: [] });
const notDone = (): SubjectKeyBackfillResult => ({
  done: false,
  tables: [{ table: 'events', workspaceId: 'ws', advanced: false, remaining: true, done: false }],
});

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('schema-missing classification (#1140)', () => {
  it('recognises ClickHouse and Postgres missing-schema errors only', () => {
    expect(isSchemaMissingError({ type: 'UNKNOWN_TABLE' })).toBe(true);
    expect(isSchemaMissingError({ type: 'UNKNOWN_IDENTIFIER' })).toBe(true);
    expect(isSchemaMissingError(new Error('Code: 60. DB::Exception: UNKNOWN_TABLE'))).toBe(true);
    expect(isSchemaMissingError({ code: '42P01' })).toBe(true);
    expect(isSchemaMissingError({ code: '42703' })).toBe(true);
    expect(isSchemaMissingError(new Error('connection terminated unexpectedly'))).toBe(false);
    expect(isSchemaMissingError({ code: '57014' })).toBe(false);
  });
});

describe('runSubjectKeyBackfill resilience (#1140)', () => {
  it('keeps retrying a transient error with backoff instead of exiting', async () => {
    const stop = new AbortController();
    const errors: unknown[] = [];
    let calls = 0;
    const running = runSubjectKeyBackfill(
      {
        workspaces: async () => ['ws'],
        events: {
          backfillSubjectKeys: async () => {
            calls++;
            if (calls === 1) throw new Error('ClickHouse timeout');
            return done();
          },
        },
      },
      stop.signal,
      { pauseMs: 2, maxBackoffMs: 8, callsPerTurn: 1, onError: (err) => errors.push(err) },
    );
    try {
      await until(() => calls >= 2, 'the retry');
      expect(errors).toHaveLength(1);
    } finally {
      stop.abort();
      await running;
    }
  });

  it('returns on a permanent schema-missing error', async () => {
    const stop = new AbortController();
    let calls = 0;
    await runSubjectKeyBackfill(
      {
        workspaces: async () => ['ws'],
        events: {
          backfillSubjectKeys: async () => {
            calls++;
            throw { type: 'UNKNOWN_TABLE', message: 'Unknown table events' };
          },
        },
      },
      stop.signal,
      { pauseMs: 1, callsPerTurn: 1 },
    );
    expect(calls).toBe(1);
  });

  it('returns on a missing Postgres relation or column', async () => {
    for (const code of ['42P01', '42703']) {
      let calls = 0;
      await runSubjectKeyBackfill(
        {
          workspaces: async () => ['ws'],
          events: {
            backfillSubjectKeys: async () => {
              calls++;
              throw { code };
            },
          },
        },
        new AbortController().signal,
        { pauseMs: 1, callsPerTurn: 1 },
      );
      expect(calls).toBe(1);
    }
  });

  it('stays abortable while backing off', async () => {
    const stop = new AbortController();
    let calls = 0;
    let errored!: () => void;
    const first = new Promise<void>((resolve) => (errored = resolve));
    const running = runSubjectKeyBackfill(
      {
        workspaces: async () => ['ws'],
        events: {
          backfillSubjectKeys: async () => {
            calls++;
            throw new Error('still unavailable');
          },
        },
      },
      stop.signal,
      {
        pauseMs: 60_000,
        callsPerTurn: 1,
        onError: () => {
          if (calls === 1) errored();
        },
      },
    );
    await first;
    stop.abort();
    await running;
    expect(calls).toBe(1);
  });

  it('does not treat a pass with remaining work as done', async () => {
    const stop = new AbortController();
    let calls = 0;
    const running = runSubjectKeyBackfill(
      {
        workspaces: async () => ['ws'],
        events: {
          backfillSubjectKeys: async () => {
            calls++;
            return calls === 1 ? notDone() : done();
          },
        },
      },
      stop.signal,
      { pauseMs: 1, callsPerTurn: 1 },
    );
    try {
      await until(() => calls >= 2, 'the next pass');
    } finally {
      stop.abort();
      await running;
    }
  });
});
