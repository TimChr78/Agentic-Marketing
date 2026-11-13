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

describe('mergeReferenceSnapshots (0.14.13 review rounds 3 and 4)', () => {
  const live = (version: number | null, stamp: string | null, seq: number, unverified = false) => ({ version, stamp, seq, unverified });

  it('never lets an older published read pull an adopted stamp backwards', () => {
    const adopted = { list: live(3, '2026-11-13 10:00:00.000002', 5) };
    const merged = mergeReferenceSnapshots(adopted, { list: { version: 3, stamp: '2026-11-13 10:00:00.000001' } }, 6);
    expect(merged.list).toMatchObject({ version: 3, stamp: '2026-11-13 10:00:00.000002', unverified: false });
  });

  it('ignores a stale unpublished read that started before an adopted republish', () => {
    // The watcher saw B unpublished (observation 3); an estimate that started later (5) adopted v4.
    const merged = mergeReferenceSnapshots({ b: live(4, null, 5) }, { b: { version: null, stamp: null } }, 3);
    expect(merged.b).toMatchObject({ version: 4, seq: 5 });
  });

  it('takes an unpublish observed after the live state as a change', () => {
    const merged = mergeReferenceSnapshots({ b: live(4, null, 5) }, { b: { version: null, stamp: null } }, 6);
    expect(merged.b).toMatchObject({ version: null, seq: 6 });
  });

  it('marks a reference unverified when a newer read fails, and clears it on the next good read', () => {
    const failed = mergeReferenceSnapshots({ b: live(3, null, 5) }, { b: undefined }, 6);
    expect(failed.b).toMatchObject({ version: 3, unverified: true });
    // A failed read that started before the live state says nothing about it.
    expect(mergeReferenceSnapshots({ b: live(3, null, 5) }, { b: undefined }, 4).b).toMatchObject({ unverified: false });
    const recovered = mergeReferenceSnapshots(failed, { b: { version: 3, stamp: null } }, 7);
    expect(recovered.b).toMatchObject({ version: 3, unverified: false });
  });

  it('takes a newer read, and drops references the segment no longer uses', () => {
    const merged = mergeReferenceSnapshots({ a: live(1, null, 1), gone: live(2, null, 1) }, { a: { version: 2, stamp: null } }, 2);
    expect(Object.keys(merged)).toEqual(['a']);
    expect(merged.a).toMatchObject({ version: 2 });
  });
});

describe('useFocusRecheck clock (0.14.13 review round 4)', () => {
  it('uses a monotonic clock, so a wall-clock rollback cannot suppress the next return', () => {
    const recheck = vi.fn();
    let wall = 10_000;
    let mono = 100;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => mono);
    renderHook(() => useFocusRecheck(recheck));
    act(() => window.dispatchEvent(new Event('focus')));
    wall = 5_000; // the system clock is set back
    mono += 2_000; // real time moves on
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(recheck).toHaveBeenCalledTimes(2);
    dateSpy.mockRestore();
    perfSpy.mockRestore();
  });
});
