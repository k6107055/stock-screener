// Atlas：畫面檔存在手機 → 打開瞬間出現；新版在背景更新
// v35：主畫面改回「先秀手機裡的（0 秒）」，背景抓新版；每次發新版這個檔的版本號會變 → 手機裝好新版後頁面自動重新整理一次
const V = 'atlas-shell-v35';
const SHELL = ['./icon-180.png', './icon-192.png', './lwc-4.1.3.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(async c => {
    // 主畫面加版本參數，繞過 GitHub CDN 的 10 分鐘舊快取，確保裝到的是新版
    const r = await fetch('./index.html?v=' + V, { cache: 'reload' });
    if (r.ok) await c.put('./', r);
    await c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
  }).then(() => self.skipWaiting()));
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
  if (!mine && !lib) return;   // 資料（Google、Cloudflare）一律走網路
  if (u.pathname.endsWith('/sw.js')) return;
  const page = req.mode === 'navigate' || u.pathname === base || u.pathname.endsWith('/index.html');
  e.respondWith(caches.open(V).then(async c => {
    const key = page ? './' : req;
    const hit = await c.match(key, { ignoreSearch: true });
    const net = fetch(page ? './index.html?v=' + V : req, { cache: 'no-cache' }).then(r => { if (r && r.ok) c.put(key, r.clone()); return r; });
    if (hit){ e.waitUntil(net.catch(() => {})); return hit; }   // 手機有就立刻用，背景順便更新
    return net;
  }));
});
