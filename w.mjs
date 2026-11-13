// Atlas 報價加速中繼站（Cloudflare Workers，免費方案就夠）
// 為什麼：Apps Script 每次要先「叫醒」又在美國，報價一次 1～3 秒；Cloudflare 在台灣有機房，約 0.1～0.3 秒
// 只轉公開行情（Yahoo奇摩股市即時報價，抓不到再用證交所），不碰你的任何個人資料
// 用法：GET /q?c=2330,2454&i=1(要加權/櫃買指數)&b=1(要五檔)
const ALLOW = ['https://k6107055.github.io'];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOW.includes(origin) ? origin : ALLOW[0], 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
    if (url.pathname !== '/q') return new Response('Atlas 報價加速 OK', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    const codes = (url.searchParams.get('c') || '').split(',').map(s => s.trim().toUpperCase()).filter(c => /^\d{4,6}[A-Z]?$/.test(c)).slice(0, 80);
    const wantIdx = url.searchParams.get('i') === '1', wantBook = url.searchParams.get('b') === '1';
    const out = { q: {}, idx: null, open: marketOpen(), at: twNow().toISOString().slice(11, 19), src: 'cf' };
    try {
      const ytw = await ytwFetch(codes, wantIdx);
      Object.assign(out.q, ytw.q); out.idx = ytw.idx;
    } catch (e) { /* 改用證交所 */ }
    const miss = codes.filter(c => !out.q[c]);
    if (miss.length || (wantBook && codes.length) || (wantIdx && !out.idx)) {
      try {
        const m = await misFetch(wantBook ? codes : miss, wantIdx && !out.idx);
        Object.keys(m.q).forEach(c => { if (!out.q[c]) out.q[c] = m.q[c]; else if (m.q[c].book) out.q[c].book = m.q[c].book; });
        if (m.idx) out.idx = m.idx;
      } catch (e) { /* 沒關係 */ }
    }
    return new Response(JSON.stringify(out), { headers: cors });
  },
};

function twNow() { return new Date(Date.now() + 8 * 3600e3); }
function marketOpen() { const t = twNow(), wd = t.getUTCDay(), hm = t.getUTCHours() * 100 + t.getUTCMinutes(); return wd >= 1 && wd <= 5 && hm >= 830 && hm <= 1335; }
const r2 = v => Math.round(v * 100) / 100;
function num(x) { if (x && typeof x === 'object') x = x.raw !== undefined ? x.raw : x.value; const n = parseFloat(String(x ?? '').replace(/,/g, '')); return isFinite(n) ? n : null; }
function fmtT(tm) {
  if (!tm) return ['', ''];
  const d = typeof tm === 'number' ? new Date(tm > 1e12 ? tm : tm * 1000) : new Date(tm);
  if (isNaN(d)) return ['', ''];
  const t = new Date(d.getTime() + 8 * 3600e3).toISOString();
  return [t.slice(0, 10).replace(/-/g, ''), t.slice(11, 19)];
}
function ytwParse(x) {
  const price = num(x.price !== undefined ? x.price : x.regularMarketPrice);
  if (!(price > 0)) return null;
  const prev = num(x.regularMarketPreviousClose !== undefined ? x.regularMarketPreviousClose : x.previousClose);
  const [d, t] = fmtT(x.regularMarketTime || x.lastUpdated || x.time);
  const vol = num(x.volume !== undefined ? x.volume : x.regularMarketVolume);
  const sym = String(x.symbol || x.systexId || '');
  return { price, prev: prev > 0 ? prev : null, o: num(x.regularMarketOpen), h: num(x.regularMarketDayHigh), l: num(x.regularMarketDayLow),
    v: vol ? Math.round(vol / 1000) : 0, name: String(x.symbolName || x.name || ''), ex: /\.TWO$/.test(sym) ? 'otc' : 'tse', d, t, src: 'Yahoo奇摩',
    up: num(x.limitUpPrice), down: num(x.limitDownPrice), traded: true, book: null, sym };
}
async function ytwFetch(codes, withIdx) {
  const syms = [];
  codes.forEach(c => syms.push(c + '.TW', c + '.TWO'));
  if (withIdx) syms.push('^TWII', '^TWOII');
  const out = { q: {}, idx: null };
  const chunks = [];
  for (let i = 0; i < syms.length; i += 60) chunks.push(syms.slice(i, i + 60));
  const res = await Promise.all(chunks.map(ch => fetch('https://tw.stock.yahoo.com/_td-stock/api/resource/StockServices.stockList;autoRefresh=' + Date.now() + ';fields=avgPrice%2Corderbook;symbols=' + encodeURIComponent(ch.join(',')),
    { headers: { 'User-Agent': UA, Referer: 'https://tw.stock.yahoo.com/' } }).then(r => r.ok ? r.json() : []).catch(() => [])));
  res.forEach(j => {
    const list = Array.isArray(j) ? j : (j.list || j.data || j.items || []);
    list.forEach(x => {
      const q = ytwParse(x); if (!q) return;
      if (/^\^TWO?II$/.test(q.sym)) { (out.idx = out.idx || {})[q.sym === '^TWOII' ? 'otc' : 'twse'] = { p: q.price, y: q.prev, chg: q.prev ? r2(q.price - q.prev) : null, pct: q.prev ? r2((q.price / q.prev - 1) * 100) : null, t: q.t, v: null }; return; }
      const c = q.sym.split('.')[0]; delete q.sym;
      if (c && !out.q[c]) out.q[c] = q;
    });
  });
  return out;
}
async function misFetch(codes, withIdx) {
  const chans = codes.map(c => 'tse_' + c + '.tw|otc_' + c + '.tw');
  if (withIdx) chans.unshift('tse_t00.tw|otc_o00.tw');
  const out = { q: {}, idx: null };
  if (!chans.length) return out;
  const r = await fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&_=' + Date.now() + '&ex_ch=' + encodeURIComponent(chans.slice(0, 30).join('|')),
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.twse.com.tw/stock/index.jsp' } });
  if (!r.ok) return out;
  const j = await r.json();
  (j.msgArray || []).forEach(m => {
    const z = parseFloat(m.z), y = parseFloat(m.y);
    if (m.c === 't00' || m.c === 'o00') { const p = z > 0 ? z : y; if (p > 0) (out.idx = out.idx || {})[m.c === 't00' ? 'twse' : 'otc'] = { p, y, chg: r2(p - y), pct: y ? r2((p / y - 1) * 100) : null, t: String(m.t || ''), v: m.v ? Math.round(parseFloat(m.v) / 100) : null }; return; }
    const nums = s => String(s || '').split('_').filter(String).map(Number);
    const bidP = nums(m.b), askP = nums(m.a), bidV = nums(m.g), askV = nums(m.f);
    const price = z > 0 ? z : (bidP[0] > 0 ? bidP[0] : (askP[0] > 0 ? askP[0] : y));
    if (!(price > 0) || out.q[m.c]) return;
    out.q[m.c] = { price, prev: y > 0 ? y : null, o: parseFloat(m.o) || null, h: parseFloat(m.h) || null, l: parseFloat(m.l) || null, v: parseFloat(m.v) || 0,
      name: String(m.n || ''), ex: m.ex, d: String(m.d || ''), t: String(m.t || ''), src: '證交所', up: parseFloat(m.u) || null, down: parseFloat(m.w) || null, traded: z > 0,
      book: { bid: bidP.map((p, i) => [p, bidV[i] || 0]).slice(0, 5), ask: askP.map((p, i) => [p, askV[i] || 0]).slice(0, 5) } };
  });
  return out;
}
