import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdapterDeps } from '../src/adapters/types';
import { apnsAdapter, fcmAdapter, type OutgoingPush, pushPayload } from '../src/push/adapters';

// #753: a push send is retried when one device's provider fails transiently, and a send whose
// provider accepted but whose response was lost is retried by the outbox. The payload therefore
// has to carry a key derived from the message id, so the provider collapses the retry instead of
// showing the notification twice.

const message: OutgoingPush = {
  messageId: 'msg_0192f3c4d5e6f708192a3b4c5d6e7f80',
  title: 'Your order shipped',
  body: 'It arrives on Tuesday.',
  url: null,
  icon: null,
  image: null,
  ttlSeconds: 3600,
  urgency: 'normal',
};

const noFetch = (async () => {
  throw new Error('unexpected fetch');
}) as typeof globalThis.fetch;

describe('push adapters: retry collapse keys (#753)', () => {
  it('sends apns-collapse-id derived from the message id', async () => {
    const seen: Record<string, string>[] = [];
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const deps: AdapterDeps = {
      fetch: noFetch,
      http2: async (_url, init) => {
        seen.push(init.headers ?? {});
        return { status: 200, headers: { 'apns-id': 'apns-1' }, body: '' };
      },
    };
    const transport = apnsAdapter.create(
      { teamId: 'TEAMID1234', keyId: 'KEYID12345', topic: 'com.example.shop', environment: 'sandbox', apiBase: 'https://apns.test' },
      { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
      deps,
    );

    expect(await transport.send({ kind: 'apns', token: 'device-token' }, message)).toMatchObject({ ok: true });
    // The same message on a retry must carry the same key: that is what collapses it at Apple.
    expect(await transport.send({ kind: 'apns', token: 'device-token' }, message)).toMatchObject({ ok: true });
    expect(seen.map((headers) => headers['apns-collapse-id'])).toEqual([message.messageId, message.messageId]);
  });

  it('keeps apns-collapse-id below Apple’s 64-byte limit', async () => {
    const seen: Record<string, string>[] = [];
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const deps: AdapterDeps = {
      fetch: noFetch,
      http2: async (_url, init) => {
        seen.push(init.headers ?? {});
        return { status: 200, headers: { 'apns-id': 'apns-1' }, body: '' };
      },
    };
    const transport = apnsAdapter.create(
      { teamId: 'TEAMID1234', keyId: 'KEYID12345', topic: 'com.example.shop', environment: 'sandbox', apiBase: 'https://apns.test' },
      { privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
      deps,
    );
    // Today's ids are 36 bytes, but the header is capped by Apple: a longer id must be condensed.
    const longId = `msg_${'a'.repeat(120)}`;
    expect(await transport.send({ kind: 'apns', token: 'device-token' }, { ...message, messageId: longId })).toMatchObject({ ok: true });
    expect(Buffer.byteLength(seen[0]?.['apns-collapse-id'] ?? '', 'utf8')).toBeLessThanOrEqual(64);
  });

  it('tags an FCM display notification so a retry replaces the first (#753)', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const deps: AdapterDeps = {
      fetch: (async (url, init) => {
        if (new URL(String(url)).host === 'token.test') return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
        sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
        return Response.json({ name: 'projects/shop-app/messages/1' });
      }) as typeof globalThis.fetch,
    };
    const transport = fcmAdapter.create(
      { projectId: 'shop-app', apiBase: 'https://fcm.test', tokenUrl: 'https://token.test' },
      { clientEmail: 'sender@example.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
      deps,
    );

    expect(await transport.send({ kind: 'fcm', token: 'fcm-token' }, message)).toMatchObject({ ok: true });
    const send = sent.find((s) => new URL(s.url).host === 'fcm.test')!;
    // Firebase ignores collapse_key on a message with a notification payload; the Android tag is
    // what replaces the first notification when the same message is retried.
    expect((send.body as { message: { android: { notification: { tag: string } } } }).message.android.notification.tag).toBe(
      message.messageId,
    );
    // A retry builds a byte-identical tag from the same message.
    expect(pushPayload(message).messageId).toBe(message.messageId);
  });
});
