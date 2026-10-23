import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import type { AdapterDeps } from '../adapters/types';
import { encryptPayload, es256Jwt, MAX_PAYLOAD, rs256Jwt, vapidAuthorization } from './crypto';

// Push adapters (Phase 11): one per kind of device registration. Pure translation, no database
// and no policy. A send either succeeds, reports the registration as gone (the browser or app
// unsubscribed: the gateway deletes it), or throws (the gateway retries).
//
//   webpush  browsers, through their push service, with VAPID (no account needed)
//   fcm      Android (and iOS apps that use Firebase), through FCM's HTTP v1 API
//   apns     iOS, iPadOS and macOS apps, through Apple's HTTP/2 API with a token-based key

export type PushKind = 'web' | 'fcm' | 'apns';

export type PushRegistration =
  | { kind: 'web'; endpoint: string; p256dh: string; auth: string }
  | { kind: 'fcm'; token: string }
  | { kind: 'apns'; token: string };

export interface OutgoingPush {
  messageId: string;
  title: string;
  body: string;
  /** Opened when the notification is clicked (a tracked link). */
  url: string | null;
  icon: string | null;
  image: string | null;
  ttlSeconds: number;
  urgency: 'normal' | 'high';
}

export type PushResult = { ok: true; providerMessageId: string | null } | { ok: false; gone: string };

export interface PushTransport {
  send(to: PushRegistration, msg: OutgoingPush): Promise<PushResult>;
}

export interface PushAdapter<C extends z.ZodType = z.ZodType, S extends z.ZodType = z.ZodType> {
  id: 'webpush' | 'fcm' | 'apns' | 'log';
  label: string;
  /** The registrations it delivers to. */
  kinds: PushKind[];
  config: C;
  secrets: S;
  create(config: z.output<C>, secrets: z.output<S>, deps: AdapterDeps): PushTransport;
}
const definePushAdapter = <C extends z.ZodType, S extends z.ZodType>(a: PushAdapter<C, S>) => a;

