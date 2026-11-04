import { describe, expect, it } from 'vitest';
import {
  addedHashes,
  destinationKeyOf,
  LEGACY_DESTINATION_KEY,
  obsoleteHashes,
  planMemberWrite,
  remoteTargetKeyOf,
  sameHashes,
} from '../src';

// #400/#401: the audience ledger keeps what was uploaded and compares it with what the current
// profile and artifact would upload. These helpers decide the remote remove/add pair.
describe('audience destination provenance', () => {
  const ref = {
    platform: 'google' as const,
    connectionId: 'con_a',
    destinationId: '700001',
    operatingAccountId: '1111111111',
    loginAccountId: null,
  };

  it('keeps destination identity separate per connection and audience/list', () => {
    expect(destinationKeyOf(ref)).not.toBe(destinationKeyOf({ ...ref, connectionId: 'con_b' }));
    expect(destinationKeyOf(ref)).not.toBe(destinationKeyOf({ ...ref, destinationId: '700002' }));
    expect(destinationKeyOf(ref)).toBe(destinationKeyOf({ ...ref }));
    expect(LEGACY_DESTINATION_KEY).toBe('legacy:unknown');
  });

  it('includes the immutable operating account, not only the mutable connection ref', () => {
    // Changing a Google connection's customerId must produce a different destination: a cleanup
    // against the new account must never be reported as cleaning the old account's list.
    expect(destinationKeyOf(ref)).not.toBe(destinationKeyOf({ ...ref, operatingAccountId: '2222222222' }));
    expect(destinationKeyOf(ref)).not.toBe(destinationKeyOf({ ...ref, loginAccountId: '9999999999' }));
    expect(destinationKeyOf({ ...ref, platform: 'meta', operatingAccountId: 'act_123', loginAccountId: null })).toContain(
      'meta:con_a:act_123:',
    );
  });

  it('treats two connections to the same operating account/list as one remote target', () => {
    // Ownership and target locks must cover two connections that reach the same account/list,
    // while provenance still keeps the connection for credential-aware cleanup.
    expect(remoteTargetKeyOf(ref)).toBe(remoteTargetKeyOf({ ...ref, connectionId: 'con_b' }));
    expect(remoteTargetKeyOf(ref)).not.toBe(remoteTargetKeyOf({ ...ref, operatingAccountId: '2222222222' }));
    expect(remoteTargetKeyOf(ref)).not.toBe(destinationKeyOf({ ...ref, connectionId: 'con_b' }));
  });
});

describe('audience identifier reconciliation', () => {
  it('treats a missing identifier and an absent one as the same state', () => {
    expect(sameHashes({ email: 'e1' }, { email: 'e1' })).toBe(true);
    expect(sameHashes({ email: 'e1' }, { email: 'e1', phone: undefined })).toBe(true);
    expect(sameHashes({ email: 'e1' }, { email: 'e2' })).toBe(false);
    expect(sameHashes({ email: 'e1', phone: 'p1' }, { email: 'e1' })).toBe(false);
  });

  it('removes the old e-mail and adds the new one when it changed', () => {
    expect(obsoleteHashes({ email: 'e1', phone: 'p1' }, { email: 'e2', phone: 'p1' })).toEqual({ email: 'e1' });
    expect(addedHashes({ email: 'e1', phone: 'p1' }, { email: 'e2', phone: 'p1' })).toEqual({ email: 'e2' });
  });

  it('removes an identifier type the artifact no longer allows', () => {
    expect(obsoleteHashes({ email: 'e1', phone: 'p1' }, { phone: 'p1' })).toEqual({ email: 'e1' });
    expect(addedHashes({ email: 'e1', phone: 'p1' }, { phone: 'p1' })).toEqual({});
  });

  it('adds a newly available identifier without removing the unchanged one', () => {
    expect(obsoleteHashes({ email: 'e1' }, { email: 'e1', phone: 'p1' })).toEqual({});
    expect(addedHashes({ email: 'e1' }, { email: 'e1', phone: 'p1' })).toEqual({ phone: 'p1' });
  });

  it('has nothing to change when the stored and current hashes agree', () => {
    expect(obsoleteHashes({ email: 'e1', phone: 'p1' }, { email: 'e1', phone: 'p1' })).toEqual({});
    expect(addedHashes({ email: 'e1', phone: 'p1' }, { email: 'e1', phone: 'p1' })).toEqual({});
    expect(
      planMemberWrite({ profileId: 'prf_1', stored: { email: 'e1', phone: 'p1' }, current: { email: 'e1', phone: 'p1' }, intent: null }),
    ).toBeNull();
  });

  it('removes every stored identifier when the person has nothing matchable left', () => {
    expect(obsoleteHashes({ email: 'e1', phone: 'p1' }, {})).toEqual({ email: 'e1', phone: 'p1' });
    expect(addedHashes({ email: 'e1', phone: 'p1' }, {})).toEqual({});
  });
});

