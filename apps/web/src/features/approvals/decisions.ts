import type { Out } from '../../app/api';

type Approval = Out<'approvals.list'>['approvals'][number];

/**
 * A bundle (#107) is one decision, so it is one row: the member the others exist for (the last
 * member, as the server orders them) stands for it. Grouping is by bundle id, not by whether the
 * lead is on this page: a page can contain only earlier members of a bundle whose lead is outside
 * it, and every one of them must still collapse into one row (#483). When the lead is not loaded,
 * the loaded member latest in the server's publish order stands for the bundle.
 */
export function approvalDecisions(approvals: Approval[]): Approval[] {
  const representative = new Map<string, { id: string; rank: number }>();
  for (const a of approvals) {
    if (!a.bundle) continue;
    const rank = a.bundle.members.findIndex((m) => m.approvalId === a.id);
    const current = representative.get(a.bundle.id);
    if (!current || rank > current.rank) representative.set(a.bundle.id, { id: a.id, rank });
  }
  return approvals.filter((a) => !a.bundle || representative.get(a.bundle.id)?.id === a.id);
}

/** How many decisions the loaded rows represent: one per bundle, one per standalone request. */
export function pendingDecisionCount(approvals: Approval[]): number {
  return approvalDecisions(approvals).length;
}
