// Minimal service worker: makes the app installable and keeps the shell available offline.
// It is registered as /sw.js?v=<build version>, so every release gets its own cache and the old ones are deleted on activation.
// Only the app shell (HTML and the assets it references) is stored; everything else comes from the network or the HTTP cache
// (/assets/ files are immutable there). API, badge and event-stream requests are never cached.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `pw-shell-${VERSION}`;

async function precache() {
  try {
    const cache = await caches.open(CACHE);
    const res = await fetch('/', { cache: 'reload' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return;
    const html = await res.clone().text();
    await cache.put('/', res);
    // the entry scripts and styles named in the shell, so that it also starts offline
    const urls = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]))];
    await Promise.all(urls.map((u) => cache.add(u).catch(() => {})));
  } catch { /* offline during install: the shell is cached on the first online navigation */ }
}

self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(precache()); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('pw-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/badge/') || url.pathname === '/metrics') return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok && (r.headers.get('content-type') || '').includes('text/html')) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
      return r;
    }).catch(() => caches.match('/')));
    return;
  }
  // assets: served from the shell cache only when precached for this version; otherwise the browser's own (immutable) HTTP cache decides
  if (url.pathname.startsWith('/assets/')) e.respondWith(caches.open(CACHE).then((c) => c.match(req)).then((hit) => hit || fetch(req)));
});

// Notifications shown through the worker: a click focuses an open app window (going to notification.data.url if one was given) or opens a new one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const asked = e.notification.data && e.notification.data.url;
  let target = new URL('/dashboard', self.location.origin);
  try { const u = new URL(asked || '/dashboard', self.location.origin); if (u.origin === self.location.origin) target = u; } catch { /* keep the default */ }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (win) {
      try {
        await win.focus();
        if (asked && new URL(win.url).href !== target.href && 'navigate' in win) await win.navigate(target.href);
        return;
      } catch { /* fall through to a new window */ }
    }
    await self.clients.openWindow(target.href);
  })());
});
