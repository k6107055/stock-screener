
// ================= v2.8 觀測站即時重大訊息（官方 RSS，打開 Atlas 觀測站就抓最新的，快取 60 秒）=================
const MSG_TYPES_ = [['財報', /財務報(告|表)|財報|自結|季報|年報/], ['營收', /營收|營業收入/], ['股利', /股利|配息|配股|除息|除權|盈餘分配/], ['庫藏股', /庫藏/],
  ['增減資', /增資|減資|可轉換|公司債|私募|發行新股|認股/], ['法說會', /法人說明會|法說|業績說明/], ['澄清', /澄清|媒體報導/],
  ['人事', /董事長|總經理|發言人|財務主管|會計主管|稽核主管|董事|監察人|經理人|辭任|解任|異動/], ['資產交易', /取得|處分|資產|土地|廠房|設備|投資|合併|收購|分割/],
  ['背書資金', /背書|保證|資金貸與/], ['股東會', /股東會|股東常會|臨時會/], ['訴訟處分', /訴訟|判決|罰鍰|處分|違約/]];
function opMopsLive() {
  const hit = cacheGet('MOPSRSS'); if (hit) return hit;
  const r = UrlFetchApp.fetch('https://mopsov.twse.com.tw/nas/rss/mopsrss201001.xml', { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (r.getResponseCode() !== 200) throw new Error('觀測站即時訊息暫時抓不到（' + r.getResponseCode() + '）');
  const t = r.getContentText('Big5');
  const out = [];
  t.split('<item>').slice(1).forEach(function (it) {
    const link = ((it.match(/<link>\s*<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || '').trim();
    const typek = (link.match(/TYPEK=(\w+)/) || [])[1];
    if (typek !== 'sii' && typek !== 'otc') return;
    const v = {};
    (link.match(/[?&]h\d*\d=[^&]*/g) || []).forEach(function (kv) { const m = kv.match(/h\d*(\d)=(.*)/); if (m) v[m[1]] = m[2]; });
    const code = v['1'] || '', ds = v['2'] || '', ts = String(v['3'] || '').replace(/\D/g, '');
    const title = ((it.match(/<description>\s*<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1] || '').replace(/\s*\r?\n\s*/g, '').trim();
    const nm = (it.match(/<title>\((\w+)\)([\s\S]*?)-重大訊息<\/title>/) || [])[2] || '';
    if (!code || ds.length !== 8 || !title) return;
    const tt = ('000000' + ts).slice(-6);
    let ty = '其他'; for (let i = 0; i < MSG_TYPES_.length; i++) { if (MSG_TYPES_[i][1].test(title)) { ty = MSG_TYPES_[i][0]; break; } }
    out.push({ k: 'msg', d: ds.slice(0, 4) + '-' + ds.slice(4, 6) + '-' + ds.slice(6), t: tt.slice(0, 2) + ':' + tt.slice(2, 4), c: code, n: nm, m: typek === 'sii' ? '上市' : '上櫃', ty: ty, s: title, r: '即時' });
  });
  cachePut('MOPSRSS', out, 60);
  return out;
}
