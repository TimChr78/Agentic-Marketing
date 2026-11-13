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
 * later SNS webhook for the process would be rejected (#634). Certificates are per AWS region and
 * a multi-workspace install spans several, so the map holds comfortably more than a region set.
 */
const CERTS_MAX = 64;
/** The window in which a bad signature may not force another fetch for the same URL. */
const REFETCH_COOLDOWN_MS = 60_000;
/**
 * Certificate fetches allowed per process in a rolling minute. This is the amplification bound:
 * a cooldown entry is evicted freely, because dropping one only permits another fetch of an AWS
 * URL, so the total number of requests to AWS is capped here instead of by refusing a legitimate
 * first verification. The limit leaves room for normal regional churn (a real install sees a
 * handful of certificate URLs) while still capping a flood at two requests a second. A refusal
 * here is transient (SNS retries it), never a permanent failure.
 */
export const SNS_CERT_FETCHES_PER_MINUTE = 120;
const CERT_FETCH_WINDOW_MS = 60_000;
/** URLs whose refetch cooldown is remembered: a bounded LRU, oldest cooldown evicted first. */
const COOLDOWNS_MAX = 64;
interface CertEntry {
  pem: string;
}
const certs = new Map<string, CertEntry>();
/**
 * When a signature failure last forced a refetch, keyed by URL. Kept out of the certificate map
 * on purpose: the throttle used to live on the cached entry, so churning more URLs than the map
 * holds handed the once-per-minute bound back to the flood (#755). A full map evicts the oldest
 * cooldown rather than refusing the fetch; `SNS_CERT_FETCHES_PER_MINUTE` bounds that amplification.
 */
const refetchedAt = new Map<string, number>();
/** Start times of the certificate fetches inside the rolling window. */
let certFetches: number[] = [];
/** One request per URL while a fetch is in flight, so a burst of webhooks cannot fan out. */
const inflight = new Map<string, Promise<string>>();

/** A transient verification failure: the webhook route answers 503 so SNS retries it. */
class SnsRetryError extends Error {}

/** True while `url` is inside its refetch cooldown; an expired entry is dropped on the way. */
function coolingDown(url: string, now: number): boolean {
  const when = refetchedAt.get(url);
  if (when === undefined) return false;
  if (now - when < REFETCH_COOLDOWN_MS) return true;
  refetchedAt.delete(url);
  return false;
}

/** Claims the once-per-minute refetch for `url`, or false while it is cooling down. */
function reserveRefetch(url: string, now: number): boolean {
  if (coolingDown(url, now)) return false;
  refetchedAt.delete(url);
  refetchedAt.set(url, now);
  while (refetchedAt.size > COOLDOWNS_MAX) {
    const oldest = refetchedAt.keys().next().value;
    if (oldest === undefined) break;
    refetchedAt.delete(oldest);
  }
  return true;
}

/** Claims one certificate fetch in the rolling minute, or refuses transiently at the limit. */
function reserveFetch(now: number): void {
  // Drop entries outside the window. A timestamp from a clock that went backwards is dropped too,
  // so an injected test clock cannot leave a future entry behind and block every later fetch.
  certFetches = certFetches.filter((at) => at <= now && now - at < CERT_FETCH_WINDOW_MS);
  if (certFetches.length >= SNS_CERT_FETCHES_PER_MINUTE) throw new SnsRetryError('SNS certificate fetch rate limit reached; retry later');
  certFetches.push(now);
}

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

/** Coalesce concurrent fetches for one URL into a single request. */
function fetchCertOnce(url: string, deps: AdapterDeps, now: number): Promise<string> {
  const running = inflight.get(url);
  if (running !== undefined) return running;
  // Only a fetch that really starts spends the process's allowance; joiners ride on it.
  reserveFetch(now);
  const p = fetchCert(url, deps).finally(() => {
    if (inflight.get(url) === p) inflight.delete(url);
  });
  inflight.set(url, p);
  return p;
}

/** The cached PEM, or a fresh one; `cached` tells the caller whether a failed verify may refetch. */
async function getCert(url: string, deps: AdapterDeps, force: boolean): Promise<{ pem: string; cached: boolean }> {
  const hit = force ? undefined : certs.get(url);
  if (hit !== undefined) {
    // Refresh the insertion order, so the entry a flood of URLs would evict is the least used.
    certs.delete(url);
    certs.set(url, hit);
    return { pem: hit.pem, cached: true };
  }
  // A cache miss is always fetched when the rolling allowance has room: evicting a certificate (or
  // its old cooldown) must never turn a legitimate message into a permanent refusal.
  const pem = await fetchCertOnce(url, deps, deps.now?.() ?? Date.now());
  // Only a successful fetch is cached: a timeout or an error body must not poison the URL (#634).
  certs.delete(url);
  certs.set(url, { pem });
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

/**
 * `valid` and `invalid` are final; `retry` means the answer is unknown because the certificate
 * could not be fetched right now (rate limit, network, timeout, temporary unavailability). SNS
 * retries 429 and 5xx, but treats 401 as permanent, so a transient failure must not be `invalid`.
 */
export type SnsVerification = 'valid' | 'invalid' | 'retry';

/** Verifies an SNS message signature (versions 1 and 2), fetching and caching the signing certificate. */
export async function verifySnsMessage(m: Record<string, string>, deps: AdapterDeps): Promise<SnsVerification> {
  if (!snsUrlOk(m.SigningCertURL) || !m.Signature) return 'invalid';
  const fields =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  const stringToSign = fields
    .filter((k) => m[k] !== undefined)
    .map((k) => `${k}\n${m[k]}\n`)
    .join('');
  let cert: { pem: string; cached: boolean };
  const now = deps.now?.() ?? Date.now();
  try {
    cert = await getCert(m.SigningCertURL, deps, false);
  } catch {
    // A fetch failure (#634's timeout or a temporary 5xx) is not cached, and it is not a bad
    // signature: tell the route to answer 503 so SNS delivers the message again.
    return 'retry';
  }
  if (verifyWith(cert.pem, stringToSign, m)) return 'valid';
  if (!cert.cached) return 'invalid';
  // A cached certificate may be stale (AWS rotates one behind a stable URL) or was verified
  // against a body cached by an older build. Refetch once, but only once per URL per minute: a
  // flood of bad signatures must not turn into a flood of requests to AWS (#634 review). The
  // claim starts the cooldown before awaiting, so concurrent bad signatures join this refetch.
  if (!reserveRefetch(m.SigningCertURL, now)) return 'invalid';
  try {
    cert = await getCert(m.SigningCertURL, deps, true);
  } catch {
    return 'retry';
  }
  // getCert just refreshed the entry, so this is a fresh body; verify and give the final answer.
  return verifyWith(cert.pem, stringToSign, m) ? 'valid' : 'invalid';
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
        // The body is not a JSON SNS message at all; no retry can make it one.
        return 'invalid' as const;
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
