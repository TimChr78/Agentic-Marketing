import { describe, expect, it } from 'vitest';
import { localKeyProvider, newDataKey, open, seal } from '../src/keys';

const kp = localKeyProvider(Buffer.alloc(32, 1).toString('base64'));

describe('envelope encryption', () => {
  it('wraps and unwraps data keys, and seals values with them', async () => {
    const dk = newDataKey();
    const wrapped = await kp.wrap(dk);
    expect(wrapped.includes(dk)).toBe(false);
    expect(await kp.unwrap(wrapped)).toEqual(dk);
    const sealed = seal(dk, Buffer.from('sk-secret'));
    expect(open(dk, sealed).toString()).toBe('sk-secret');
  });

  it('detects tampering', () => {
    const dk = newDataKey();
    const sealed = seal(dk, Buffer.from('sk-secret'));
    sealed.ciphertext[0] ^= 1;
    expect(() => open(dk, sealed)).toThrow();
  });

  it('refuses a KEK of the wrong size', () => {
    expect(() => localKeyProvider(Buffer.alloc(16).toString('base64'))).toThrow(/32 random bytes/);
  });
});
