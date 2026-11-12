import { act } from '@testing-library/react';

/** A promise a test resolves by hand, so a read can be held pending across a key change. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolve a held read and let React commit the result. */
export async function settle<T>(read: Deferred<T>, value: T) {
  await act(async () => {
    read.resolve(value);
    await read.promise;
  });
}
