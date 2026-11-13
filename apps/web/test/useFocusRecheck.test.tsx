import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFocusRecheck } from '../src/app/useFocusRecheck';
import { mergeReferenceSnapshots } from '../src/features/artifacts/referenceSnapshots';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useFocusRecheck (0.14.13 review round 3)', () => {
  it('reads once for the focus and visibilitychange of one return', () => {
    vi.useFakeTimers();
    const recheck = vi.fn();
    renderHook(() => useFocusRecheck(recheck));
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('reads again on a later return even without a blur or hidden event in between', () => {
    vi.useFakeTimers();
    const recheck = vi.fn();
    renderHook(() => useFocusRecheck(recheck));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => vi.advanceTimersByTime(5_000));
    act(() => window.dispatchEvent(new Event('focus')));
    act(() => vi.advanceTimersByTime(5_000));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(recheck).toHaveBeenCalledTimes(3);
  });
});

describe('mergeReferenceSnapshots (0.14.13 review round 3)', () => {
  it('never lets an older watcher response pull an adopted stamp backwards', () => {
    const adopted = { list: { version: 3, stamp: '2026-11-13 10:00:00.000002' } };
    const olderRead = { list: { version: 3, stamp: '2026-11-13 10:00:00.000001' } };
    expect(mergeReferenceSnapshots(adopted, olderRead)).toEqual(adopted);
  });

  it('takes a newer read, and drops references the segment no longer uses', () => {
    const live = { a: { version: 1, stamp: null }, gone: { version: 2, stamp: null } };
    const read = { a: { version: 2, stamp: null } };
    expect(mergeReferenceSnapshots(live, read)).toEqual({ a: { version: 2, stamp: null } });
  });

  it('takes an unpublished reference as a change, and keeps the live state on a failed read', () => {
    const live = { a: { version: 3, stamp: null }, b: { version: 1, stamp: null } };
    expect(mergeReferenceSnapshots(live, { a: { version: null, stamp: null }, b: undefined })).toEqual({
      a: { version: null, stamp: null },
      b: { version: 1, stamp: null },
    });
  });
});
