import { type DeliveryDeps, defineConnector, registerConnector, safeRequest } from '@agentic-marketing/integrations';
import { z } from 'zod';
import type { ClickIds } from './clickIds';
import { googleEmail, googlePhone, metaEmail, metaPhone, sha256 } from './hashing';

// The ad platforms as connectors (an ad account is a connection) and how a conversion is sent to
// each. Request shapes follow the official SDKs: facebook-nodejs-business-sdk (Conversions API,
// Graph v24.0) and @google-ads/datamanager (Data Manager API v1, events:ingest).

export const metaAdsConnector = defineConnector({
  id: 'meta_ads',
  label: 'Meta Ads (Conversions API)',
  description:
    'Sends conversions to a Meta dataset (pixel) with the Conversions API: hashed e-mail and phone, fbc/fbp, and event_id for de-duplication with the browser pixel. Use a system-user access token.',
  auth: 'api_key',
  settings: z.object({
    pixelId: z.string().regex(/^\d{5,20}$/, 'The dataset (pixel) id'),
    apiVersion: z
      .string()
      .regex(/^v\d+\.\d$/)
      .default('v24.0'),
    testEventCode: z.string().max(50).optional().describe('From Events Manager → Test events; ads.test uses it'),
    apiBase: z.url().default('https://graph.facebook.com'),
  }),
  secrets: z.object({ accessToken: z.string().min(20).describe('A system-user access token with ads_management') }),
  rateLimit: 600,
});

export const googleAdsConnector = defineConnector({
  id: 'google_ads',
  label: 'Google Ads (Data Manager API)',
  description:
    'Sends offline conversions and enhanced conversions for leads to Google Ads through the Data Manager API, with click ids, hashed e-mail and phone, and consent. Connect with OAuth (your Google Cloud OAuth client).',
  auth: 'oauth2',
  settings: z.object({
    customerId: z.string().regex(/^\d{10}$/, 'The Google Ads customer id, 10 digits without dashes'),
    loginCustomerId: z
      .string()
      .regex(/^\d{10}$/)
      .optional()
      .describe('The manager account, when access goes through one'),
    apiBase: z.url().default('https://datamanager.googleapis.com'),
    authorizeUrl: z.url().default('https://accounts.google.com/o/oauth2/v2/auth'),
    tokenUrl: z.url().default('https://oauth2.googleapis.com/token'),
  }),
  secrets: z.object({ clientId: z.string().min(1).max(500), clientSecret: z.string().min(1).max(500) }),
  oauth: (s) => ({
    authorizeUrl: s.authorizeUrl,
    tokenUrl: s.tokenUrl,
    scopes: ['https://www.googleapis.com/auth/datamanager'],
    params: { access_type: 'offline', prompt: 'consent' },
  }),
  rateLimit: 600,
});

registerConnector(metaAdsConnector);
registerConnector(googleAdsConnector);

/** A conversion as queued, plus what is known about the person at send time. */
export interface Conversion {
  eventId: string;
  name: string;
  at: string;
  value?: number;
  currency?: string;
  sourceUrl?: string;
  userAgent?: string;
  profileId: string;
}
export interface Person {
  email: string | null;
  phone: string | null;
  clickIds: ClickIds;
  /** ad_targeting: Google's ad_personalization. */
  personalization: boolean;
}
export type SendResult =
  | { ok: true; statusCode: number; response: unknown }
  | { ok: false; statusCode?: number; error: string; permanent?: boolean };

const parse = (body: string) => {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { raw: body.slice(0, 500) };
  }
};
const outcome = (status: number, body: string, describe: (b: Record<string, unknown>) => string): SendResult => {
  const b = parse(body);
  if (status >= 200 && status < 300) return { ok: true, statusCode: status, response: b };
  // Rate limits and server trouble are retried; anything else is the request's fault.
  return { ok: false, statusCode: status, error: `HTTP ${status}: ${describe(b)}`, permanent: status !== 429 && status < 500 };
};

