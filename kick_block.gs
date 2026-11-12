
// ================= v2.10 GitHub 排程改由這裡叫（GitHub 自己的排程常延遲或卡住；Google 的定時很準）=================
// 需要指令碼屬性 GH_TOKEN（GitHub 細粒度金鑰：只開 stock-screener 的 Actions 讀寫）；沒設就什麼都不做
function ghDispatch_(wf, inputs) {
  const tk = P('GH_TOKEN'); if (!tk) return 'no-token';
  const r = UrlFetchApp.fetch('https://api.github.com/repos/k6107055/stock-screener/actions/workflows/' + wf + '/dispatches', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    payload: JSON.stringify({ ref: 'main', inputs: inputs || {} }) });
  return r.getResponseCode();
}
function ghKick() {
  if (!P('GH_TOKEN')) return;
  const now = new Date(), hh = Number(Utilities.formatDate(now, TZ, 'H')), wd = Number(Utilities.formatDate(now, TZ, 'u')); // u: 1=一 … 7=日
  const props = PropertiesService.getScriptProperties(), hourKey = Utilities.formatDate(now, TZ, 'yyyyMMddHH');
  const once = function (name) { const k = 'GHK_' + name; if (props.getProperty(k) === hourKey) return false; props.setProperty(k, hourKey); return true; };
  const log = [];
  // 觀測站：07～23 點每 30 分鐘抓即時重大訊息；07、12、17、21 點那一小時第一次抓整套
  if (hh >= 7 && hh <= 23) {
    const full = [7, 12, 17, 21].indexOf(hh) >= 0 && once('infoFull');
    log.push('info ' + ghDispatch_('info.yml', { full: full ? '1' : '0' }));
  }
  // YouTube 筆記：07、19 點
  if ((hh === 7 || hh === 19) && once('yt')) log.push('yt ' + ghDispatch_('yt.yml'));
  // 每日籌碼：平日 16、21 點（官方資料出來之後）
  if (wd <= 5 && (hh === 16 || hh === 21) && once('chips')) log.push('chips ' + ghDispatch_('chips.yml'));
  if (log.length) console.log('GitHub 排程：' + log.join('，'));
}
// 在編輯器執行一次：每 30 分鐘叫一次 ghKick
function setupGhKick() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'ghKick') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('ghKick').timeBased().everyMinutes(30).create();
  console.log('已設定：每 30 分鐘 ghKick（有 GH_TOKEN 才會動作）');
}
