
// ================= v2.9 個股頁「📚 資料」：小幫手雲端資料夾裡這檔的所有檔案（報告、券商 PDF、圖片、筆記）=================
function opStockFiles(a) {
  const code = normCode(a.code);
  if (!/^\d{4,6}[A-Z]?$/.test(code)) throw new Error('股號格式不對');
  const ck = 'SF_' + code;
  const hit = a.force ? null : cacheGet(ck);
  if (hit) return hit;
  const rootId = P('ROOT_FOLDER_ID') || DEF.ROOT_FOLDER_ID;
  const re = new RegExp('^' + code + '(?![0-9A-Z])');
  let folder = null;
  const fit = DriveApp.searchFolders("'" + rootId + "' in parents and title contains '" + code + "' and trashed = false");
  while (fit.hasNext()) { const f = fit.next(); if (re.test(f.getName())) { folder = f; break; } }
  const out = { code: code, folder: folder ? folder.getUrl() : '', items: [] };
  if (!folder) { cachePut(ck, out, 300); return out; }
  const kindOf = function (n, mt) {
    if (mt === MimeType.GOOGLE_DOCS) {
      if (n.indexOf('_整合報告_') >= 0) return 'rep';
      if (n.indexOf('_優分析小助理_') >= 0) return 'raw';
      if (n.indexOf('_我的筆記') >= 0) return 'memo';
      if (/（轉檔）$/.test(n)) return '';
      return 'doc';
    }
    if (mt === MimeType.PDF) return 'pdf';
    if (/^image\//.test(mt)) return 'img';
    return 'other';
  };
  const walk = function (f, depth, sub) {
    const it = f.getFiles();
    while (it.hasNext() && out.items.length < 300) {
      const x = it.next(), n = x.getName(), mt = x.getMimeType(), k = kindOf(n, mt);
      if (!k || /_舊版/.test(n)) continue;
      const t = (k === 'memo' ? x.getLastUpdated() : x.getDateCreated()).getTime();
      out.items.push({ k: k, n: n, id: x.getId(), u: x.getUrl(), t: t, d: Utilities.formatDate(new Date(t), TZ, 'yyyy-MM-dd'), s: sub || '' });
    }
    if (depth > 0) { const ft = f.getFolders(); while (ft.hasNext()) { const g = ft.next(); walk(g, depth - 1, g.getName()); } }
  };
  walk(folder, 1, '');
  out.items.sort(function (x, y) { return y.t - x.t; });
  cachePut(ck, out, 300);
  return out;
}
