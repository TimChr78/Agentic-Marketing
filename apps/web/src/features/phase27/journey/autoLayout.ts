import { autoLayout } from '../../journey/layout';
import type { JNode } from '../../journey/model';
import { withPositions } from '../../journey/ops';

/**
 * Auto-layout (#528) is a presentation action: it writes positions for every step and leaves the
 * ids, labels, configuration, order and every outgoing edge exactly as saved. Positions live beside
 * the version (see `journey/layout.ts`), so one undo in the builder restores the previous arrangement.
 */
export function autoLayoutNodes(nodes: JNode[]): JNode[] {
  return withPositions(nodes, autoLayout(nodes));
}
