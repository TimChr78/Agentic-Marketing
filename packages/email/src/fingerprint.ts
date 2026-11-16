/**
 * The parts of every send's request fingerprint (#926), one builder per source (#948).
 *
 * A fingerprint is `sendRequestHash(channel, fingerprintParts.<source>(…))`: it names the request
 * as the caller supplied it, before any resolution, so a retry replays and a different request
 * answers `409`. The builders are the only place those fields are written, and
 * `fingerprintFields` below is the published field list; `packages/email/test/fingerprint.test.ts`
 * keeps the two equal, so the documentation cannot drift from the shipped hashes again.
 */
export const fingerprintParts = {
  /** A direct send (`messages.sendEmail`, `sendSms`, `sendPush`): what the caller asked for. */
  direct: (p: { caller: string; recipient: string; template: string; data: Record<string, unknown> | null }) => ({
    caller: p.caller,
    recipient: p.recipient,
    template: p.template,
    data: p.data,
  }),
  /** A double opt-in confirmation: the submission and the form version that produced it. */
  doi: (p: { submission: string; form: string; formVersion: number; template: string }) => ({
    caller: 'system:doi',
    submission: p.submission,
    form: p.form,
    formVersion: p.formVersion,
    template: p.template,
  }),
  /** A journey step: the participant (enrollment), the pinned node and its sequence, never the profile. */
  journey: (p: { journey: string; enrollment: number; step: string; sequence: number }) => ({
    caller: 'system:journey',
    journey: p.journey,
    enrollment: p.enrollment,
    step: p.step,
    sequence: p.sequence,
  }),
  /** A broadcast send: the broadcast and the recipient the audience lists. */
  broadcast: (p: { recipient: string; broadcast: string }) => ({
    caller: 'system:broadcast',
    recipient: p.recipient,
    broadcast: p.broadcast,
  }),
  /** A holdout-control suppression: the same recipient, plus the campaign that holds them out. */
  broadcastControl: (p: { recipient: string; broadcast: string; campaign: string }) => ({
    caller: 'system:broadcast_holdout',
    recipient: p.recipient,
    broadcast: p.broadcast,
    campaign: p.campaign,
  }),
  /** A test send: the address hash and the template, never a profile. */
  test: (p: { recipient: string; template: string }) => ({
    caller: 'system:test',
    recipient: p.recipient,
    template: p.template,
  }),
  /** A transactional alert e-mail: the member's stable user id and the notification's own key. */
  alert: (p: { recipient: string; key: string }) => ({
    caller: 'system:alert',
    recipient: p.recipient,
    key: p.key,
  }),
} as const;

/**
 * What each fingerprint binds, in the builders' order. This list is the documentation: the
 * fingerprint test fails when it and a builder disagree, so neither can change alone.
 */
export const fingerprintFields: Record<keyof typeof fingerprintParts, readonly string[]> = {
  direct: ['caller', 'recipient', 'template', 'data'],
  doi: ['caller', 'submission', 'form', 'formVersion', 'template'],
  journey: ['caller', 'journey', 'enrollment', 'step', 'sequence'],
  broadcast: ['caller', 'recipient', 'broadcast'],
  broadcastControl: ['caller', 'recipient', 'broadcast', 'campaign'],
  test: ['caller', 'recipient', 'template'],
  alert: ['caller', 'recipient', 'key'],
};
