import { describe, expect, it } from 'vitest';
import { approvalDecisions, pendingDecisionCount } from '../src/features/approvals/decisions';

// #483: the nav badge and the Approvals page count decisions, not rows. A two-member bundle is one
// decision, exactly as the list groups it.

type Approval = Parameters<typeof approvalDecisions>[0][number];

function row(id: string, bundle?: { id: string; members: { approvalId: string; artifactId: string }[] }): Approval {
  return {
    id,
    artifactId: `bct_${'a'.repeat(32)}`,
    artifactName: `Change ${id}`,
    artifactType: 'broadcast',
    version: 1,
    status: 'pending',
    requestedAt: '2026-11-06T09:00:00.000Z',
    requestedBy: null,
    holdUntil: null,
    ...(bundle ? { bundle: { ...bundle, members: bundle.members.map((m) => ({ ...m })) } } : {}),
  } as unknown as Approval;
}

describe('approval decisions (#483)', () => {
  it('counts a two-member bundle once and a standalone request once', () => {
    const standalone = row('apr_standalone');
    const member = row('apr_member');
    const lead = row('apr_lead');
    const bundle = {
      id: 'bnd_1',
      members: [
        { approvalId: member.id, artifactId: 'bct_1' },
        { approvalId: lead.id, artifactId: 'bct_2' },
      ],
    };
    const rows = [standalone, { ...member, bundle }, { ...lead, bundle }] as Approval[];

    expect(approvalDecisions(rows).map((a) => a.id)).toEqual([standalone.id, lead.id]);
    expect(pendingDecisionCount(rows)).toBe(2);
  });

  it('keeps a bundle member that arrived without its lead on this page', () => {
    const rowIds = ['apr_a', 'apr_b'];
    const rows = rowIds.map((id) =>
      row(id, {
        id: 'bnd_1',
        members: [
          { approvalId: 'apr_a', artifactId: 'bct_1' },
          { approvalId: 'apr_b', artifactId: 'bct_2' },
        ],
      }),
    );

    // Both members are present: the lead (the last member) stands for the bundle.
    expect(pendingDecisionCount(rows)).toBe(1);
    // Only the last member is loaded: it is still one visible decision, not zero.
    expect(pendingDecisionCount([rows[1]!])).toBe(1);
  });

  it('collapses loaded members whose lead is outside the page into one decision (#483)', () => {
    const bundle = {
      id: 'bnd_2',
      members: [
        { approvalId: 'apr_a', artifactId: 'bct_1' },
        { approvalId: 'apr_b', artifactId: 'bct_2' },
        { approvalId: 'apr_lead', artifactId: 'bct_3' },
      ],
    };
    const first = row('apr_a', bundle);
    const second = row('apr_b', bundle);
    // The lead (apr_lead) is on the next page: both loaded members still represent the same bundle.
    const decisions = approvalDecisions([first, second]);
    expect(decisions.map((a) => a.id)).toEqual(['apr_b']);
    expect(pendingDecisionCount([first, second])).toBe(1);
  });

  it('counts plain requests with no bundle as one decision each', () => {
    expect(pendingDecisionCount([row('apr_1'), row('apr_2'), row('apr_3')])).toBe(3);
    expect(pendingDecisionCount([])).toBe(0);
  });
});
