# Push notifications

Push is a channel like e-mail and SMS: push templates (`psh_…`) with a purpose, the same send gateway (lawful basis, consent, frequency caps, quiet hours), and push nodes in journeys and broadcasts. One message goes to every device a person has registered:

| Devices | Provider (`pushProviders.create`) | What you need |
|---|---|---|
| Browsers (Chrome, Firefox, Edge, Safari 16+, iOS 16.4+ home-screen apps) | `webpush` | A contact for push services (`config.subject`, `mailto:` or `https:`). The VAPID keys are generated. |
| Android, and apps using Firebase | `fcm` | The Firebase project id and a service account key with the Firebase Cloud Messaging role. |
| iOS, iPadOS, macOS apps | `apns` | Team id, key id, the app's bundle id (`topic`) and the `.p8` token signing key. |

Credentials are sealed and never returned. A web push key pair cannot change (browsers subscribed with it); to move to a new one, add another provider and let browsers subscribe again.

## Browsers

1. Copy `packages/sdk-js/am-sw.js` to your site's root (it shows notifications and opens their link; if you have a service worker already, add its two listeners to yours).
2. Subscribe from a click (browsers ask for permission only after a user gesture):

   ```js
   button.onclick = async () => {
     const state = await analytics.subscribePush(); // 'subscribed' | 'denied' | 'unsupported' | 'unavailable'
   };
   ```

   A yes is also recorded as consent for `marketing_push` (pass `{ purpose: 'service_push' }` for service notifications). `analytics.unsubscribePush()` stops notifications in the browser and withdraws that consent.

## Apps

Register the device token from your app's backend with a server write key:

```http
POST /v1/push/subscribe
Authorization: Basic <server write key, base64 "key:">

{ "userId": "u-123", "kind": "fcm", "token": "<FCM registration token>" }
```

Use `"kind": "apns"` with the hex device token for Apple. `POST /v1/push/unsubscribe` with `{ "token": "…" }` forgets a device. Record consent the usual way (a `Segment Consent Preference Updated` event with `marketing_push`).

## Privacy

- A browser (public) write key registers a device for its own anonymous id only; the person is found through identity resolution once the browser identifies. Binding a device to a user id directly takes a server key, so nobody can have someone else's notifications sent to their browser.
- Endpoints and tokens are sealed with the workspace key; only a hash is stored in the clear, to recognise the same device again. `push.devices` and the data export show the kind and dates of a person's devices, never the endpoint.
- Web push payloads are encrypted for the browser (RFC 8291): the push service relays what it cannot read.
- Devices the push service reports gone (the browser or app unsubscribed) are deleted at the next send. Erasure deletes all of a person's devices.
- The link in a notification is the tracked redirect (`/c/…`), as in e-mail, so clicks are counted on the message.

Not built yet: rich actions (buttons), per-device language, a delivery receipt from the device (push services only confirm they accepted the message), and re-subscribing automatically on `pushsubscriptionchange`.
