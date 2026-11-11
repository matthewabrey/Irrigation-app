// Abreys Irrigation — keeps the app opening when there's no signal.
// Always fetched fresh when online; the saved copy is only used when the network fails.
const C = 'irr-shell-v2', SHELL = ['./', 'index.html', 'irrigation.webmanifest', 'irrigation-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  const shell = u.pathname.endsWith('/') || SHELL.some(s => s !== './' && u.pathname.endsWith('/' + s));
  if (e.request.method !== 'GET' || u.origin !== location.origin || !shell) return;
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
