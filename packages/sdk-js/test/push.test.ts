import { describe, expect, it } from 'vitest';
import { createAnalytics } from '../src/index';
import { keyBytes } from '../src/push';

// Web push in the SDK, with a fake service worker container and a fake collector.

const publicKey = `B${'A'.repeat(86)}`;

function setup(permission: NotificationPermission) {
  const calls: { url: string; body?: unknown }[] = [];
  const sub = {
    endpoint: 'https://push.example.com/s/1',
    toJSON: () => ({ endpoint: 'https://push.example.com/s/1', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => true,
  };
  let subscribedWith: Uint8Array | undefined;
  const reg = {
    pushManager: {
      subscribe: async (o: { applicationServerKey: Uint8Array }) => {
        subscribedWith = o.applicationServerKey;
        return sub;
      },
      getSubscription: async () => sub,
    },
  };
  const am = createAnalytics({
    writeKey: 'wk',
    host: 'https://collect.example.com',
    storage: null,
    page: () => ({ path: '/', url: 'https://shop.example.com/', title: '', referrer: '' }),
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(url.endsWith('/config') ? { webPush: { publicKey } } : { ok: true }), { status: 200 });
    }) as typeof fetch,
    push: {
      serviceWorker: { register: async () => reg, getRegistration: async () => reg } as unknown as ServiceWorkerContainer,
      Notification: { requestPermission: async () => permission },
    },
  });
  return { am, calls, subscribed: () => subscribedWith };
}

describe('web push', () => {
  it('subscribes with the VAPID key, registers the device and records consent', async () => {
    const { am, calls, subscribed } = setup('granted');
    expect(await am.subscribePush()).toBe('subscribed');
    expect(subscribed()).toEqual(keyBytes(publicKey));
    const reg = calls.find((c) => c.url.endsWith('/v1/push/subscribe'));
    expect(reg?.body).toMatchObject({ anonymousId: am.anonymousId, subscription: { endpoint: 'https://push.example.com/s/1' } });
    expect(am.consent).toMatchObject({ marketing_push: true });

    await am.unsubscribePush();
    expect(calls.find((c) => c.url.endsWith('/v1/push/unsubscribe'))?.body).toEqual({ endpoint: 'https://push.example.com/s/1' });
    expect(am.consent).toMatchObject({ marketing_push: false });
  });

  it('does nothing more when the visitor says no', async () => {
    const { am, calls } = setup('denied');
    expect(await am.subscribePush()).toBe('denied');
    expect(calls.some((c) => c.url.endsWith('/v1/push/subscribe'))).toBe(false);
    expect(am.consent?.marketing_push).toBeUndefined();
  });
});
