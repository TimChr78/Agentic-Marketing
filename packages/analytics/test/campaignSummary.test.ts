import { describe, expect, it } from 'vitest';
import { campaignNotStarted, planMemberSuppression, summaryWindow } from '../src/campaignSummary';

// #747: a campaign whose recorded start is after the requested `to` has no sends in that window,
// whether or not it has sent later. The default `from` must become an empty window instead of the
// reversed-window error the handler raises for an explicit from > to.

const NOW = '2026-12-10T00:00:00.000Z';
const TO = '2026-11-30T00:00:00.000Z';
const STARTS_AT = '2026-12-01T00:00:00.000Z';

describe('campaign summary window (#747)', () => {
  it('returns an empty window when the campaign start is after the requested to', () => {
    expect(summaryWindow({ to: TO, startsAt: STARTS_AT }, NOW, { allowFutureStart: false })).toEqual({
      from: TO,
      to: TO,
      clamped: false,
    });
  });

  it('does not depend on the allowFutureStart hint for a start after to', () => {
    expect(summaryWindow({ to: TO, startsAt: STARTS_AT }, NOW, { allowFutureStart: true })).toEqual({
      from: TO,
      to: TO,
      clamped: false,
    });
  });

  it('keeps the normal default window when the campaign did start before to', () => {
    expect(summaryWindow({ to: TO, startsAt: '2026-11-01T00:00:00.000Z' }, NOW)).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: TO,
      clamped: false,
    });
  });

  it('still rejects an explicit from after to', () => {
    expect(() => summaryWindow({ from: '2026-12-02T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', startsAt: STARTS_AT }, NOW)).toThrow(
      /from must be before to/,
    );
  });

  it('accepts an explicit from equal to to', () => {
    expect(summaryWindow({ from: TO, to: TO, startsAt: STARTS_AT }, NOW)).toEqual({ from: TO, to: TO, clamped: false });
  });
});

describe('readiness and the default window follow real sends (0.14.10 review)', () => {
  it('is not "not started" when the campaign sent inside an explicit window before its planned start', () => {
    // Sent on 1 November, startsAt edited to 10 November, queried for 1–5 November.
    expect(
      campaignNotStarted({ published: true, sendingMembers: 1, firstSendAt: '2026-11-01T09:00:00.000Z', to: '2026-11-05T00:00:00.000Z' }),
    ).toBe(false);
  });

  it('is "not started" when nothing was sent on or before to', () => {
    expect(
      campaignNotStarted({ published: true, sendingMembers: 1, firstSendAt: '2026-12-02T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' }),
    ).toBe(true);
    expect(campaignNotStarted({ published: true, sendingMembers: 1, firstSendAt: null, to: '2026-11-30T00:00:00.000Z' })).toBe(true);
    expect(
      campaignNotStarted({ published: false, sendingMembers: 1, firstSendAt: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' }),
    ).toBe(true);
  });

  it('starts the default window at the first send when it precedes the planned start', () => {
    expect(
      summaryWindow(
        { to: '2026-11-05T00:00:00.000Z', startsAt: '2026-11-10T00:00:00.000Z', firstSendAt: '2026-11-01T09:00:00.000Z' },
        '2026-11-20T00:00:00.000Z',
      ),
    ).toEqual({ from: '2026-11-01T09:00:00.000Z', to: '2026-11-05T00:00:00.000Z', clamped: false });
  });
});

// #692 round 2: the member rows are a breakdown under every headline total, not under one flat
// list. A member that never sent has no row and is a visible zero; a member with a row below k is
// hidden. Hiding one row hides every figure, so each total sees the same hidden members.
const member = (reached: number, over: Partial<Parameters<typeof planMemberSuppression>[0][number]> = {}) => ({
  hasRow: true,
  reached,
  sent: reached,
  delivered: reached,
  clicked: 1,
  unsubscribed: 0,
  converters: 1,
  ...over,
});
const absent = member(0, { hasRow: false, sent: 0, delivered: 0, clicked: 0, converters: 0 });

describe('per-total member suppression (#692 round 2)', () => {
  it('hides the smallest visible member beside a single below-k member', () => {
    const plan = planMemberSuppression([member(4), member(6)]);
    expect(plan.hidden).toEqual([true, true]);
    expect(plan.complementary).toBe(true);
    expect(plan.withheld).toEqual([]);
  });

  it('does not let a hidden member that contributes nothing to a total protect it (round 3)', () => {
    // A (3, e-mail) is below k; B (5, SMS only) becomes the people total's complement; C (10,
    // e-mail) stays visible. B sent no e-mail, so the e-mail total 13 minus C's 10 would reveal A.
    const plan = planMemberSuppression([
      member(3),
      member(5, { sent: 0, delivered: 0, clicked: 0, unsubscribed: 0, converters: 0 }),
      member(10),
    ]);
    const sentProtected = plan.hidden[2] === true || plan.withheld.includes('email.sent');
    expect(sentProtected).toBe(true);
  });

  it('treats a member with in-window e-mail activity but no in-window sends as an e-mail contributor (round 4)', () => {
    // A's sends happened before `from`, but its deliveries fall inside the window: sent 0,
    // delivered 3. A (3) is below k; B (5, SMS only) is the people total's complement; C (10) stays
    // visible. The delivered total 13 minus C's 10 would reveal A unless A still counts as hidden
    // in the e-mail totals.
    const plan = planMemberSuppression([
      member(3, { sent: 0, delivered: 3 }),
      member(5, { sent: 0, delivered: 0, clicked: 0, unsubscribed: 0, converters: 0 }),
      member(10),
    ]);
    const deliveredProtected = plan.hidden[2] === true || plan.withheld.includes('email.delivered');
    expect(deliveredProtected).toBe(true);
  });

  it('withholds a total whose only visible member is a zero', () => {
    // The issue's probe: one member reaches four, the other never sent. Hiding the zero member
    // would change nothing and the total of four would still give the hidden member, so the
    // recipients total is withheld. The other headline totals have the same shape here.
    const plan = planMemberSuppression([member(4), absent]);
    expect(plan.hidden).toEqual([true, false]);
    expect(plan.complementary).toBe(false);
    expect(plan.withheld).toContain('recipients');
    expect(plan.withheld).toContain('email.sent');
  });

  it('keeps the totals when no member is hidden', () => {
    const plan = planMemberSuppression([member(6), member(10)]);
    expect(plan.hidden).toEqual([false, false]);
    expect(plan.withheld).toEqual([]);
  });

  it('treats a member with a row but nobody reached as below k', () => {
    // A row exists (the member sent, but no profile survived), so it is hidden like any group of
    // zero; the visible 10 can be hidden to protect it.
    // Nobody reached means no e-mail figure either (each counts reached people).
    const plan = planMemberSuppression([member(0, { clicked: 0 }), member(10)]);
    expect(plan.hidden).toEqual([true, true]);
    // The zero member has no e-mail activity, so it cannot protect the e-mail totals: with the 10 hidden as
    // the people total's complement, each e-mail total would equal the 10's own figure and is
    // withheld instead (round 3).
    expect(plan.withheld).toEqual(['email.sent', 'email.delivered', 'email.clicked', 'email.unsubscribed']);
  });
});
