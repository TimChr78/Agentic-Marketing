import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chunkFailureOutcome, DEFAULT_ENROLLMENT_RETRY, isPermanentEnrollmentError } from '../src/enrollment';

// #370: a transient chunk error keeps the job resumable — status stays queued/running, the cursor
// and counts are untouched (they live in the previous committed chunk) and only the retry
// bookkeeping advances. The retry is bounded; a schema/artifact error is terminal immediately.

const NOW = new Date('2026-11-04T09:00:00.000Z');
const policy = { maxAttempts: 3, backoffMs: [1_000, 5_000] };

describe('enrollment chunk retry state', () => {
  it('keeps a running job running with a bounded backoff after a transient error', () => {
    expect(
      chunkFailureOutcome({ status: 'running', attempts: 0 }, 'canceling statement due to statement timeout', { retry: policy, now: NOW }),
    ).toEqual({
      status: 'running',
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 1_000),
      error: 'chunk attempt 1 of 3 failed; retrying: canceling statement due to statement timeout',
      finishedAt: null,
    });
  });

  it('keeps a queued job queued and repeats the last backoff step', () => {
    const outcome = chunkFailureOutcome({ status: 'queued', attempts: 1 }, 'deadlock detected', { retry: policy, now: NOW });
    expect(outcome).toMatchObject({ status: 'queued', attempts: 2, nextAttemptAt: new Date(NOW.getTime() + 5_000) });
    expect(chunkFailureOutcome({ status: 'running', attempts: 9 }, 'x', { retry: policy, now: NOW }).status).toBe('failed');
  });

  it('fails terminally after the last attempt without pretending the people failed', () => {
    const outcome = chunkFailureOutcome({ status: 'running', attempts: 2 }, 'connection terminated', { retry: policy, now: NOW });
    expect(outcome).toMatchObject({ status: 'failed', attempts: 3, nextAttemptAt: null, finishedAt: NOW });
    expect(outcome.error).toBe('connection terminated');
  });

  it('treats artifact/schema validation errors as permanent on the first attempt', () => {
    const schemaError = z.object({ a: z.string() }).safeParse({ a: 1 }).error!;
    expect(isPermanentEnrollmentError(schemaError)).toBe(true);
    expect(
      chunkFailureOutcome({ status: 'running', attempts: 0 }, 'invalid journey content', { permanent: true, retry: policy, now: NOW }),
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: null,
    });
  });

  it('does not classify a database error as permanent', () => {
    expect(isPermanentEnrollmentError(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(false);
    expect(isPermanentEnrollmentError(new AppError('conflict', 'republished'))).toBe(true);
    expect(isPermanentEnrollmentError(new AppError('precondition_failed', 'boom'))).toBe(false);
    expect(DEFAULT_ENROLLMENT_RETRY.maxAttempts).toBeGreaterThan(1);
  });
});
