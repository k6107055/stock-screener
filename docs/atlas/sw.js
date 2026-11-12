// Atlas：把畫面檔存在手機，打開秒出現；有新版會在背景下載，下次打開就換上
const V = 'atlas-shell-v16';
const SHELL = ['./', './index.html', './icon-180.png', './icon-192.png', './lwc-4.1.3.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  const mine = u.origin === location.origin && u.pathname.startsWith(new URL('./', self.registration.scope).pathname);
  const lib = u.hostname === 'unpkg.com';
  if (!mine && !lib) return;   // 資料（Google）一律走網路，不快取
  e.respondWith(caches.open(V).then(async c => {
    const key = req.mode === 'navigate' ? './' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r && r.ok) c.put(key, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
