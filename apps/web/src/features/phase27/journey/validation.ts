import type { DraftWarning } from '../../artifacts/ArtifactDetailPage';

/** "1 issue" / "2 issues": the count shown on a step, the Check tab and the Check panel. */
export function issueLabel(count: number): string {
  return `${count} ${count === 1 ? 'issue' : 'issues'}`;
}

/**
 * Draft warnings without a step belong to the journey as a whole (a purpose, a missing trigger or
 * another graph-level rule). They stay in Check as a linked list without a node; they are never
 * attached to an arbitrary step. Server order and duplicates are preserved once.
 */
export function graphWarnings(warnings: Pick<DraftWarning, 'nodeId' | 'message'>[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const warning of warnings) {
    if (warning.nodeId) continue;
    if (seen.has(warning.message)) continue;
    seen.add(warning.message);
    out.push(warning.message);
  }
  return out;
}

/** Total number of issues: every node issue once plus each graph-level message. */
export function issueTotal(byNode: Record<string, string[]>, graph: string[]): number {
  return Object.values(byNode).reduce((sum, messages) => sum + messages.length, 0) + graph.length;
}

const UNREACHABLE = /^Not reachable from the trigger/;

/**
 * The one line a step shows under its count. Field issues keep their existing check message; an
 * unreachable step gets a plain "not connected" line instead, because repeating "the trigger" on
 * every disconnected step reads as if the step were a trigger. The Check panel keeps the exact
 * message for both.
 */
export function nodeIssueText(messages: string[]): string {
  const first = messages[0] ?? '';
  return UNREACHABLE.test(first) ? 'Not connected to the start yet.' : first;
}
