import type { SmsTemplate } from '@agentic-marketing/artifacts';
import { describe, expect, it } from 'vitest';
import { classifySmsReply, normalizeSmsText } from '../src/sms/keywords';
import { renderSms, STOP_FOOTER } from '../src/sms/render';

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

  it('treats a strong stop word anywhere in a long reply as a stop', () => {
    // Accepted behaviour: a false opt-out is recoverable, a missed one is not.
    for (const body of [
      "Don't stop the music, it's great",
      'Please stop sending me these messages right now',
      'Stop by our store this weekend',
    ]) {
      expect(classifySmsReply(body), body).toMatchObject({ intent: 'stop' });
    }
  });

  it('keeps weak stop words to the whole message, the first word, or a short message', () => {
    expect(classifySmsReply('I want to cancel my order please thanks')).toBeNull();
    expect(classifySmsReply('CANCEL')).toMatchObject({ intent: 'stop' });
    expect(classifySmsReply('Cancel my order')).toMatchObject({ intent: 'stop' });
  });

  it.each(['STOP sending me these messages please', 'unsubscribe me from this list right now please'])(
    'treats a long message that starts with a stop keyword (%j) as a stop',
    (body) => expect(classifySmsReply(body)).toMatchObject({ intent: 'stop' }),
  );
});
