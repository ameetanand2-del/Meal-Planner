// Chorify Service Worker v2
const CACHE = 'chorify-v2';
const ASSETS = ['./chorify.html', './manifest.json', './icon.svg'];

// ── Install ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .catch(() => {}) // non-fatal if offline at install
      .then(() => self.skipWaiting()) // inside waitUntil — waits for cache before activating
  );
});

// ── Activate: clean old caches ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first, fall back to network ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        // Only cache same-origin responses
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      });
    }).catch(() => caches.match('./chorify.html'))
  );
});

// ── Push: show notification from a real push server (future use) ──
self.addEventListener('push', e => {
  let data = { title: 'Chorify', body: 'You have tasks due today!' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch(_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:               data.body,
      icon:               './icon.svg',
      badge:              './icon.svg',
      tag:                data.tag || 'chorify-default',
      requireInteraction: false,
      data:               data,
    })
  );
});

// ── Notification click: focus or open the app ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('chorify'));
      if (existing) return existing.focus();
      return self.clients.openWindow('./chorify.html');
    })
  );
});

// ── Message handler: schedule local timed notifications ──
//
// IMPORTANT iOS NOTE:
// iOS Safari suspends Service Workers aggressively when the PWA is backgrounded.
// setTimeout timers set here WILL be killed when the app is closed.
// This means SW timers only work while the app is open or very recently backgrounded.
//
// For reliable background notifications on iOS, a server-side push (FCM/APNs) is needed.
// The app handles this gracefully: it recalculates and re-sends notifications every time
// the user opens the app (via visibilitychange), so notifications are refreshed on each open.
// This gives reliable same-session notifications and next-open reminders.

const scheduledTimers = new Map();

self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SCHEDULE_NOTIFICATIONS') {
    // Always clear and replace — prevents duplicates
    scheduledTimers.forEach(t => clearTimeout(t));
    scheduledTimers.clear();

    const notifications = e.data.notifications || [];
    const now = Date.now();

    notifications.forEach(n => {
      const delay = n.fireAt - now;
      if (delay <= 0) return;                              // already past
      if (delay > 48 * 60 * 60 * 1000) return;           // cap at 48h — anything longer won't survive SW suspension anyway

      const timerId = setTimeout(() => {
        self.registration.showNotification(n.title, {
          body:               n.body,
          icon:               './icon.svg',
          badge:              './icon.svg',
          tag:                n.tag || 'chorify-task',
          requireInteraction: false,
        }).catch(() => {}); // swallow if permission was revoked
        scheduledTimers.delete(n.tag);
      }, delay);

      scheduledTimers.set(n.tag, timerId);
    });

    // Acknowledge back to the app
    if (e.source) {
      e.source.postMessage({ type: 'NOTIFICATIONS_SCHEDULED', count: notifications.length });
    }
  }

  if (e.data.type === 'CANCEL_NOTIFICATION') {
    const tag = e.data.tag;
    if (scheduledTimers.has(tag)) {
      clearTimeout(scheduledTimers.get(tag));
      scheduledTimers.delete(tag);
    }
  }
});
