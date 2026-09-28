// 回測／追蹤頁共用：資料讀取、格式化、單筆交易 K 線（含買賣點）
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const num = (v, d = 2) => v == null ? '-' : Number(v).toFixed(d);
const pct = (v, d = 1) => v == null ? '-' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%</span>`;
const sgn = (v, d = 2) => v == null ? '-' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${Number(v).toFixed(d)}</span>`;
async function getJSON(u){
  const r = await fetch(u + '?v=' + Date.now(), { cache: 'no-store' });
  if(!r.ok) throw new Error(r.status);
  return r.json();
}
const REASON = {
  stop: '停損', breakeven: '保本出場', ma50: '跌破50日線', holding: '持有中', ma50_next_open: '明天開盤賣',
  gap: '開盤跳空跌破停損，不買', chase: '開盤離樞紐點超過5%，不追', risk: '開盤後停損距離超過上限，不買',
};
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

let _chart = null;
function drawTradeChart(el, d, t){
  if(_chart){ _chart.remove(); _chart = null; }
  el.innerHTML = '';
  if(!d){ el.innerHTML = '<div class="empty">沒有這檔的 K 線資料</div>'; return; }
  const dk = dark();
  const chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: dk ? '#9aa3ae' : '#4b5563', fontSize: 11 },
    grid: { vertLines: { color: dk ? '#222' : '#f0f0f0' }, horzLines: { color: dk ? '#222' : '#f0f0f0' } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
  });
  const k = chart.addCandlestickSeries({ upColor: '#e5343d', downColor: '#16a34a', borderVisible: false, wickUpColor: '#e5343d', wickDownColor: '#16a34a' });
  k.setData(d.t.map((x, i) => ({ time: x, open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i] })).filter(b => b.close != null));
  const m = chart.addLineSeries({ color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  m.setData(d.t.map((x, i) => d.ma50[i] == null ? { time: x } : { time: x, value: d.ma50[i] }));
  const marks = [];
  if(t.sig) marks.push({ time: t.sig, position: 'aboveBar', color: '#8b5cf6', shape: 'circle', text: '訊號' });
  if(t.in) marks.push({ time: t.in, position: 'belowBar', color: '#2563eb', shape: 'arrowUp', text: `買 ${num(t.entry)}` });
  if(t.be) marks.push({ time: t.be, position: 'aboveBar', color: '#0ea5e9', shape: 'square', text: '保本' });
  if(t.out && t.status === 'closed') marks.push({ time: t.out, position: 'aboveBar', color: t.pct > 0 ? '#e5343d' : '#16a34a', shape: 'arrowDown', text: `賣 ${num(t.exit)}` });
  marks.sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : 0);
  k.setMarkers(marks);
  if(t.stop) k.createPriceLine({ price: t.stop, color: '#16a34a', lineWidth: 1, lineStyle: 2, title: '停損' });
  if(t.entry) k.createPriceLine({ price: t.entry, color: '#2563eb', lineWidth: 1, lineStyle: 2, title: '買價' });
  const idx = s => { const i = d.t.indexOf(s); return i < 0 ? null : i; };
  const a = idx(t.in) ?? d.t.length - 60, b = idx(t.out) ?? d.t.length - 1;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, a - 70), to: Math.min(d.t.length + 3, b + 15) });
  _chart = chart;
}

function openTrade(t, chartUrl){
  const mo = $('#modal');
  mo.querySelector('.mt b').textContent = `${t.id} ${t.name}`;
  const res = t.status === 'closed' ? `${REASON[t.reason] || t.reason}，${t.days} 天，報酬 ${pct(t.pct, 2)}（${sgn(t.r)}R）`
            : t.status === 'open' ? `持有中 ${t.days} 天，目前 ${pct(t.pct, 2)}（${sgn(t.r)}R）` : (REASON[t.reason] || t.status);
  mo.querySelector('.minfo').innerHTML =
    `訊號日 ${t.sig}｜評分 ${t.score}｜RS ${t.rs ?? '-'}｜買 ${t.in || '-'} @ ${num(t.entry)}｜停損 ${num(t.stop)}` +
    `${t.out && t.status === 'closed' ? `｜賣 ${t.out} @ ${num(t.exit)}` : ''}<br>${res}` +
    `　<a href="https://tw.tradingview.com/chart/?symbol=${t.ex}:${t.id}" target="_blank" rel="noopener">TradingView</a>`;
  mo.style.display = 'flex';
  getJSON(chartUrl).then(d => drawTradeChart(mo.querySelector('.chart'), d, t)).catch(() => drawTradeChart(mo.querySelector('.chart'), null, t));
}
document.addEventListener('DOMContentLoaded', () => {
  const mo = $('#modal'); if(!mo) return;
  mo.querySelector('button').onclick = () => { mo.style.display = 'none'; };
  mo.onclick = e => { if(e.target === mo) mo.style.display = 'none'; };
});

function tradeRow(t){
  const tag = t.status === 'open' ? '<span class="tag open">持有中</span>'
            : t.status === 'closed' ? (t.pct > 0 ? '<span class="tag win">賺</span>' : '<span class="tag loss">賠</span>')
            : '<span class="tag">未成交</span>';
  return `<tr class="click" data-k="${esc(t.id + '|' + t.sig)}">
    <td class="l">${tag}</td><td class="l">${t.sig}</td><td class="l"><b>${t.id}</b></td><td class="l">${esc(t.name)}</td>
    <td>${t.score ?? '-'}</td><td>${t.rs ?? '-'}</td>
    <td class="l">${t.in || '-'}</td><td>${num(t.entry)}</td><td>${num(t.stop)}</td>
    <td class="l">${t.status === 'closed' ? t.out : '-'}</td><td>${t.status === 'closed' ? num(t.exit) : '-'}</td>
    <td class="l">${esc(REASON[t.reason] || t.reason || '')}</td>
    <td>${t.days ?? '-'}</td><td>${sgn(t.r)}</td><td>${pct(t.pct, 2)}</td></tr>`;
}
const TRADE_HEAD = `<tr><th class="l">結果</th><th class="l" data-k="sig">訊號日</th><th class="l" data-k="id">代號</th><th class="l">名稱</th>
  <th data-k="score">評分</th><th data-k="rs">RS</th><th class="l" data-k="in">買進日</th><th>買價</th><th>停損</th>
  <th class="l" data-k="out">賣出日</th><th>賣價</th><th class="l">出場原因</th><th data-k="days">天數</th><th data-k="r">R 倍數</th><th data-k="pct">報酬（扣成本）</th></tr>`;
