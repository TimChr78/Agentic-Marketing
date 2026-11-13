import { describe, expect, it } from 'vitest';
import { evalJsonata, journeyErrorText } from '../src/runtime';

// #885 round 6: a journey's transform, webhook data, action input and condition are the workspace's
// own JSONata. `$error("password=…")` and a condition-service exception used to land verbatim in a
// participant's `error` and in the journey detail/context a person reads.

describe('journey failure text (#885)', () => {
  it('redacts a credential in a JSONata $error before it is stored', async () => {
    const err = await evalJsonata('$error("password=probe-secret")', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('probe-secret');
    expect((err as Error).message).toContain('password=');
  });

  it('keeps the expression useful while removing a token it quoted', async () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    const err = await evalJsonata(`$error("bad ${token}")`, {}).catch((e: unknown) => e);
    expect((err as Error).message).toContain('bad');
    expect((err as Error).message).not.toContain('a1b2c3d4e5f60718');
  });

  it('redacts a condition-service exception, then cuts it', () => {
    const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
    const text = journeyErrorText(new Error(`condition service failed: ${' '.repeat(470)}${token}`));
    expect(text).toContain('condition service failed');
    expect(text).not.toContain('a1b2c3d4e5f60718');
    expect(text.length).toBeLessThanOrEqual(500);
  });
});
