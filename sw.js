const DB_NAME = "agi-tracker-notifications";
const STORE = "items";
const CHANNEL = "agi-tracker-notifications";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addNotification(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

self.addEventListener("push", (event) => {
  let data = { title: "AGI Tracker", body: "data.json was refreshed" };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  const record = {
    title: data.title,
    body: data.body,
    url: data.url || "/",
    timestamp: Date.now(),
    read: false,
  };

  event.waitUntil(
    (async () => {
      try {
        const id = await addNotification(record);
        try {
          new BroadcastChannel(CHANNEL).postMessage({ type: "new", id });
        } catch {
          // BroadcastChannel may be unsupported; the page reads IndexedDB on load anyway
        }
      } catch (err) {
        console.error("Failed to log notification:", err);
      }
      await self.registration.showNotification(data.title, {
        body: data.body,
        icon: data.icon,
        badge: data.badge,
        tag: "agi-tracker-update",
        renotify: true,
        data: { url: data.url || "/" },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const existing = wins.find((w) => w.url.endsWith(url));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
