import type { SmsTemplate } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { expectLinear } from '../../../test-support/linear';
import { classifySmsReply, normalizeSmsText } from '../src/sms/keywords';
import { hasOptOutInstruction, renderSms, STOP_FOOTER } from '../src/sms/render';

// #635: the outbound footer was skipped whenever the bare word "stop" appeared anywhere in the
// body, so a marketing text about "Stop & Shop" shipped without an opt-out instruction.
// #636: inbound matching only looked at the first whitespace token, verbatim, so "STOP." never
// withdrew consent.

const template = (body: string): SmsTemplate => ({ purpose: 'marketing_sms', body });

describe('marketing SMS opt-out footer (#635)', () => {
  it('keeps the footer when the body merely contains the word stop', async () => {
    for (const body of ["Don't stop reading", 'Visit Stop & Shop today', 'Stop by before the deals end!']) {
      expect((await renderSms(template(body), {}, true)).body).toBe(`${body}${STOP_FOOTER}`);
    }
  });

  it('does not add a second footer when the body already ends with an opt-out instruction', async () => {
    for (const body of [
      'Big sale this week. Reply STOP to opt out',
      'Big sale this week. Text STOP to unsubscribe',
      'Big sale this week. Reply STOP to opt out.',
    ]) {
      const rendered = (await renderSms(template(body), {}, true)).body;
      expect(rendered).toBe(body);
      expect(rendered.match(/\bstop\b/gi) ?? []).toHaveLength(1);
    }
  });

  it('does not add a second footer when standard boilerplate follows the instruction', async () => {
    for (const body of [
      'Big sale this week. Reply STOP to opt out. Msg & data rates may apply.',
      'Big sale this week. Reply STOP to opt out. Msg&data rates may apply',
      'Big sale this week. Text STOP to unsubscribe Msg freq varies',
    ]) {
      const rendered = (await renderSms(template(body), {}, true)).body;
      expect(rendered).toBe(body);
    }
  });

  it('does not add a second footer when boilerplate sits between the instruction and its purpose (#672)', async () => {
    for (const body of [
      'Big sale this week. Reply STOP. Msg & data rates may apply. To opt out',
      'Big sale this week. Text STOP. Msg and data rates may apply. To unsubscribe.',
      'Big sale this week. Reply STOP; Msg freq varies; to opt out.',
      'Big sale this week. Reply STOP. Msg & data rates may apply. Msg freq varies. To opt out.',
    ]) {
      const rendered = (await renderSms(template(body), {}, true)).body;
      expect(rendered, body).toBe(body);
    }
  });

  it('still adds the footer when the parts never form a complete instruction (#672)', async () => {
    for (const body of [
      // No instruction verb and stop keyword: the purpose alone is not an opt-out.
      'Big sale this week. Msg & data rates may apply. To opt out',
      // An instruction verb without a stop keyword is not an instruction.
      'Big sale this week. Reply soon. Msg & data rates may apply. To opt out',
      // An instruction with no purpose after it is not a split instruction.
      'Big sale this week. Msg & data rates may apply. Reply STOP.',
      // The purpose comes before the instruction, not after it.
      'Big sale this week. To opt out, reply STOP.',
    ]) {
      expect((await renderSms(template(body), {}, true)).body, body).toBe(`${body}${STOP_FOOTER}`);
    }
  });

  it('does not duplicate the footer it rendered itself', async () => {
    const once = (await renderSms(template('Big sale this week.'), {}, true)).body;
    expect(once.endsWith(STOP_FOOTER)).toBe(true);
    expect((await renderSms(template(once), {}, true)).body).toBe(once);
  });
});

describe('inbound reply normalisation (#636)', () => {
  it('normalises case, Unicode, punctuation and surrounding emoji', () => {
    expect(normalizeSmsText('  ＳＴＯＰ.  ')).toBe('stop');
    expect(normalizeSmsText('STOP 🙂')).toBe('stop');
    expect(normalizeSmsText('  stop,   please!  ')).toBe('stop, please');
  });

  it.each(['STOP.', 'STOP!', 'stop,', 'UNSUBSCRIBE.', 'Please STOP', 'stop please', '  Stop  ', 'ＳＴＯＰ'])(
    'classifies %j as a stop',
    (body) => expect(classifySmsReply(body)).toMatchObject({ intent: 'stop' }),
  );

  it('lets STOP win when a short message contains both STOP and START', () => {
    expect(classifySmsReply('stop start')).toMatchObject({ intent: 'stop' });
  });

  it('opts back in on an exact START keyword', () => {
    expect(classifySmsReply('START')).toMatchObject({ intent: 'start' });
    expect(classifySmsReply('start.')).toMatchObject({ intent: 'start' });
  });

  it('treats any opt-out keyword anywhere in a long reply as a stop', () => {
    // Accepted behaviour: a false opt-out is recoverable, a missed one is not. The same rule now
    // covers every keyword, so "I want to cancel my order" opts out of marketing SMS too.
    for (const body of [
      "Don't stop the music, it's great",
      'Please stop sending me these messages right now',
      'Stop by our store this weekend',
      'I want to cancel my order please thanks',
      'Please cancel these marketing messages right now',
      'Kan ni avsluta dessa utskick till mig tack',
    ]) {
      expect(classifySmsReply(body), body).toMatchObject({ intent: 'stop' });
    }
  });

  it.each(['STOP,please', 'Please STOP/UNSUBSCRIBE', 'Please stop—sending these messages'])(
    'tokenises punctuation around a keyword in %j',
    (body) => expect(classifySmsReply(body)).toMatchObject({ intent: 'stop' }),
  );

  it('leaves an ordinary reply alone', () => {
    expect(classifySmsReply('Hello there')).toBeNull();
  });
});

describe('trailing carrier boilerplate is stripped in linear time (CodeQL js/redos)', () => {
  it('stays linear on many repeated boilerplate-like clauses', () => {
    expectLinear(
      (n) => `msg${' freq variesmsg'.repeat(n)}!`,
      (body) => hasOptOutInstruction(body),
      5_000,
    );
  });

  it('still recognises a real instruction followed by one or two boilerplate clauses', () => {
    expect(hasOptOutInstruction('Sale today. Reply STOP to opt out. Msg & data rates may apply.')).toBe(true);
    expect(hasOptOutInstruction('Sale today. Reply STOP to opt out. Msg&data rates may apply. Msg freq varies.')).toBe(true);
    expect(hasOptOutInstruction('Stop by before the deals end! Msg & data rates may apply.')).toBe(false);
  });

  it('finds a split instruction with boilerplate in between in linear time (#672)', () => {
    // The repeat sits before the instruction, so the instruction and its purpose stay in the tail
    // window at every size: the same recognised path runs at n and 4n, and the growth is linear.
    expectLinear(
      (n) => `Sale today. ${'Msg & data rates may apply. '.repeat(n)}Reply STOP. Msg & data rates may apply. To opt out`,
      (body) => hasOptOutInstruction(body),
      20_000,
    );
  });
});
