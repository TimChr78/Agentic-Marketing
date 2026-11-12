import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useApi, useKeyedApi } from '../src/app/useApi';
import { deferred } from './keyedReadsSupport';

// The 0.14.6 fix must not change `useApi`: a same-thing refresh keeps its data and reports
// `refreshing`, and only `useKeyedApi` withholds data when the selection changes.

describe('useApi and useKeyedApi keep their separate contracts', () => {
  it('keeps the previous data while the same read is refreshed', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;
    const read = () => (++call === 1 ? first.promise : second.promise);

    const { result } = renderHook(() => useApi(read, []));
    await act(async () => {
      first.resolve('one');
      await first.promise;
    });
    await waitFor(() => expect(result.current.data).toBe('one'));

    act(() => {
      void result.current.reload();
    });
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    // A refresh is not a new thing: the old value stays, and it is not reported as a first load.
    expect(result.current.data).toBe('one');
    expect(result.current.loading).toBe(false);

    await act(async () => {
      second.resolve('two');
      await second.promise;
    });
    await waitFor(() => expect(result.current.data).toBe('two'));
  });

  it('withholds the previous data when the key changes', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const { result, rerender } = renderHook(({ key }: { key: string }) => useKeyedApi(key, () => (key === 'a' ? a.promise : b.promise)), {
      initialProps: { key: 'a' },
    });

    await act(async () => {
      a.resolve('A');
      await a.promise;
    });
    await waitFor(() => expect(result.current.data).toBe('A'));
    expect(result.current.loading).toBe(false);

    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.data).toBeUndefined();

    await act(async () => {
      b.resolve('B');
      await b.promise;
    });
    await waitFor(() => expect(result.current.data).toBe('B'));
  });
});
