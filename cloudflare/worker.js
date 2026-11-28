// Atlas 報價加速中繼站（Cloudflare Workers，免費方案就夠）v2
// 為什麼：Apps Script 每次要先「叫醒」又在美國，報價一次 1～3 秒；Cloudflare 在台灣有機房，約 0.1～0.3 秒
// 只轉公開行情（Yahoo奇摩／Yahoo Finance／證交所／期交所），不碰你的任何個人資料
// 用法：
//   GET /q?c=2330,2454&i=1(要加權/櫃買)&f=1(要台指期)&b=1(要五檔)
//   GET /live?c=2330      個股：報價＋五檔＋今天分時
//   GET /k?c=2330         個股：日 K（約 7 年）
const ALLOW = ['https://k6107055.github.io'];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CODE_RE = /^\d{4,6}[A-Z]?$/;

// 小快取（存在這台 Cloudflare 機器的記憶體；workers.dev 不能用 Cache API，所以用這個）
const MEM = new Map();
async function memo(key, ms, fn) {
  const h = MEM.get(key);
  if (h && Date.now() - h.t < ms) return h.p;
  const p = fn(); MEM.set(key, { t: Date.now(), p });
  p.catch(() => { if (MEM.get(key) && MEM.get(key).p === p) MEM.delete(key); });
  if (MEM.size > 500) MEM.delete(MEM.keys().next().value);
  return p;
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOW.includes(origin) ? origin : ALLOW[0], 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
    const json = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: cors });
    const t0 = Date.now();
    try {
      if (url.pathname === '/q') return json(Object.assign(await quotes(url), { ms: Date.now() - t0 }));
      if (url.pathname === '/live') return json(Object.assign(await live(url), { ms: Date.now() - t0 }));
      if (url.pathname === '/k') return json(Object.assign(await kline(url), { ms: Date.now() - t0 }));
    } catch (e) { return json({ error: String(e && e.message || e) }, 502); }
    return new Response('Atlas 報價加速 OK v2', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  },
};

async function quotes(url) {
  const codes = (url.searchParams.get('c') || '').split(',').map(s => s.trim().toUpperCase()).filter(c => CODE_RE.test(c)).slice(0, 80);
  const wantIdx = url.searchParams.get('i') === '1', wantBook = url.searchParams.get('b') === '1', wantFut = url.searchParams.get('f') === '1';
  const key = 'q|' + codes.join(',') + '|' + wantIdx + wantBook + wantFut;
  return memo(key, 1500, async () => {   // 同一份報價 1.5 秒內共用，不重複去抓
    const out = { q: {}, idx: null, open: marketOpen(), at: twNow().toISOString().slice(11, 19), src: 'cf' };
    const futP = wantFut ? memo('fut', 3000, futFetch).catch(() => null) : Promise.resolve(null);
    try { const ytw = await ytwFetch(codes, wantIdx); Object.assign(out.q, ytw.q); out.idx = ytw.idx; } catch (e) { /* 改用證交所 */ }
    const miss = codes.filter(c => !out.q[c]);
    if (miss.length || (wantBook && codes.length) || (wantIdx && !out.idx)) {
      try {
        const m = await misFetch(wantBook ? codes : miss, wantIdx && !out.idx);
        Object.keys(m.q).forEach(c => { if (!out.q[c]) out.q[c] = m.q[c]; else if (m.q[c].book) out.q[c].book = m.q[c].book; });
        if (m.idx) out.idx = m.idx;
      } catch (e) { /* 沒關係 */ }
    }
    const fut = await futP;
    if (fut) (out.idx = out.idx || {}).fut = fut;
    return out;
  });
}

// 個股頁一打開要的：報價＋五檔＋今天分時，一次給
async function live(url) {
  const code = (url.searchParams.get('c') || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new Error('代號不對');
  const [qq, intr] = await Promise.all([
    quotes(new URL('https://x/q?b=1&c=' + code)),
    memo('i|' + code, 20000, () => intrFetch(code)).catch(() => null),
  ]);
  const q = qq.q[code];
  if (!q) throw new Error('抓不到報價');
  if (intr && !intr.prev && q.prev) intr.prev = q.prev;
  return { q, intr, open: qq.open, at: qq.at, src: 'cf' };
}

// Yahoo Finance 圖表資料（公開）：先試上市 .TW，再試上櫃 .TWO
async function yChart(code, range, interval) {
  for (const sfx of ['.TW', '.TWO']) {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + code + sfx + '?range=' + range + '&interval=' + interval + '&includePrePost=false',
      { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) continue;
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (res && res.timestamp && res.timestamp.length) return res;
  }
  return null;
}
async function intrFetch(code) {
  const res = await yChart(code, '1d', '1m');
  if (!res) return null;
  const qd = res.indicators.quote[0], t = [], p = [], v = [];
  res.timestamp.forEach((ts, i) => { const c = qd.close[i]; if (c == null) return; t.push(ts); p.push(r2(c)); v.push(Math.round((qd.volume[i] || 0) / 1000)); });
  const m = res.meta || {};
  return { t, p, v, prev: num(m.chartPreviousClose) || num(m.previousClose) || null };
}
async function kline(url) {
  const code = (url.searchParams.get('c') || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) throw new Error('代號不對');
  return memo('k|' + code, 600000, async () => {   // 日 K 十分鐘抓一次就好（今天那根由即時報價補）
    const res = await yChart(code, '7y', '1d');
    if (!res) throw new Error('抓不到 K 線');
    const qd = res.indicators.quote[0], k = { t: [], o: [], h: [], l: [], c: [], v: [] };
    res.timestamp.forEach((ts, i) => {
      if (qd.close[i] == null || qd.open[i] == null) return;
      const d = new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 10);
      if (k.t.length && k.t[k.t.length - 1] === d) return;
      k.t.push(d); k.o.push(r2(qd.open[i])); k.h.push(r2(qd.high[i])); k.l.push(r2(qd.low[i])); k.c.push(r2(qd.close[i])); k.v.push(Math.round((qd.volume[i] || 0) / 1000));
    });
    if (!k.t.length) throw new Error('K 線是空的');
    return { k, name: '', src: 'cf' };
  });
}

// 台指期近月（期交所行情網，日盤 08:45～13:45、夜盤 15:00～05:00）
async function futFetch() {
  const t = twNow(), hm = t.getUTCHours() * 100 + t.getUTCMinutes();
  const night = hm >= 1500 || hm < 500;
  const r = await fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.taifex.com.tw/futures/', Origin: 'https://mis.taifex.com.tw' },
    body: JSON.stringify({ MarketType: night ? '1' : '0', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const list = (j && j.RtData && j.RtData.QuoteList) || [];
  let best = null;
  list.forEach(x => {
    if (!/^TXF/.test(String(x.SymbolID || '')) || /-S$/.test(String(x.SymbolID))) return;   // 只要台指期，不要現貨列
    const p = num(x.CLastPrice), ref = num(x.CRefPrice), vol = num(x.CTotalVolume) || 0;
    if (!(p > 0) || !(ref > 0)) return;
    if (!best || vol > best.vol) best = { p, ref, vol, t: String(x.CTime || ''), name: String(x.DispCName || '') };
  });
  if (!best) return null;
  const tt = best.t.length === 6 ? best.t.slice(0, 2) + ':' + best.t.slice(2, 4) + ':' + best.t.slice(4) : best.t;
  return { p: best.p, y: best.ref, chg: r2(best.p - best.ref), pct: r2((best.p / best.ref - 1) * 100), t: tt, v: best.vol, name: best.name, night };
}

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
