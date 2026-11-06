import type { Out } from '../../app/api';

type Approval = Out<'approvals.list'>['approvals'][number];

/**
 * A bundle (#107) is one decision, so it is one row: the member the others exist for (the last
 * member, as the server orders them) stands for it. The Approvals page and the nav badge both use
 * this so their counts cannot disagree (#483).
 */
export function approvalDecisions(approvals: Approval[]): Approval[] {
  return approvals.filter((a) => {
    const lead = a.bundle?.members.at(-1)?.approvalId;
    return !lead || lead === a.id || !approvals.some((x) => x.id === lead);
  });
}

/** How many decisions the loaded rows represent: one per bundle, one per standalone request. */
export function pendingDecisionCount(approvals: Approval[]): number {
  return approvalDecisions(approvals).length;
}
