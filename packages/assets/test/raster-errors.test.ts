import { AppError } from '@agentic-marketing/core';
import { describe, expect, it, vi } from 'vitest';

// #885: rasteriseSvg turned every resvg failure into a user-facing AppError with resvg's text.
// The content problems a person can fix are already AppErrors from sanitiseSvg (not an SVG, no
// drawable content, too many elements, a DOCTYPE); what is left is the renderer failing, which
// propagates so the executor answers and audits it as the sanitised internal failure.
const SECRET = 'driver failure: password=probe-secret';
const state = vi.hoisted(() => ({ failure: null as Error | null }));

vi.mock('@resvg/resvg-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@resvg/resvg-js')>();
  return {
    ...actual,
    Resvg: class extends actual.Resvg {
      render() {
        if (state.failure) throw state.failure;
        return super.render();
      }
    },
  };
});

const { rasteriseSvg } = await import('../src/raster');

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

describe('rasteriseSvg failures (#885)', () => {
  it('lets a renderer failure propagate', () => {
    state.failure = new Error(SECRET);
    try {
      const err = (() => {
        try {
          rasteriseSvg(svg, { width: 10, height: 10 });
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AppError);
      expect(err?.message).toContain('probe-secret');
    } finally {
      state.failure = null;
    }
  });

  it('still rasterises a valid SVG', () => {
    const out = rasteriseSvg(svg, { width: 10, height: 10 });
    expect(out.width).toBeGreaterThan(0);
    expect(out.data.length).toBeGreaterThan(0);
  });
});
