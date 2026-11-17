import { useStore } from '@xyflow/react';

/**
 * Whether the journey canvas has finished measuring its nodes.
 *
 * React Flow measures each node with a ResizeObserver and keeps the wrapper `visibility: hidden`
 * until it has a width and height. E2E used to poll that computed style, which cannot tell "not
 * measured yet" from "never measured". This reads React Flow's own measurement instead, and the
 * canvas mirrors it as `data-journey-ready` for `settle()` (#990).
 *
 * `true` for an empty canvas: there is nothing to measure, and the builder shows an empty state.
 */
export function useCanvasReady(): boolean {
  return useStore((state) => {
    if (state.nodeLookup.size === 0) return true;
    for (const node of state.nodeLookup.values()) {
      if (!node.measured.width || !node.measured.height) return false;
    }
    return true;
  });
}
