
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
    try {
      const y = yahooResult(fx(yahooReq(s === 'otc' ? '^TWOII' : '^TWII', '1d', '1m')));
      if (y && y.timestamp) {
        const qd = y.indicators.quote[0];
        out = { t: [], o: [], h: [], l: [], c: [], v: [], prev: +(y.meta.chartPreviousClose || 0) || null };
        y.timestamp.forEach(function (ts, i) { if (qd.close[i] == null) return; out.t.push(ts); out.o.push(r2(qd.open[i] != null ? qd.open[i] : qd.close[i])); out.h.push(r2(qd.high[i] != null ? qd.high[i] : qd.close[i]));
          out.l.push(r2(qd.low[i] != null ? qd.low[i] : qd.close[i])); out.c.push(r2(qd.close[i])); out.v.push(Math.round((qd.volume[i] || 0) / 1e6)); });
        if (!out.t.length) out = null;
      }
    } catch (e) { console.warn('指數分時 Yahoo 失敗：' + e); }
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
  const sym = s === 'otc' ? '^TWOII' : '^TWII';
  const y = yahooResult(fx(yahooReq(sym, '2y', '1d')));
  let k = y && y.timestamp ? yahooKline(y) : null;
  if (k) { k.v = k.v.map(function (x) { return Math.round(x / 1000); }); cachePut(ck, k, marketOpen() ? 900 : 3600); }   // 量：百萬股
  return { day: k };
}
function opIdxChart(a) {
  const s = ['twse', 'otc', 'fut'].indexOf(a.s) >= 0 ? a.s : 'twse';
  if (a.kt === 'k') return { s: s, k: idxDaily(s) };
  const sess = s === 'fut' ? (a.sess === 'day' || a.sess === 'night' ? a.sess : futSessNow()) : '';
  return { s: s, sess: sess, now: s === 'fut' ? futSessNow() : '', intr: idxIntr(s, sess), open: marketOpen() };
}
