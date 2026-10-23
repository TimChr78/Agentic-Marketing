import { type DeliveryDeps, defineConnector, registerConnector, safeRequest } from '@agentic-marketing/integrations';
import { z } from 'zod';
import { googlePhone, metaEmail, metaPhone, sha256 } from './hashing';
import type { Conversion, Person, SendResult } from './platforms';

// Ad platforms beyond the big three (Phase 11): conversions to LinkedIn (Conversions API),
// TikTok (Events API 2.0) and Pinterest (Conversions API v5), with their click ids (li_fat_id;
// ttclid and the _ttp cookie; epik and the _epik cookie) and hashed e-mail and phone. Like the
// others, they are connectors (an ad account is a connection) and only read and send: nothing
// here changes campaigns.

export const linkedinAdsConnector = defineConnector({
  id: 'linkedin_ads',
  label: 'LinkedIn Ads (Conversions API)',
  description:
    'Sends conversions to LinkedIn with the Conversions API: hashed e-mail and the li_fat_id click id. Connect with OAuth (your LinkedIn app with the Conversions API product, scope rw_conversions).',
  auth: 'oauth2',
  settings: z.object({
    apiBase: z.url().default('https://api.linkedin.com'),
    version: z
      .string()
      .regex(/^\d{6}$/)
      .default('202509')
      .describe('The LinkedIn-Version header (YYYYMM)'),
    authorizeUrl: z.url().default('https://www.linkedin.com/oauth/v2/authorization'),
    tokenUrl: z.url().default('https://www.linkedin.com/oauth/v2/accessToken'),
  }),
  secrets: z.object({ clientId: z.string().min(1).max(500), clientSecret: z.string().min(1).max(500) }),
  oauth: (s) => ({ authorizeUrl: s.authorizeUrl, tokenUrl: s.tokenUrl, scopes: ['rw_conversions', 'r_ads'] }),
  rateLimit: 300,
});

export const tiktokAdsConnector = defineConnector({
  id: 'tiktok_ads',
  label: 'TikTok Ads (Events API)',
  description:
    'Sends conversions to a TikTok pixel with the Events API 2.0: hashed e-mail and phone, ttclid and the _ttp cookie, and event_id for de-duplication with the browser pixel. Use a long-lived access token from Events Manager.',
  auth: 'api_key',
  settings: z.object({
    pixelCode: z.string().regex(/^[A-Z0-9]{10,30}$/, 'The pixel code (event_source_id)'),
    testEventCode: z.string().max(50).optional().describe('From Events Manager → Test events; ads.test uses it'),
    apiBase: z.url().default('https://business-api.tiktok.com'),
  }),
  secrets: z.object({ accessToken: z.string().min(20).max(500) }),
  rateLimit: 600,
});

export const pinterestAdsConnector = defineConnector({
  id: 'pinterest_ads',
  label: 'Pinterest Ads (Conversions API)',
  description:
    'Sends conversions to a Pinterest ad account with the Conversions API: hashed e-mail and phone, the epik click id, and event_id for de-duplication with the Pinterest tag. Use a conversion access token from Ads Manager.',
  auth: 'api_key',
  settings: z.object({
    adAccountId: z.string().regex(/^\d{5,25}$/, 'The ad account id'),
    apiBase: z.url().default('https://api.pinterest.com'),
  }),
  secrets: z.object({ accessToken: z.string().min(20).max(500).describe('A conversion access token') }),
  rateLimit: 600,
});

registerConnector(linkedinAdsConnector);
registerConnector(tiktokAdsConnector);
registerConnector(pinterestAdsConnector);

const parse = (body: string) => {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { raw: body.slice(0, 500) };
  }
};
const failure = (status: number, message: string): SendResult => ({
  ok: false,
  statusCode: status,
  error: `HTTP ${status}: ${message}`,
  permanent: status !== 429 && status < 500,
});

export async function sendToLinkedin(
  c: Conversion,
  p: Person,
  dest: { conversionId: string },
  settings: z.output<typeof linkedinAdsConnector.settings>,
  accessToken: string | undefined,
  egress: DeliveryDeps['egress'],
): Promise<SendResult> {
  if (!accessToken) return { ok: false, error: 'not connected: authorize the LinkedIn connection', permanent: true };
  if (Date.now() - Date.parse(c.at) > 90 * 86_400_000)
    return { ok: false, error: 'LinkedIn accepts conversions up to 90 days old', permanent: true };
  const userIds = [
    ...(p.email ? [{ idType: 'SHA256_EMAIL', idValue: metaEmail(p.email) }] : []),
    ...(p.clickIds.li_fat_id ? [{ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: p.clickIds.li_fat_id }] : []),
  ];
  if (!userIds.length) return { ok: false, error: 'nothing to match on: no li_fat_id or e-mail for this person', permanent: true };
  const res = await safeRequest(
    `${settings.apiBase.replace(/\/$/, '')}/rest/conversionEvents`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        'linkedin-version': settings.version,
        'x-restli-protocol-version': '2.0.0',
      },
      body: JSON.stringify({
        conversion: `urn:lla:llaPartnerConversion:${dest.conversionId}`,
        conversionHappenedAt: Date.parse(c.at),
        eventId: c.eventId,
        ...(c.value !== undefined && c.currency ? { conversionValue: { currencyCode: c.currency, amount: String(c.value) } } : {}),
        user: { userIds },
      }),
    },
    egress,
  );
  if (res.status >= 200 && res.status < 300) return { ok: true, statusCode: res.status, response: parse(res.body) };
  return failure(res.status, String(parse(res.body).message ?? res.body.slice(0, 300)));
}

