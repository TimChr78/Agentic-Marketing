import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AdapterDeps, DeliveryEvent } from '../adapters/types';

// SMS adapters (Phase 7), the same shape as e-mail's: a transport, status callbacks, and inbound
// messages (STOP, HELP). Pure translation, no database and no policy.

export interface OutgoingSms {
  messageId: string;
  to: string;
  from: string;
  body: string;
  /** Where the provider reports delivery status. */
  statusUrl: string;
}

export interface SmsWebhookRequest {
  /** The public URL the provider called (signatures cover it). */
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface SmsTransport {
  send(msg: OutgoingSms): Promise<{ providerMessageId: string | null; segments?: number }>;
  verifyWebhook(req: SmsWebhookRequest): boolean;
  parseStatus(req: SmsWebhookRequest): DeliveryEvent[];
  parseInbound(req: SmsWebhookRequest): { from: string; body: string } | null;
  /** The HTTP response that answers an inbound message, with an optional reply text. */
  reply(text: string | null): { contentType: string; body: string };
}

export interface SmsAdapter<C extends z.ZodType = z.ZodType, S extends z.ZodType = z.ZodType> {
  id: 'twilio' | 'log';
  label: string;
  config: C;
  secrets: S;
  create(config: z.output<C>, secrets: z.output<S>, deps: AdapterDeps): SmsTransport;
}
const defineSmsAdapter = <C extends z.ZodType, S extends z.ZodType>(a: SmsAdapter<C, S>) => a;

// GSM 03.38: the basic set counts one character, the extension set two; anything else needs UCS-2.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

/** Encoding, length and segments of a text, as carriers count them. */
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number } {
  let gsm = 0;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) gsm += 1;
    else if (GSM_EXTENDED.includes(ch)) gsm += 2;
    else {
      const units = text.length; // UTF-16 code units
      return { encoding: 'UCS-2', length: units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
    }
  }
  return { encoding: 'GSM-7', length: gsm, segments: gsm <= 160 ? 1 : Math.ceil(gsm / 153) };
}

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));
const twiml = (text: string | null) => ({
  contentType: 'text/xml',
  body: `<?xml version="1.0" encoding="UTF-8"?><Response>${
    text ? `<Message>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Message>` : ''
  }</Response>`,
});

/** Twilio's request signature: HMAC-SHA1 over the URL and the sorted form parameters. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

// Twilio Programmable Messaging: https://www.twilio.com/docs/messaging/api/message-resource
export const twilioAdapter = defineSmsAdapter({
  id: 'twilio',
  label: 'Twilio',
  config: z.object({
    accountSid: z.string().regex(/^AC[0-9a-f]{32}$/, 'The Account SID (AC…)'),
    messagingServiceSid: z
      .string()
      .regex(/^MG[0-9a-f]{32}$/)
      .optional()
      .describe('Send through a Messaging Service instead of a single sender'),
    apiBase: z.url().default('https://api.twilio.com'),
  }),
  secrets: z.object({ authToken: z.string().min(16) }),
  create: (config, secrets, { fetch }) => ({
    async send(m) {
      const params = new URLSearchParams({ To: m.to, Body: m.body, StatusCallback: m.statusUrl });
      if (config.messagingServiceSid) params.set('MessagingServiceSid', config.messagingServiceSid);
      else params.set('From', m.from);
      const res = await fetch(`${config.apiBase}/2010-04-01/Accounts/${config.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${config.accountSid}:${secrets.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });
      const body = (await res.json().catch(() => ({}))) as { sid?: string; num_segments?: string; message?: string; code?: number };
      if (!res.ok) throw new Error(`Twilio refused the message: ${body.message ?? res.status}${body.code ? ` (${body.code})` : ''}`);
      return { providerMessageId: body.sid ?? null, segments: body.num_segments ? Number(body.num_segments) : undefined };
    },
    verifyWebhook(req) {
      const given = req.headers['x-twilio-signature'] ?? '';
      const expected = twilioSignature(secrets.authToken, req.url, form(req.body));
      return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
    },
    parseStatus(req) {
      const p = form(req.body);
      const at = new Date().toISOString();
      const base = { providerMessageId: p.MessageSid, eventId: `${p.MessageSid}:${p.MessageStatus}`, at };
      if (p.MessageStatus === 'delivered') return [{ ...base, type: 'delivered' }];
      if (p.MessageStatus === 'undelivered' || p.MessageStatus === 'failed')
        // 30003-30006: unreachable, unknown or landline numbers: do not try again.
        return [
          {
            ...base,
            type: 'bounced',
            bounce: ['30003', '30005', '30006', '21610', '21614'].includes(p.ErrorCode ?? '') ? 'hard' : 'soft',
            reason: `${p.MessageStatus}${p.ErrorCode ? ` (error ${p.ErrorCode})` : ''}`,
          },
        ];
      return [];
    },
    parseInbound(req) {
      const p = form(req.body);
      return p.From ? { from: p.From, body: p.Body ?? '' } : null;
    },
    reply: twiml,
  }),
});

/** Development outbox: texts are kept in memory, nothing is sent. */
export const smsOutbox: OutgoingSms[] = [];

export const logSmsAdapter = defineSmsAdapter({
  id: 'log',
  label: 'Development outbox (sends nothing)',
  config: z.object({}),
  secrets: z.object({}),
  create: () => ({
    async send(m) {
      smsOutbox.push(m);
      return { providerMessageId: `log-${m.messageId}`, segments: smsSegments(m.body).segments };
    },
    verifyWebhook: () => true,
    parseStatus(req) {
      const p = form(req.body);
      return p.MessageSid && p.MessageStatus === 'delivered'
        ? [{ providerMessageId: p.MessageSid, eventId: `${p.MessageSid}:delivered`, type: 'delivered', at: new Date().toISOString() }]
        : [];
    },
    parseInbound(req) {
      const p = form(req.body);
      return p.From ? { from: p.From, body: p.Body ?? '' } : null;
    },
    reply: twiml,
  }),
});

export const smsAdapters: Record<SmsAdapter['id'], SmsAdapter> = {
  twilio: twilioAdapter as unknown as SmsAdapter,
  log: logSmsAdapter as unknown as SmsAdapter,
};
