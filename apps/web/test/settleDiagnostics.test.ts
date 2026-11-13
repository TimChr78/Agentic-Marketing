import { describe, expect, it } from 'vitest';
// @ts-expect-error - e2e/matrix.mjs is plain ESM with no type declarations; settle() is pure enough to drive with a stub.
import { describeSettleState, settle } from '../../../e2e/matrix.mjs';

// #732: a settle() timeout used to say only that 20 s elapsed. The message must name the condition
// still pending and the skeletons, images or editors that never finished, because those tests run
// in a container without the page to look at.

const clean = { main: true, skeletons: [], images: [], fonts: 'loaded', gjs: [], flows: [] };

/** A page whose nth waitForFunction times out, exactly as Playwright's does on CI. */
function stubPage(failAt: number, state: unknown) {
  let waits = 0;
  return {
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    waitForFunction: async () => {
      waits += 1;
      if (waits === failAt) throw new Error('page.waitForFunction: Timeout 20000ms exceeded');
    },
    evaluate: async (fn: { name: string }) => (fn.name === 'settleState' ? state : undefined),
  } as never;
}

describe('settle() timeout diagnostics (#732)', () => {
  it('names the main landmark when the shell has not painted', async () => {
    await expect(settle(stubPage(1, { ...clean, main: false }))).rejects.toThrow(
      /timed out waiting for the main landmark.*main landmark.*has not painted/,
    );
  });

  it('names the remaining skeleton selectors and the region they sit in', async () => {
    const state = {
      ...clean,
      skeletons: [{ selector: 'span.am-skeleton.block.h-\\[420px\\][data-skeleton-shape="editor"]', region: 'Loading the journey graph' }],
    };
    await expect(settle(stubPage(2, state))).rejects.toThrow(/the skeletons to clear.*span\.am-skeleton.*Loading the journey graph/);
  });

  it('names the on-screen images that are not complete, with their src', async () => {
    const state = { ...clean, images: [{ src: 'https://example.test/hero.png', loading: 'eager' }] };
    await expect(settle(stubPage(3, state))).rejects.toThrow(/on-screen image\(s\) not complete: https:\/\/example\.test\/hero\.png/);
  });

  it('names an e-mail editor that never became ready', async () => {
    const state = { ...clean, gjs: ['email-editor'] };
    await expect(settle(stubPage(4, state))).rejects.toThrow(/the e-mail editor to be ready.*not ready: email-editor/);
  });

  it('settles when every condition is met', async () => {
    await expect(settle(stubPage(0, clean))).resolves.toBeUndefined();
  });

  it('says when nothing is pending', () => {
    expect(describeSettleState(clean)).toBe('nothing is pending');
  });
});
