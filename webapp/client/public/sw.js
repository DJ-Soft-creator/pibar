// Service worker of the PiBar webapp – only for web push (task J3): show the notification, open the session on a
// tap, renew a subscription the browser replaced. Deliberately no fetch handler: nothing is cached, the app always
// loads fresh from the server.
/* eslint-env serviceworker */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || "PiBar", {
      body: msg.body || "",
      tag: msg.tag || undefined,
      data: msg.data || null,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = windows[0];
      if (win) {
        await win.focus();
        if (data) win.postMessage({ type: "pibar-open", data });
        return;
      }
      const url = data ? `/?open=${encodeURIComponent(JSON.stringify(data))}#/chat` : "/";
      await self.clients.openWindow(url);
    })(),
  );
});

// the browser replaced the subscription (keys rotated): subscribe again with the same server key and tell the server
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    (async () => {
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch("/api/cmd/push_subscribe", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), lang: (self.navigator.language || "en").slice(0, 2) }),
      });
    })(),
  );
});
