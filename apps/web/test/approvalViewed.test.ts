import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decisionWasViewed, markViewed, wasViewed } from '../src/features/approvals/viewed';

// #498: viewing is per person, per approval request and per exact version. A bundle counts only
// when every member's exact version was opened; a newer version must ask for a fresh review.

describe('approval viewed state (#41, #498)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('pins the mark to the person, request and exact version', () => {
    markViewed('usr_1', 'apr_1', 4);
    expect(wasViewed('usr_1', 'apr_1', 4)).toBe(true);
    expect(wasViewed('usr_1', 'apr_1', 5)).toBe(false);
    expect(wasViewed('usr_2', 'apr_1', 4)).toBe(false);
    expect(wasViewed('usr_1', 'apr_2', 4)).toBe(false);
  });

  it('does not write a second time when the same version is opened again', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    markViewed('usr_1', 'apr_1', 4);
    markViewed('usr_1', 'apr_1', 4);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('counts a standalone request once its own version was opened', () => {
    const approval = { id: 'apr_1', version: 3 };
    expect(decisionWasViewed('usr_1', approval)).toBe(false);
    markViewed('usr_1', 'apr_1', 3);
    expect(decisionWasViewed('usr_1', approval)).toBe(true);
    // A newer draft of the same request does not inherit the earlier review.
    expect(decisionWasViewed('usr_1', { id: 'apr_1', version: 4 })).toBe(false);
  });

  it('counts a bundle only when every member’s exact version was opened', () => {
    const bundle = {
      id: 'bnd_1',
      members: [
        { approvalId: 'apr_template', version: 2 },
        { approvalId: 'apr_broadcast', version: 3 },
      ],
    };
    const decision = { id: 'apr_broadcast', version: 3, bundle };
    markViewed('usr_1', 'apr_broadcast', 3);
    expect(decisionWasViewed('usr_1', decision)).toBe(false);
    markViewed('usr_1', 'apr_template', 2);
    expect(decisionWasViewed('usr_1', decision)).toBe(true);
    // A changed member version asks for the review again.
    expect(
      decisionWasViewed('usr_1', {
        ...decision,
        bundle: { ...bundle, members: [{ ...bundle.members[0]!, version: 3 }, bundle.members[1]!] },
      }),
    ).toBe(false);
  });

  it('keeps one person’s review from marking it viewed for someone else', () => {
    markViewed('usr_1', 'apr_1', 1);
    expect(decisionWasViewed('usr_1', { id: 'apr_1', version: 1 })).toBe(true);
    expect(decisionWasViewed('usr_2', { id: 'apr_1', version: 1 })).toBe(false);
  });
});