export async function sendToTiktok(
  c: Conversion,
  p: Person,
  dest: { event: string },
  settings: z.output<typeof tiktokAdsConnector.settings>,
  secrets: { accessToken: string },
  egress: DeliveryDeps['egress'],
  opts: { test?: boolean } = {},
): Promise<SendResult> {
  if (opts.test && !settings.testEventCode)
    return { ok: false, error: 'Set testEventCode on the connection (Events Manager → Test events)', permanent: true };
  const user: Record<string, string> = { external_id: sha256(c.profileId) };
  if (p.email) user.email = metaEmail(p.email);
  if (p.phone) user.phone = googlePhone(p.phone);
  if (p.clickIds.ttclid) user.ttclid = p.clickIds.ttclid;
  if (p.clickIds.ttp) user.ttp = p.clickIds.ttp;
  if (c.userAgent) user.user_agent = c.userAgent;
  const res = await safeRequest(
    `${settings.apiBase.replace(/\/$/, '')}/open_api/v1.3/event/track/`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'access-token': secrets.accessToken },
      body: JSON.stringify({
        event_source: 'web',
        event_source_id: settings.pixelCode,
        ...(opts.test ? { test_event_code: settings.testEventCode } : {}),
        data: [
          {
            event: dest.event,
            event_time: Math.floor(Date.parse(c.at) / 1000),
            event_id: c.eventId,
            user,
            ...(c.sourceUrl ? { page: { url: c.sourceUrl } } : {}),
            ...(c.value !== undefined ? { properties: { value: c.value, ...(c.currency ? { currency: c.currency } : {}) } } : {}),
          },
        ],
      }),
    },
    egress,
  );
  const b = parse(res.body) as { code?: number; message?: string };
  // TikTok answers 200 with a non-zero code for request errors.
  if (res.status >= 200 && res.status < 300 && b.code === 0) return { ok: true, statusCode: res.status, response: b };
  if (res.status >= 200 && res.status < 300)
    return { ok: false, statusCode: res.status, error: `TikTok code ${b.code}: ${b.message ?? ''}`, permanent: true };
  return failure(res.status, b.message ?? res.body.slice(0, 300));
}

export async function sendToPinterest(
  c: Conversion,
  p: Person,
  dest: { eventName: string },
  settings: z.output<typeof pinterestAdsConnector.settings>,
  secrets: { accessToken: string },
  egress: DeliveryDeps['egress'],
  opts: { test?: boolean } = {},
): Promise<SendResult> {
  const userData: Record<string, unknown> = { external_id: [sha256(c.profileId)] };
  if (p.email) userData.em = [metaEmail(p.email)];
  if (p.phone) userData.ph = [metaPhone(p.phone)];
  if (p.clickIds.epik) userData.click_id = p.clickIds.epik;
  if (c.userAgent) userData.client_user_agent = c.userAgent;
  const res = await safeRequest(
    `${settings.apiBase.replace(/\/$/, '')}/v5/ad_accounts/${settings.adAccountId}/events${opts.test ? '?test=true' : ''}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secrets.accessToken}` },
      body: JSON.stringify({
        data: [
          {
            event_name: dest.eventName,
            action_source: c.sourceUrl ? 'web' : 'offline',
            event_time: Math.floor(Date.parse(c.at) / 1000),
            event_id: c.eventId,
            ...(c.sourceUrl ? { event_source_url: c.sourceUrl } : {}),
            user_data: userData,
            ...(c.value !== undefined ? { custom_data: { value: String(c.value), ...(c.currency ? { currency: c.currency } : {}) } } : {}),
          },
        ],
      }),
    },
    egress,
  );
  const b = parse(res.body) as { message?: string; events?: { status?: string; error_message?: string }[] };
  const failed = b.events?.find((e) => e.status === 'failed');
  if (res.status >= 200 && res.status < 300 && !failed) return { ok: true, statusCode: res.status, response: b };
  if (failed) return { ok: false, statusCode: res.status, error: `Pinterest: ${failed.error_message ?? 'event failed'}`, permanent: true };
  return failure(res.status, b.message ?? res.body.slice(0, 300));
}
