// Web push in the browser: register the service worker, ask for permission, subscribe with the
// workspace's VAPID key and hand the subscription to the collector. The visitor's yes is also
// recorded as consent for the purpose (by default marketing_push); unsubscribing withdraws it.

export type PushState = 'subscribed' | 'denied' | 'unsupported' | 'unavailable';

export interface PushOptions {
  /** URL of the service worker that shows notifications (copy am-sw.js from the SDK). Default /am-sw.js. */
  serviceWorker?: string;
  /** The consent purpose a yes stands for. Default marketing_push. */
  purpose?: string;
}

export interface PushHost {
  host: string;
  auth: string;
  fetch: typeof fetch;
  /** The browser's anonymous id: the collector binds a browser key's registrations to it only. */
  anonymousId(): string;
  setConsent(choice: Record<string, boolean>): void;
  /** Injection point for tests; default: the browser's. */
  env?: { serviceWorker?: ServiceWorkerContainer; Notification?: { requestPermission(): Promise<NotificationPermission> } };
}

/** VAPID keys travel base64url; PushManager wants bytes. */
export function keyBytes(base64url: string): Uint8Array {
  const b = atob(base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const browserEnv = () => ({
  serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  Notification: typeof Notification !== 'undefined' ? Notification : undefined,
});

export async function subscribePush(h: PushHost, o: PushOptions = {}): Promise<PushState> {
  const env = h.env ?? browserEnv();
  if (!env.serviceWorker || !env.Notification) return 'unsupported';
  const res = await h.fetch(`${h.host}/v1/push/config`, { headers: { authorization: h.auth } });
  if (!res.ok) throw new Error(`push config answered ${res.status}`);
  const { webPush } = (await res.json()) as { webPush: { publicKey: string } | null };
  if (!webPush) return 'unavailable';
  const reg = await env.serviceWorker.register(o.serviceWorker ?? '/am-sw.js');
  if ((await env.Notification.requestPermission()) !== 'granted') return 'denied';
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(webPush.publicKey) as BufferSource });
  const sent = await h.fetch(`${h.host}/v1/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: h.auth },
    body: JSON.stringify({ anonymousId: h.anonymousId(), subscription: sub.toJSON() }),
  });
  if (!sent.ok) throw new Error(`push subscribe answered ${sent.status}`);
  h.setConsent({ [o.purpose ?? 'marketing_push']: true });
  return 'subscribed';
}

export async function unsubscribePush(h: PushHost, o: PushOptions = {}): Promise<void> {
  const env = h.env ?? browserEnv();
  h.setConsent({ [o.purpose ?? 'marketing_push']: false });
  const reg = await env.serviceWorker?.getRegistration(o.serviceWorker ?? '/am-sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await h.fetch(`${h.host}/v1/push/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: h.auth },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  await sub.unsubscribe();
}
