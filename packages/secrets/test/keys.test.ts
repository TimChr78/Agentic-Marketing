import { describe, expect, it } from 'vitest';
import { localKeyProvider, newDataKey, open, seal } from '../src/keys';

const kp = localKeyProvider(Buffer.alloc(32, 1).toString('base64'));

describe('envelope encryption', () => {
  it('wraps and unwraps data keys, and seals values with them', async () => {
    const dk = newDataKey();
    const wrapped = await kp.wrap(dk);
    expect(wrapped.includes(dk)).toBe(false);
    expect(await kp.unwrap(wrapped, kp.id)).toEqual(dk);
    const sealed = seal(dk, Buffer.from('sk-secret'));
    expect(open(dk, sealed).toString()).toBe('sk-secret');
  });

  it('detects tampering', () => {
    const dk = newDataKey();
    const sealed = seal(dk, Buffer.from('sk-secret'));
    sealed.ciphertext[0] ^= 1;
    expect(() => open(dk, sealed)).toThrow();
  });

  it('unwraps with a previous KEK during rotation, and names keys by fingerprint', async () => {
    const oldKey = Buffer.alloc(32, 2).toString('base64');
    const before = localKeyProvider(oldKey);
    const dk = newDataKey();
    const wrapped = await before.wrap(dk);

    const rotated = localKeyProvider(Buffer.alloc(32, 3).toString('base64'), [oldKey]);
    expect(rotated.id).not.toBe(before.id);
    expect(rotated.id).toMatch(/^local-[0-9a-f]{12}$/);
    expect(await rotated.unwrap(wrapped, before.id)).toEqual(dk);
    expect(await rotated.unwrap(await rotated.wrap(dk), rotated.id)).toEqual(dk);

    const withoutPrevious = localKeyProvider(Buffer.alloc(32, 3).toString('base64'));
    await expect(withoutPrevious.unwrap(wrapped, before.id)).rejects.toThrow(/MASTER_KEY_PREVIOUS/);
  });

  it('refuses a KEK of the wrong size', () => {
    expect(() => localKeyProvider(Buffer.alloc(16).toString('base64'))).toThrow(/32 random bytes/);
  });
});
