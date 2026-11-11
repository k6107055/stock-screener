
// ================= v2.7 指數詳細頁：加權／櫃買／台指期（分時＋日K；台指期分日盤／夜盤）=================
// 台指期分時：期交所行情網 mis.taifex.com.tw（官方公開行情，1 分 K）；日K：FinMind TaiwanFuturesDaily
// 加權／櫃買：Yahoo（和個股同一個來源）；加權分時抓不到時改用期交所的「臺指現貨」
function fx(req) { const p = Object.assign({}, req); delete p.url; return UrlFetchApp.fetch(req.url, p); }
function taifexPost(path, body) {
  return { url: 'https://mis.taifex.com.tw/futures/api/' + path, method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://mis.taifex.com.tw/futures/', Origin: 'https://mis.taifex.com.tw' } };
}
// 近月台指期代號（例：TXFK6），一小時查一次
function futNear() {
  const hit = cacheGet('FUTSYM'); if (hit) return hit;
  const r = fx(taifexPost('getQuoteList', { MarketType: '0', SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' }));
  const j = safeJson(r.getContentText()) || {};
  const ql = ((j.RtData || {}).QuoteList || []).filter(function (x) { return /^TXF\w\d-F$/.test(x.SymbolID); });
  if (!ql.length) throw new Error('期交所行情暫時抓不到');
  const o = { sym: ql[0].SymbolID.replace(/-F$/, ''), name: ql[0].DispCName };
  cachePut('FUTSYM', o, 3600);
  return o;
}
// 期交所 1 分 K → {t:[UTC 秒], o,h,l,c,v, prev, last, name}
function taifex1m(symId, night) {
  const r = fx(taifexPost('getChartData1M', { SymbolID: symId }));
  const d = ((safeJson(r.getContentText()) || {}).RtData) || null;
  if (!d || !d.Ticks) return null;
  const q = d.Quote || {}, cd = String(q.CDate || '');
  if (cd.length !== 8) return null;
  const y = +cd.slice(0, 4), m = +cd.slice(4, 6) - 1, dd = +cd.slice(6);
  const o = { t: [], o: [], h: [], l: [], c: [], v: [], prev: +q.CRefPrice || null, last: +q.CLastPrice || null, name: d.DispCName || '', date: cd,
    hi: +q.CHighPrice || null, lo: +q.CLowPrice || null, open: +q.COpenPrice || null, vol: +q.CTotalVolume || null, oi: +q.OpenInterest || null };
  d.Ticks.forEach(function (k) {
    const hh = +String(k[0]).slice(0, 2), mi = +String(k[0]).slice(2, 4);
    const ts = Date.UTC(y, m, dd + (night && hh < 15 ? 1 : 0), hh, mi) / 1000 - 8 * 3600;
    if (o.t.length && ts <= o.t[o.t.length - 1]) return;
    o.t.push(ts); o.o.push(+k[1]); o.h.push(+k[2]); o.l.push(+k[3]); o.c.push(+k[4]); o.v.push(+k[5] || 0);
  });
  return o;
}
function futSessNow() {
  const hm = Number(Utilities.formatDate(new Date(), TZ, 'HHmm'));
  return hm >= 1500 || hm < 845 ? 'night' : 'day';
}
function idxIntr(s, sess) {
  const ck = 'IXI_' + s + '_' + (sess || '');
  const hit = cacheGet(ck); if (hit) return hit;
  let out = null;
  if (s === 'fut') {
    const f = futNear();
    out = taifex1m(f.sym + (sess === 'night' ? '-M' : '-F'), sess === 'night');
    if (out) { out.sym = f.sym; out.sess = sess; }
  } else {
    try {   // Yahoo奇摩（台灣站）1 分線，加權、櫃買都有，昨收正確
      const rq = ytwReq([]); rq.url = 'https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacLibraCharts;symbols=' + encodeURIComponent(JSON.stringify([s === 'otc' ? '^TWOII' : '^TWII'])) + ';type=tick';
      const j = safeJson(fx(rq).getContentText());
      const y = j && j[0] && j[0].chart;
      if (y && y.timestamp) {
        const qd = y.indicators.quote[0], vv = qd.volume || [];
        out = { t: [], o: [], h: [], l: [], c: [], v: [], prev: +(y.meta.previousClose || y.meta.chartPreviousClose || 0) || null };
        y.timestamp.forEach(function (ts, i) { const c = qd.close[i]; if (c == null) return; out.t.push(ts); out.o.push(r2(qd.open && qd.open[i] != null ? qd.open[i] : c));
          out.h.push(r2(qd.high && qd.high[i] != null ? qd.high[i] : c)); out.l.push(r2(qd.low && qd.low[i] != null ? qd.low[i] : c)); out.c.push(r2(c)); out.v.push(Math.round(vv[i] || 0)); });
        if (!out.t.length) out = null;
      }
    } catch (e) { console.warn('指數分時 Yahoo奇摩 失敗：' + e); }
    if (!out && s === 'twse') { try { out = taifex1m('TXF-S', false); if (out) out.v = out.v.map(function () { return 0; }); } catch (e) { /* 沒關係 */ } }
  }
  if (out) cachePut(ck, out, (s === 'fut' || marketOpen()) ? 20 : 600);
  return out;
}
// 台指期日K：每天每個盤別取成交量最大的那個月份（＝近月，換月時自動接到次月）
function futDaily() {
  const hit = cacheGet('FUTK'); if (hit) return hit;
  const start = Utilities.formatDate(new Date(Date.now() - 420 * 86400000), TZ, 'yyyy-MM-dd');
  const rows = fmRows(fx(finmindReq('TaiwanFuturesDaily', 'TX', start)), '台指期日K');
  const best = { position: {}, after_market: {} };
  rows.forEach(function (r) {
    if (/\//.test(String(r.contract_date)) || !(+r.close > 0) || !(+r.open > 0)) return;
    const b = best[r.trading_session]; if (!b) return;
    const d = String(r.date).slice(0, 10);
    if (!b[d] || +r.volume > +b[d].volume) b[d] = r;
  });
  const mk = function (m) {
    const o = { t: [], o: [], h: [], l: [], c: [], v: [] };
    Object.keys(m).sort().forEach(function (d) { const r = m[d]; o.t.push(d); o.o.push(+r.open); o.h.push(+r.max); o.l.push(+r.min); o.c.push(+r.close); o.v.push(+r.volume || 0); });
    return o.t.length ? o : null;
  };
  const out = { day: mk(best.position), night: mk(best.after_market) };
  cachePut('FUTK', out, marketOpen() ? 1800 : 3600);
  return out;
}
function idxDaily(s) {
  if (s === 'fut') return futDaily();
  const ck = 'IXK_' + s;
  const hit = cacheGet(ck); if (hit) return hit;
  let k = null;
  try {   // 官方收盤資料（FinMind：TAIEX／TPEx），量＝成交金額（億元）
    const start = Utilities.formatDate(new Date(Date.now() - 600 * 86400000), TZ, 'yyyy-MM-dd');
    const rows = fmRows(fx(finmindReq('TaiwanStockPrice', s === 'otc' ? 'TPEx' : 'TAIEX', start)), '指數日K');
    k = { t: [], o: [], h: [], l: [], c: [], v: [] };
    rows.forEach(function (r) { if (!(+r.close > 0)) return; k.t.push(String(r.date).slice(0, 10)); k.o.push(+r.open || +r.close); k.h.push(+r.max || +r.close); k.l.push(+r.min || +r.close); k.c.push(+r.close); k.v.push(Math.round((+r.Trading_money || 0) / 1e8)); });
    if (!k.t.length) k = null;
  } catch (e) { console.warn('指數日K FinMind 失敗：' + e); }
  if (!k && s === 'twse') { const y = yahooResult(fx(yahooReq('^TWII', '2y', '1d'))); k = y && y.timestamp ? yahooKline(y) : null; }
  const out = { day: k };
  if (k) cachePut(ck, out, marketOpen() ? 900 : 3600);
  return out;
}
function opIdxChart(a) {
  const s = ['twse', 'otc', 'fut'].indexOf(a.s) >= 0 ? a.s : 'twse';
  if (a.kt === 'k') return { s: s, k: idxDaily(s) };
  const sess = s === 'fut' ? (a.sess === 'day' || a.sess === 'night' ? a.sess : futSessNow()) : '';
  return { s: s, sess: sess, now: s === 'fut' ? futSessNow() : '', intr: idxIntr(s, sess), open: marketOpen() };
}
