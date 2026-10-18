// BLISS service worker: shows phone notifications (e.g. "Shift needs cover") and opens the app when tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "BLISS", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "BLISS", {
    body: d.body || "", icon: "/icon-192.png", badge: "/icon-192.png", tag: d.tag || d.url || "bliss",
    renotify: true, requireInteraction: true, data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if (new URL(c.url).origin === self.location.origin) { await c.focus(); c.postMessage({ open: url }); return; } }
    await self.clients.openWindow(url);
  })());
});
