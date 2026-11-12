
// ================= v2.12 個股頁「📊 財報」：EPS、三率、月營收、循環指標（FinMind），一次打包、存 6 小時 =================
function opFin(a) {
  const code = normCode(a.code);
  if (!/^\d{4,6}[A-Z]?$/.test(code)) throw new Error('股號格式不對');
  const ck = 'FIN2_' + code;
  const hit = a.force ? null : cacheGet(ck);
  if (hit) return hit;
  const y0 = Number(Utilities.formatDate(new Date(), TZ, 'yyyy'));
  const s10 = (y0 - 11) + '-01-01', s6 = (y0 - 7) + '-01-01';
  const ex = cacheGet('EX_' + code) === '.TWO' ? '.TWO' : '.TW';
  const fx = function (r) { const p = Object.assign({}, r); delete p.url; return p; };
  const reqs = [finmindReq('TaiwanStockFinancialStatements', code, s10), finmindReq('TaiwanStockBalanceSheet', code, s10),
    finmindReq('TaiwanStockCashFlowsStatement', code, s10), finmindReq('TaiwanStockMonthRevenue', code, s6),
    yahooReq(code + ex, '10y', '1mo'), yahooReq(code + (ex === '.TW' ? '.TWO' : '.TW'), '10y', '1mo')];
  const rs = UrlFetchApp.fetchAll(reqs.map(function (r) { return Object.assign({ url: r.url }, fx(r)); }));
  const rows = function (i, label) { try { return fmRows(rs[i], label); } catch (e) { if (i === 0) throw e; console.warn(e); return []; } };
  const isr = rows(0, '財報'), bs = rows(1, '資產負債表'), cf = rows(2, '現金流量表'), mr = rows(3, '月營收');
  const Q = {};
  const q = function (d) { d = String(d).slice(0, 10); return Q[d] || (Q[d] = { d: d }); };
  const yi = function (v) { return v == null || v === '' ? null : Math.round(Number(v) / 1e6) / 100; };   // 元 → 億（2 位小數）
  const IS = { Revenue: 'rev', GrossProfit: 'gp', OperatingIncome: 'op', PreTaxIncome: 'pti', IncomeAfterTaxes: 'ni' };
  isr.forEach(function (r) { if (IS[r.type]) q(r.date)[IS[r.type]] = yi(r.value); else if (r.type === 'EPS') q(r.date).eps = Number(r.value); });
  bs.forEach(function (r) {
    if (/_per$/.test(r.type)) return;
    if (r.type === 'Inventories') q(r.date).inv = yi(r.value);
    else if (/^ContractLiabilit/i.test(r.type)) q(r.date).cl = Math.round(((q(r.date).cl || 0) + yi(r.value)) * 100) / 100;
  });
  // 現金流量表是「年初到該季累計」→ 換成單季
  const cum = {};
  cf.forEach(function (r) {
    const k = r.type === 'PropertyAndPlantAndEquipment' ? 'capex' : r.type === 'Depreciation' ? 'dep' : null;
    if (!k) return;
    const d = String(r.date).slice(0, 10), y = d.slice(0, 4);
    (cum[k + y] = cum[k + y] || []).push({ d: d, v: Math.abs(Number(r.value) || 0) });
  });
  Object.keys(cum).forEach(function (kk) {
    const k = kk.replace(/\d{4}$/, ''), arr = cum[kk].sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    let prev = 0;
    arr.forEach(function (x) { q(x.d)[k] = yi(Math.max(0, x.v - prev)); prev = x.v; });
  });
  const qs = Object.keys(Q).sort().map(function (d) { return Q[d]; }).filter(function (x) { return x.eps != null || x.rev != null; }).slice(-44);
  const m = mr.map(function (r) { return { ym: r.revenue_year + '-' + ('0' + r.revenue_month).slice(-2), rev: yi(r.revenue) }; })
    .sort(function (a, b) { return a.ym < b.ym ? -1 : 1; }).slice(-84);
  let px = [];
  for (let i = 4; i < 6 && !px.length; i++) {
    const y = yahooResult(rs[i]);
    if (!y || !y.timestamp) continue;
    const qd = y.indicators.quote[0];
    y.timestamp.forEach(function (ts, j) {
      const c = qd.close[j]; if (c == null) return;
      const o = qd.open[j] != null ? qd.open[j] : c, h = qd.high[j] != null ? qd.high[j] : c, l = qd.low[j] != null ? qd.low[j] : c;
      const ym = Utilities.formatDate(new Date(ts * 1000), TZ, 'yyyy-MM');
      if (px.length && px[px.length - 1].ym === ym) px.pop();
      px.push({ ym: ym, p: Math.round((o + h + l + c) / 4 * 100) / 100 });   // 月均價（開高低收平均，近似）
    });
  }
  // 法人預估（優分析）：今年以後各年度最新一筆
  let est = [];
  try {
    const eh = estHist(code), seen = {};
    (eh.rows || []).forEach(function (r) { if (!seen[r.y] && Number(r.y) >= y0) { seen[r.y] = 1; est.push({ y: r.y, eps: r.eps, d: r.d }); } });
    est.sort(function (a, b) { return a.y < b.y ? -1 : 1; });
  } catch (e) { /* 沒有法人預估就算了 */ }
  const out = { code: code, q: qs, m: m, px: px, est: est, at: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') };
  if (qs.length) cachePut(ck, out, 6 * 3600);
  return out;
}
