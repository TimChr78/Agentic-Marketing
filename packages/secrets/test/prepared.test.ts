import { describe, expect, it } from 'vitest';
import type { KeyProvider } from '../src/keys';
import {
  assertNoProviderCalls,
  isRetryablePreparationError,
  KeysChangedError,
  type PreparedKeys,
  recordingKeyProvider,
  withPreparedKeys,
} from '../src/prepared';

const inner: KeyProvider = {
  id: 'test-kek',
  async wrap() {
    return Buffer.alloc(1);
  },
  async unwrap() {
    return Buffer.alloc(32, 1);
  },
};

function stubPrepared(dispose: () => void): PreparedKeys {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000000',
    purposes: [],
    dataKeyIds: [],
    profileIds: [],
    provider: {
      id: 'test-kek',
      async wrap() {
        throw new Error('unexpected wrap');
      },
      async unwrap() {
        return Buffer.alloc(32, 1);
      },
      dispose,
    },
  };
}

describe('assertNoProviderCalls', () => {
  it('returns the block result when it makes no provider call', async () => {
    const recorder = recordingKeyProvider(inner);
    await expect(assertNoProviderCalls(recorder, async () => 'ok')).resolves.toBe('ok');
  });

  it('fails a successful block that called the provider', async () => {
    const recorder = recordingKeyProvider(inner);
    const error = await assertNoProviderCalls(recorder, async () => {
      await recorder.unwrap(Buffer.alloc(1), 'test-kek');
      return 'ok';
    }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/1 key-provider call/);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('rethrows the original error when a failing block made no provider call', async () => {
    const recorder = recordingKeyProvider(inner);
    const original = new Error('the block failed');
    const error = await assertNoProviderCalls(recorder, async () => {
      throw original;
    }).catch((e) => e);
    expect(error).toBe(original);
  });

  it('reports the calls and keeps the block error as cause when both happen', async () => {
    const recorder = recordingKeyProvider(inner);
    const original = new Error('the block failed');
    const error = await assertNoProviderCalls(recorder, async () => {
      await recorder.wrap(Buffer.alloc(1));
      throw original;
    }).catch((e) => e);
    expect(error).not.toBe(original);
    expect(error.message).toMatch(/1 key-provider call/);
    expect((error as Error & { cause?: unknown }).cause).toBe(original);
  });
});

describe('isRetryablePreparationError', () => {
  it('accepts a changed key, a serialization failure and a deadlock', () => {
    expect(isRetryablePreparationError(new KeysChangedError())).toBe(true);
    expect(isRetryablePreparationError(Object.assign(new Error('serialization'), { code: '40001' }))).toBe(true);
    expect(isRetryablePreparationError(Object.assign(new Error('deadlock'), { code: '40P01' }))).toBe(true);
    expect(isRetryablePreparationError(new Error('something else'))).toBe(false);
  });
});

describe('withPreparedKeys', () => {
  it('disposes the prepared keys after a successful run', async () => {
    let disposed = 0;
    const prepared = stubPrepared(() => {
      disposed++;
    });
    await expect(
      withPreparedKeys(
        async () => prepared,
        async () => 'ok',
      ),
    ).resolves.toBe('ok');
    expect(disposed).toBe(1);
  });

  it('disposes the prepared keys after the retry bound is exhausted', async () => {
    let disposed = 0;
    const prepared = stubPrepared(() => {
      disposed++;
    });
    const error = await withPreparedKeys(
      async () => prepared,
      async () => {
        throw new KeysChangedError();
      },
      { attempts: 2 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(KeysChangedError);
    expect(disposed).toBe(2);
  });

  it('retries a deadlocked preparation within the bound', async () => {
    let attempts = 0;
    let disposed = 0;
    const prepared = stubPrepared(() => {
      disposed++;
    });
    const result = await withPreparedKeys(
      async () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        return prepared;
      },
      async () => 'ok',
      { attempts: 2 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(disposed).toBe(1);
  });

  it('does not retry a non-retryable preparation error', async () => {
    const original = new Error('bad configuration');
    let attempts = 0;
    const error = await withPreparedKeys(
      async () => {
        attempts++;
        throw original;
      },
      async () => 'never',
    ).catch((e) => e);
    expect(error).toBe(original);
    expect(attempts).toBe(1);
  });
});
