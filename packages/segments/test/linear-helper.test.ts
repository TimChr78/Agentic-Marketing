import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';

// The helper re-measures before failing a ratio; a genuinely quadratic path must still fail it.
describe('expectLinear', () => {
  it('still fails quadratic work after re-measuring', () => {
    const quadratic = (input: string) => {
      let n = 0;
      for (let i = 0; i < input.length; i++) for (let j = 0; j < input.length; j += 1) n += j;
      return n;
    };
    expect(() => expectLinear((n) => 'x'.repeat(n), quadratic, 2_000)).toThrow(/expected linear scaling/);
  });

  it('passes linear work', () => {
    expectLinear(
      (n) => 'x'.repeat(n),
      (input) => input.split('').length,
      200_000,
    );
  });
});
