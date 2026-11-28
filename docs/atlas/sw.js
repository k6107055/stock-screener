// Atlas：畫面檔存在手機，沒網路也打得開
// v32：主畫面改「先上網拿最新版（最多等 2.5 秒）→ 拿不到才用手機裡的」，而且繞過瀏覽器的 10 分鐘快取 → 一推新版，下次打開就是新的
const V = 'atlas-shell-v32';
const SHELL = ['./', './index.html', './icon-180.png', './icon-192.png', './lwc-4.1.3.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k.startsWith('atlas-shell')).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  const base = new URL('./', self.registration.scope).pathname;
  const mine = u.origin === location.origin && u.pathname.startsWith(base);
  const lib = u.hostname === 'unpkg.com';
  if (!mine && !lib) return;   // 資料（Google、Cloudflare）一律走網路，不快取
  const page = req.mode === 'navigate' || u.pathname === base || u.pathname.endsWith('/index.html');
  e.respondWith(caches.open(V).then(async c => {
    const key = page ? './' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(req, { cache: 'no-cache' }).then(r => { if (r && r.ok) c.put(key, r.clone()); return r; });
    if (!page) return hit || net.catch(() => hit);   // 圖示、圖表程式：手機有就直接用
    // 主畫面：先等網路最多 2.5 秒，拿到就是最新版；網路慢或沒網路就用手機裡的
    const timeout = new Promise(res => setTimeout(() => res(null), 2500));
    const r = await Promise.race([net.catch(() => null), timeout]);
    return r || hit || net;
  }));
});
