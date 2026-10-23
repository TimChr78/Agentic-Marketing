// Agentic Marketing service worker: shows push notifications and opens their link on click.
// Serve it from your site's root (e.g. https://www.example.com/am-sw.js) so it may show
// notifications for every page, and subscribe with analytics.subscribePush().
// If you already have a service worker, add these two listeners to it instead.

self.addEventListener('push', (event) => {
  let n = {};
  try {
    n = event.data ? event.data.json() : {};
  } catch (_) {
    n = { title: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(n.title || '', {
      body: n.body,
      icon: n.icon,
      image: n.image,
      tag: n.messageId,
      data: { url: n.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url;
  // The link is the platform's tracked redirect: the click is counted, then the page opens.
  if (url) event.waitUntil(self.clients.openWindow(url));
});