export async function sendToMeta(
  c: Conversion,
  p: Person,
  dest: { eventName: string },
  settings: z.output<typeof metaAdsConnector.settings>,
  secrets: { accessToken: string },
  egress: DeliveryDeps['egress'],
  opts: { test?: boolean } = {},
): Promise<SendResult> {
  const time = Math.floor(Date.parse(c.at) / 1000);
  if (Date.now() / 1000 - time > 7 * 86_400) return { ok: false, error: 'Meta accepts events up to 7 days old', permanent: true };
  const userData: Record<string, unknown> = { external_id: [sha256(c.profileId)] };
  if (p.email) userData.em = [metaEmail(p.email)];
  if (p.phone) userData.ph = [metaPhone(p.phone)];
  if (p.clickIds.fbc) userData.fbc = p.clickIds.fbc;
  if (p.clickIds.fbp) userData.fbp = p.clickIds.fbp;
  if (c.userAgent) userData.client_user_agent = c.userAgent;
  const event = {
    event_name: dest.eventName,
    event_time: time,
    event_id: c.eventId,
    action_source: c.sourceUrl ? 'website' : 'system_generated',
    ...(c.sourceUrl ? { event_source_url: c.sourceUrl } : {}),
    user_data: userData,
    ...(c.value !== undefined ? { custom_data: { value: c.value, ...(c.currency ? { currency: c.currency } : {}) } } : {}),
  };
  if (opts.test && !settings.testEventCode)
    return { ok: false, error: 'Set testEventCode on the connection (Events Manager → Test events)', permanent: true };
  const res = await safeRequest(
    `${settings.apiBase.replace(/\/$/, '')}/${settings.apiVersion}/${settings.pixelId}/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        data: [event],
        access_token: secrets.accessToken,
        ...(opts.test ? { test_event_code: settings.testEventCode } : {}),
      }),
    },
    egress,
  );
  return outcome(res.status, res.body, (b) =>
    String((b.error as { message?: string } | undefined)?.message ?? JSON.stringify(b).slice(0, 300)),
  );
}

export async function sendToGoogle(
  c: Conversion,
  p: Person,
  dest: { conversionAction: string },
  settings: z.output<typeof googleAdsConnector.settings>,
  accessToken: string | undefined,
  egress: DeliveryDeps['egress'],
  opts: { test?: boolean } = {},
): Promise<SendResult> {
  if (!accessToken) return { ok: false, error: 'not connected: authorize the Google Ads connection', permanent: true };
  const ids = Object.fromEntries((['gclid', 'gbraid', 'wbraid'] as const).filter((k) => p.clickIds[k]).map((k) => [k, p.clickIds[k]]));
  const userIdentifiers = [
    ...(p.email ? [{ emailAddress: googleEmail(p.email) }] : []),
    ...(p.phone ? [{ phoneNumber: googlePhone(p.phone) }] : []),
  ];
  if (!Object.keys(ids).length && !userIdentifiers.length)
    return { ok: false, error: 'nothing to match on: no click id, e-mail or phone for this person', permanent: true };
  const account = (id: string) => ({ accountId: id, accountType: 'GOOGLE_ADS' });
  const body = {
    destinations: [
      {
        operatingAccount: account(settings.customerId),
        ...(settings.loginCustomerId ? { loginAccount: account(settings.loginCustomerId) } : {}),
        productDestinationId: dest.conversionAction,
      },
    ],
    events: [
      {
        transactionId: c.eventId,
        eventTimestamp: new Date(c.at).toISOString(),
        ...(userIdentifiers.length ? { userData: { userIdentifiers } } : {}),
        ...(Object.keys(ids).length ? { adIdentifiers: ids } : {}),
        ...(c.value !== undefined ? { conversionValue: c.value } : {}),
        ...(c.currency ? { currency: c.currency } : {}),
        eventSource: 'WEB',
        // Only sent with ad_measurement allowed, so ad_user_data is granted.
        consent: { adUserData: 'CONSENT_GRANTED', adPersonalization: p.personalization ? 'CONSENT_GRANTED' : 'CONSENT_DENIED' },
      },
    ],
    encoding: 'HEX',
    ...(opts.test ? { validateOnly: true } : {}),
  };
  const res = await safeRequest(
    `${settings.apiBase.replace(/\/$/, '')}/v1/events:ingest`,
    { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` }, body: JSON.stringify(body) },
    egress,
  );
  return outcome(res.status, res.body, (b) =>
    String((b.error as { message?: string } | undefined)?.message ?? JSON.stringify(b).slice(0, 300)),
  );
}
