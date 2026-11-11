import { createVerify } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import { type AdapterDeps, type DeliveryEvent, defineAdapter, type WebhookRequest } from './types';

// Amazon SES v2 (SendEmail, signed with SigV4). Delivery events come from a configuration set
// publishing to an SNS topic subscribed to our webhook URL; SNS messages are signed, and the
// signature is verified against Amazon's certificate before anything is trusted.

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
/**
 * Successfully fetched signing certificates, keyed by URL. Only a verified, non-empty PEM is
 * cached: a failed request, a non-OK status or an error body must never poison the URL, or every
 * later SNS webhook for the process would be rejected (#634). A handful of AWS certificates is
 * all a workspace sees, so the map is bounded as an LRU.
 */
const CERTS_MAX = 8;
const certs = new Map<string, string>();

function snsUrlOk(raw: unknown): raw is string {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/** A certificate body, or a clear error so the caller can refuse the webhook and try again later. */
async function fetchCert(url: string, deps: AdapterDeps): Promise<string> {
  const res = await deps.fetch(url);
  if (!res.ok) throw new Error(`SNS certificate fetch failed: HTTP ${res.status}`);
  const pem = await res.text();
  // A 200 with an HTML error page is not a certificate, and caching it would disable the URL.
  // (Tests use a PEM public key; AWS sends a certificate, but both are PEM blocks.)
  if (!pem.includes('-----BEGIN ')) throw new Error('SNS certificate response is not a PEM certificate');
  return pem;
}

/** The cached PEM, or a fresh one; `cached` tells the caller whether a failed verify may refetch. */
async function getCert(url: string, deps: AdapterDeps, force = false): Promise<{ pem: string; cached: boolean }> {
  const hit = force ? undefined : certs.get(url);
  if (hit !== undefined) {
    // Refresh the insertion order, so the entry a flood of URLs would evict is the least used.
    certs.delete(url);
    certs.set(url, hit);
    return { pem: hit, cached: true };
  }
  certs.delete(url);
  const pem = await fetchCert(url, deps);
  certs.set(url, pem);
  while (certs.size > CERTS_MAX) {
    const oldest = certs.keys().next().value;
    if (oldest === undefined) break;
    certs.delete(oldest);
  }
  return { pem, cached: false };
}

function verifyWith(cert: string, stringToSign: string, m: Record<string, string>): boolean {
  const v = createVerify(m.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
  v.update(stringToSign, 'utf8');
  try {
    return v.verify(cert, m.Signature, 'base64');
  } catch {
    return false;
  }
}

/** Verifies an SNS message signature (versions 1 and 2), fetching and caching the signing certificate. */
export async function verifySnsMessage(m: Record<string, string>, deps: AdapterDeps): Promise<boolean> {
  if (!snsUrlOk(m.SigningCertURL) || !m.Signature) return false;
  const fields =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const stringToSign = fields
    .filter((k) => m[k] !== undefined)
    .map((k) => `${k}\n${m[k]}\n`)
    .join('');
  let cert: { pem: string; cached: boolean };
  try {
    cert = await getCert(m.SigningCertURL, deps);
  } catch {
    // The failure is not cached, so the next webhook fetches again instead of staying poisoned.
    return false;
  }
  if (verifyWith(cert.pem, stringToSign, m)) return true;
  if (!cert.cached) return false;
  // A cached certificate may be stale (AWS rotates one behind a stable URL) or was verified
  // against a body cached by an older build. Refetch once before refusing the signature.
  try {
    cert = await getCert(m.SigningCertURL, deps, true);
  } catch {
    return false;
  }
  // getCert just refreshed the entry, so this is a fresh body; verify and give the final answer.
  return verifyWith(cert.pem, stringToSign, m);
}

/** SES event (configuration-set publishing or classic notification) → delivery events. */
// biome-ignore lint/suspicious/noExplicitAny: provider payloads are untyped JSON
export function sesEvents(ev: Record<string, any>): DeliveryEvent[] {
  const kind = ev.eventType ?? ev.notificationType;
  const mail = ev.mail ?? {};
  const base = { messageId: mail.tags?.am_message_id?.[0], providerMessageId: mail.messageId };
  const eid = (s: string) => `${mail.messageId}:${kind}:${s}`;
  switch (kind) {
    case 'Delivery':
      return [{ ...base, eventId: eid(ev.delivery?.timestamp ?? ''), type: 'delivered', at: ev.delivery?.timestamp ?? mail.timestamp }];
    case 'Bounce': {
      const b = ev.bounce ?? {};
      return [
        {
          ...base,
          eventId: eid(b.feedbackId ?? b.timestamp ?? ''),
          type: 'bounced',
          bounce: b.bounceType === 'Permanent' ? 'hard' : 'soft',
          reason: `${b.bounceType}/${b.bounceSubType}`,
          at: b.timestamp ?? mail.timestamp,
        },
      ];
    }
    case 'Complaint':
      return [{ ...base, eventId: eid(ev.complaint?.feedbackId ?? ''), type: 'complained', at: ev.complaint?.timestamp ?? mail.timestamp }];
    case 'DeliveryDelay':
      return [
        {
          ...base,
          eventId: eid(ev.deliveryDelay?.timestamp ?? ''),
          type: 'deferred',
          reason: ev.deliveryDelay?.delayType,
          at: ev.deliveryDelay?.timestamp,
        },
      ];
    case 'Reject':
      return [
        {
          ...base,
          eventId: eid('reject'),
          type: 'bounced',
          bounce: 'hard',
          reason: `Rejected: ${ev.reject?.reason ?? ''}`,
          at: mail.timestamp,
        },
      ];
    case 'Open':
      return [{ ...base, eventId: eid(ev.open?.timestamp ?? ''), type: 'opened', at: ev.open?.timestamp }];
    case 'Click':
      return [
        {
          ...base,
          eventId: eid(`${ev.click?.timestamp}:${ev.click?.link}`),
          type: 'clicked',
          url: ev.click?.link,
          at: ev.click?.timestamp,
        },
      ];
    case 'Subscription':
      return [{ ...base, eventId: eid(ev.subscription?.timestamp ?? ''), type: 'unsubscribed', at: ev.subscription?.timestamp }];
    default:
      return [];
  }
}

/** Webhook handling for SES over SNS: verify, confirm the subscription once, then parse. */
export function sesWebhook(deps: AdapterDeps) {
  return {
    async verifyWebhook({ body }: WebhookRequest) {
      try {
        return await verifySnsMessage(JSON.parse(body), deps);
      } catch {
        return false;
      }
    },
    async parseWebhook({ body }: WebhookRequest): Promise<DeliveryEvent[]> {
      const m = JSON.parse(body) as Record<string, string>;
      if (m.Type === 'SubscriptionConfirmation') {
        if (snsUrlOk(m.SubscribeURL)) await deps.fetch(m.SubscribeURL);
        return [];
      }
      if (m.Type !== 'Notification') return [];
      return sesEvents(JSON.parse(m.Message));
    },
  };
}

export const sesAdapter = defineAdapter({
  id: 'ses',
  label: 'Amazon SES',
  docsUrl: 'https://docs.aws.amazon.com/ses/latest/dg/send-email-api.html',
  tracking: 'configurable',
  trackingNote:
    'SES tracks opens and clicks only when the AWS configuration set used for the message enables open or click tracking; the platform does not add tracking options.',
  config: z.object({
    region: z
      .string()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'An AWS region such as eu-west-1')
      .describe('AWS region of your SES account, e.g. eu-west-1'),
    accessKeyId: z.string().min(16).describe('Access key id of an IAM user allowed to send with SES'),
    configurationSet: z.string().optional().describe('Configuration set that publishes delivery events to SNS'),
    marketingConfigurationSet: z.string().optional().describe('Configuration set for marketing e-mail, if different'),
  }),
  secrets: z.object({ secretAccessKey: z.string().min(20).describe('Secret access key of that IAM user') }),
  create: (config, secrets, deps) => {
    const aws = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: secrets.secretAccessKey,
      region: config.region,
      service: 'ses',
    });
    return {
      async send(m) {
        const configurationSet =
          m.stream === 'marketing' ? (config.marketingConfigurationSet ?? config.configurationSet) : config.configurationSet;
        const signed = await aws.sign(`https://email.${config.region}.amazonaws.com/v2/email/outbound-emails`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            FromEmailAddress: m.from.name ? `"${m.from.name.replace(/"/g, '')}" <${m.from.email}>` : m.from.email,
            Destination: { ToAddresses: [m.to] },
            ...(m.replyTo ? { ReplyToAddresses: [m.replyTo] } : {}),
            Content: {
              Simple: {
                Subject: { Data: m.subject, Charset: 'UTF-8' },
                Body: { Html: { Data: m.html, Charset: 'UTF-8' }, Text: { Data: m.text, Charset: 'UTF-8' } },
                Headers: Object.entries(m.headers).map(([Name, Value]) => ({ Name, Value })),
              },
            },
            EmailTags: [{ Name: 'am_message_id', Value: m.messageId.replace(/[^A-Za-z0-9_-]/g, '_') }],
            ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
          }),
        });
        const res = await deps.fetch(signed);
        const body = (await res.json().catch(() => ({}))) as { MessageId?: string; message?: string };
        if (!res.ok) throw new Error(`SES refused the message: ${body.message ?? res.status}`);
        return { providerMessageId: body.MessageId ?? null };
      },
      ...sesWebhook(deps),
    };
  },
});