describe('member-level remove then full restore (#401 P1)', () => {
  it('re-adds the full current set when a removed identifier type leaves the person in place', () => {
    // Meta/Google remove a member/user, not one identifier key. Removing the e-mail also removes
    // the phone, so the unchanged phone must be uploaded again.
    expect(planMemberWrite({ profileId: 'prf_1', stored: { email: 'e1', phone: 'p1' }, current: { phone: 'p1' }, intent: null })).toEqual({
      profileId: 'prf_1',
      remove: [{ email: 'e1' }],
      add: { phone: 'p1' },
      final: { phone: 'p1' },
    });
  });

  it('re-adds the full current set after an e-mail change', () => {
    expect(
      planMemberWrite({ profileId: 'prf_1', stored: { email: 'e1', phone: 'p1' }, current: { email: 'e2', phone: 'p1' }, intent: null }),
    ).toEqual({
      profileId: 'prf_1',
      remove: [{ email: 'e1' }],
      add: { email: 'e2', phone: 'p1' },
      final: { email: 'e2', phone: 'p1' },
    });
  });

  it('only uploads the new identifier when nothing is removed', () => {
    expect(planMemberWrite({ profileId: 'prf_1', stored: { email: 'e1' }, current: { email: 'e1', phone: 'p1' }, intent: null })).toEqual({
      profileId: 'prf_1',
      remove: [],
      add: { phone: 'p1' },
      final: { email: 'e1', phone: 'p1' },
    });
  });
});

describe('durable intent recovery', () => {
  it('re-adds the current set after an ambiguous add that is not in the ledger', () => {
    expect(planMemberWrite({ profileId: 'prf_1', stored: null, current: { email: 'e1' }, intent: { email: 'e1' } })).toEqual({
      profileId: 'prf_1',
      remove: [],
      add: { email: 'e1' },
      final: { email: 'e1' },
    });
  });

  it('removes an old intent hash before uploading a changed one', () => {
    expect(planMemberWrite({ profileId: 'prf_1', stored: null, current: { email: 'e2' }, intent: { email: 'e1' } })).toEqual({
      profileId: 'prf_1',
      remove: [{ email: 'e1' }],
      add: { email: 'e2' },
      final: { email: 'e2' },
    });
  });

  it('removes both the ledger hash and an intent hash when the person is erased', () => {
    expect(planMemberWrite({ profileId: 'prf_1', stored: { email: 'e1' }, current: null, intent: { email: 'e2' } })).toEqual({
      profileId: 'prf_1',
      remove: [{ email: 'e1' }, { email: 'e2' }],
      add: null,
      final: null,
    });
  });

  it('does not duplicate identical remove sets', () => {
    expect(planMemberWrite({ profileId: 'prf_1', stored: { email: 'e1' }, current: null, intent: { email: 'e1' } })).toEqual({
      profileId: 'prf_1',
      remove: [{ email: 'e1' }],
      add: null,
      final: null,
    });
  });
});