/** What the service worker (and the apps) receive. */
export const pushPayload = (m: OutgoingPush) => ({
  title: m.title,
  body: m.body,
  ...(m.url ? { url: m.url } : {}),
  ...(m.icon ? { icon: m.icon } : {}),
  ...(m.image ? { image: m.image } : {}),
  messageId: m.messageId,
});

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const webPushAdapter = definePushAdapter({
  id: 'webpush',
  label: 'Web push (browsers, VAPID)',
  kinds: ['web'],
  config: z.object({
    publicKey: Base64Url.length(87).describe('VAPID public key; generated when the provider is added'),
    subject: z
      .string()
      .regex(/^(mailto:|https:\/\/)/)
      .describe('How push services can reach you about problems, e.g. mailto:ops@example.com'),
  }),
  secrets: z.object({ privateKey: Base64Url.length(43) }),
  create: (config, secrets, deps) => ({
    async send(to, msg) {
      if (to.kind !== 'web') throw new Error('web push only delivers to browser subscriptions');
      const plain = Buffer.from(JSON.stringify(pushPayload(msg)));
      if (plain.length > MAX_PAYLOAD)
        throw new Error(`the notification is ${plain.length} bytes; push services take at most ${MAX_PAYLOAD}`);
      const res = await deps.fetch(to.endpoint, {
        method: 'POST',
        headers: {
          authorization: vapidAuthorization(to.endpoint, { publicKey: config.publicKey, privateKey: secrets.privateKey }, config.subject),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(msg.ttlSeconds),
          urgency: msg.urgency,
        },
        body: new Uint8Array(encryptPayload(plain, to)),
      });
      if (res.status === 404 || res.status === 410) return { ok: false, gone: `the push service answered ${res.status}` };
      if (!res.ok) throw new Error(`push service answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { ok: true, providerMessageId: res.headers.get('location') };
    },
  }),
});

// Access tokens for a Google service account, kept until five minutes before they expire.
const googleTokens = new Map<string, { token: string; until: number }>();

export const fcmAdapter = definePushAdapter({
  id: 'fcm',
  label: 'Firebase Cloud Messaging (Android, Firebase apps)',
  kinds: ['fcm'],
  config: z.object({
    projectId: z.string().regex(/^[a-z0-9-]{4,40}$/),
    apiBase: z.url().default('https://fcm.googleapis.com').describe('Override for tests'),
    tokenUrl: z.url().default('https://oauth2.googleapis.com/token').describe('Override for tests'),
  }),
  secrets: z.object({
    clientEmail: z.email().describe('The service account (client_email in its JSON key)'),
    privateKey: z.string().includes('PRIVATE KEY').describe('private_key from the JSON key'),
    privateKeyId: z.string().optional(),
  }),
  create: (config, secrets, deps) => {
    const accessToken = async () => {
      const key = `${config.tokenUrl}|${secrets.clientEmail}`;
      const hit = googleTokens.get(key);
      if (hit && hit.until > Date.now()) return hit.token;
      const now = Math.floor(Date.now() / 1000);
      const assertion = rs256Jwt(
        {
          iss: secrets.clientEmail,
          scope: 'https://www.googleapis.com/auth/firebase.messaging',
          aud: config.tokenUrl,
          iat: now,
          exp: now + 3600,
        },
        secrets.privateKey,
        secrets.privateKeyId,
      );
      const res = await deps.fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      });
      const out = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
      if (!res.ok || !out.access_token) throw new Error(`Google token endpoint answered ${res.status}: ${out.error_description ?? ''}`);
      googleTokens.set(key, { token: out.access_token, until: Date.now() + ((out.expires_in ?? 3600) - 300) * 1000 });
      return out.access_token;
    };
    return {
      async send(to, msg) {
        if (to.kind !== 'fcm') throw new Error('FCM only delivers to FCM registration tokens');
        const data: Record<string, string> = { messageId: msg.messageId, ...(msg.url ? { url: msg.url } : {}) };
        const res = await deps.fetch(`${config.apiBase.replace(/\/$/, '')}/v1/projects/${config.projectId}/messages:send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${await accessToken()}` },
          body: JSON.stringify({
            message: {
              token: to.token,
              notification: { title: msg.title, body: msg.body, ...(msg.image ? { image: msg.image } : {}) },
              data,
              android: { priority: msg.urgency === 'high' ? 'high' : 'normal', ttl: `${msg.ttlSeconds}s` },
            },
          }),
        });
        const out = (await res.json().catch(() => ({}))) as {
          name?: string;
          error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
        };
        const code = out.error?.details?.find((d) => d.errorCode)?.errorCode ?? out.error?.status;
        if (res.status === 404 || code === 'UNREGISTERED') return { ok: false, gone: 'FCM: the registration token is no longer valid' };
        if (!res.ok) throw new Error(`FCM answered ${res.status} ${code ?? ''}: ${out.error?.message ?? ''}`);
        return { ok: true, providerMessageId: out.name ?? null };
      },
    };
  },
});

// APNs provider tokens may be reused for up to an hour, and Apple refuses new ones more often than every 20 minutes.
const apnsTokens = new Map<string, { token: string; until: number }>();

export const apnsAdapter = definePushAdapter({
  id: 'apns',
  label: 'Apple Push Notification service (iOS, macOS apps)',
  kinds: ['apns'],
  config: z.object({
    teamId: z.string().regex(/^[A-Z0-9]{10}$/),
    keyId: z.string().regex(/^[A-Z0-9]{10}$/),
    topic: z.string().min(3).max(200).describe("The app's bundle id, e.g. com.example.shop"),
    environment: z.enum(['production', 'sandbox']).default('production'),
    apiBase: z.url().optional().describe('Override for tests'),
  }),
  secrets: z.object({ privateKey: z.string().includes('PRIVATE KEY').describe('The .p8 signing key from Apple') }),
  create: (config, secrets, deps) => {
    const base = config.apiBase ?? (config.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    const providerToken = () => {
      const key = `${config.teamId}|${config.keyId}`;
      const hit = apnsTokens.get(key);
      if (hit && hit.until > Date.now()) return hit.token;
      const token = es256Jwt(
        { kid: config.keyId },
        { iss: config.teamId, iat: Math.floor(Date.now() / 1000) },
        createPrivateKey(secrets.privateKey),
      );
      apnsTokens.set(key, { token, until: Date.now() + 50 * 60_000 });
      return token;
    };
    return {
      async send(to, msg) {
        if (to.kind !== 'apns') throw new Error('APNs only delivers to Apple device tokens');
        if (!deps.http2) throw new Error('APNs needs HTTP/2, which this install does not provide');
        const res = await deps.http2(`${base.replace(/\/$/, '')}/3/device/${to.token}`, {
          method: 'POST',
          headers: {
            authorization: `bearer ${providerToken()}`,
            'apns-topic': config.topic,
            'apns-push-type': 'alert',
            'apns-priority': msg.urgency === 'high' ? '10' : '5',
            'apns-expiration': String(Math.floor(Date.now() / 1000) + msg.ttlSeconds),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            aps: { alert: { title: msg.title, body: msg.body }, 'mutable-content': 1 },
            messageId: msg.messageId,
            ...(msg.url ? { url: msg.url } : {}),
            ...(msg.image ? { image: msg.image } : {}),
          }),
        });
        const reason = (() => {
          try {
            return (JSON.parse(res.body) as { reason?: string }).reason;
          } catch {
            return undefined;
          }
        })();
        if (res.status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered')
          return { ok: false, gone: `APNs: ${reason ?? 'the device token is no longer active'}` };
        if (res.status !== 200) throw new Error(`APNs answered ${res.status}: ${reason ?? res.body.slice(0, 200)}`);
        return { ok: true, providerMessageId: res.headers['apns-id'] ?? null };
      },
    };
  },
});

/** Development outbox: notifications are kept in memory, nothing is sent. */
export const pushOutbox: { to: PushRegistration; message: OutgoingPush }[] = [];

export const logPushAdapter = definePushAdapter({
  id: 'log',
  label: 'Development outbox (sends nothing)',
  kinds: ['web', 'fcm', 'apns'],
  config: z.object({}),
  secrets: z.object({}),
  create: () => ({
    async send(to, message) {
      if ('token' in to && to.token.startsWith('gone-')) return { ok: false, gone: 'test: the registration is gone' };
      pushOutbox.push({ to, message });
      return { ok: true, providerMessageId: `log-${message.messageId}` };
    },
  }),
});

export const pushAdapters = { webpush: webPushAdapter, fcm: fcmAdapter, apns: apnsAdapter, log: logPushAdapter } as const;
