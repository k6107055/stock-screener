/**
 * LINE 股票檔案小幫手 v2.15（報告加入供應鏈順序、上下修性質、EPS 時間軸；同步上修雷達；v2.14 主程式放 GitHub，由啟動程式載入；v2.13 一鍵更新：GitHub＋Apps Script＋竄改猴；v2.12 X 長文抓全文＋圖片文字、存檔後自我檢查完整度；v2.11 連結不再卡住沒回應、額度查詢；v2.10 自動報告標示來源＋可關閉；v2.9 股號一律附股名、筆記判斷修正與一鍵改；v2.8 清單裡沒有的股號即時查證交所；v2.7 指令可打股名；補齊上櫃股票清單；v2.6 提高連結判斷準確率＋分錯了一鍵改；v2.5 一則多檔股票的整理自動拆到各公司；v2.4 圖片／PDF 用文字辨識判斷股票；v2.3 文字筆記 memo 自動歸檔；v2.2 報告改為決策卡＋證據的精簡版；v2.1 報告加入超額利潤期判斷；v2.0 美股：歸檔＋整合報告；小助理更新重點：追蹤推播 08:30／21:00、雷達、歷史紀錄）
 * ------------------------------------------------------------
 * v1.0 功能：把 PDF 轉傳給 LINE bot → 自動判斷股票／產業 → 重新命名
 *            → 存進 Google 雲端對應資料夾（沒有就自動建立）→ LINE 回報
 * v1.1 新增：「報告 3167」指令 → 工作清單 → Edge 上的竄改猴抓優分析小助理
 *            → 存成 Google 文件 → 排程任務寫整合報告 → LINE 推播連結
 * 架構：LINE Messaging API webhook → Google Apps Script 網頁應用程式 → Google Drive
 *
 * 指令碼屬性（專案設定 → 指令碼屬性）：
 *   LINE_CHANNEL_ACCESS_TOKEN  必填，LINE Developers 的長期 Channel access token
 *   ALLOWED_USER_ID            必填，你的 LINE userId（第一次傳訊息給 bot 時它會告訴你）
 *   ROOT_FOLDER_ID             選填，預設為「先進封裝追蹤」資料夾
 *   SCRAPE_KEY                 自動產生（執行 setupTriggers），竄改猴腳本要填同一串
 *
 * v1.1 升級後要做：執行一次 setupTriggers → 部署作業改成「新版本」
 * ------------------------------------------------------------
 */

// ===== 基本設定 =====
const DEFAULT_ROOT_FOLDER_ID = '1Qohkk6qMPShgdf8ppJu8C-VFSR5qNlmf'; // 先進封裝追蹤
const TZ = 'Asia/Taipei';
const INDUSTRY_FOLDER = '產業';
const PENDING_FOLDER = '_待分類';
const SYSTEM_FOLDER = '_系統';
const STOCK_MAP_FILE = 'stock_map.json';
const STOCK_MAP_MAX_AGE_DAYS = 7;
const STOCK_MAP_MIN = 1700;   // 上市約 1000＋上櫃約 800，少於這個數字代表有一邊沒抓到
const MAX_BYTES = 45 * 1024 * 1024; // Apps Script 單次下載上限約 50MB，保留餘裕
const LOG_HEADERS = ['時間', '原始檔名', '新檔名', '分類', '資料夾', '來源', '報告日期', '狀態', '檔案ID', 'MD5'];
const INDUSTRY_KEYWORDS = /產業|行業|industry|sector|策略|週報|周報|月報|晨報|展望報告|市場回顧/i;

// ===== v1.1 工作清單／優分析抓取設定 =====
const JOB_SHEET = '工作清單';
const JOB_HEADERS = ['工作ID', '建立時間', '股號', '名稱', '狀態', '資料檔', '報告連結', '摘要', '更新時間', '備註'];
const ACTIVE_STATUSES = ['待抓取', '抓取中', '已抓取'];
const UA_PRODUCT_ID = '907'; // 優分析「產業情報小助理」
// 小助理 20 個分類：文字必須和網站按鈕完全一樣（包含 ❤️）
const UA_PROMPTS = ['近況發展', '產業趨勢', '❤️產品線分析', '長短期展望', '供需分析', '觀察重點', '利多因素',
  '利空因素', '接單狀況', '資本支出', '新產品', '時間表', '相關公司', '同業競爭', '護城河分析', '併購分析',
  '重要數字', '公司概覽', '銷售地區', '名詞解釋'];
const SCRAPE_STALE_MIN = 15;   // 抓取中超過 15 分鐘沒交件 → 重派一次
const REPORT_WARN_HOURS = 3;   // 已抓取超過 3 小時還沒有報告 → LINE 提醒一次
const REPORT_TITLE = '_整合報告_';
// v1.3
const REUSE_REPORT_DAYS = 3;       // 報告完成 3 天內、且沒有新 PDF → 直接回傳舊報告連結
const ESTIMATE_PREFIX = '法人預估_待登錄_';
const ESTIMATE_SHEET_NAME = '法人預估追蹤表';
const ESTIMATE_HEADERS = ['股號', '名稱', '券商', '報告日期', '評等', '目標價', '估值方法', '當年F EPS', '次年F EPS', '當年F營收(億)', '次年F營收(億)', '預估年度', '資料等級', '來源檔', '備註', '登錄日期'];
let CUR_UID = ''; // 這次 webhook 是誰傳的 // 排程任務產出的 Google 文件命名：3167_整合報告_20260927

// 券商／來源辨識（由上而下比對，先中後英）
const SOURCES = [
  [/統一投顧|統一證券/, '統一投顧'], [/富邦/, '富邦'], [/元大/, '元大'], [/凱基|KGI/i, '凱基'],
  [/永豐/, '永豐'], [/國泰/, '國泰'], [/群益/, '群益'], [/兆豐/, '兆豐'], [/第一金/, '第一金'],
  [/華南/, '華南永昌'], [/玉山/, '玉山'], [/台新/, '台新'], [/元富/, '元富'], [/康和/, '康和'],
  [/宏遠/, '宏遠'], [/大華國際/, '大華國際'], [/中國信託|中信/, '中信'], [/統一/, '統一投顧'],
  [/摩根士丹利|大摩|Morgan\s*Stanley/i, '大摩'], [/摩根大通|小摩|J\.?\s?P\.?\s*Morgan/i, '小摩'],
  [/高盛|Goldman|(?<![A-Za-z])GS(?![A-Za-z])/i, '高盛'], [/(?<![A-Za-z])JPM(?![A-Za-z])/, '小摩'],
  [/(?<![A-Za-z])MS(?![A-Za-z])/, '大摩'], [/(?<![A-Za-z])(ML|BOA)(?![A-Za-z])/, '美銀'], [/美銀|BofA|Bank of America|Merrill/i, '美銀'], [/花旗|\bCiti/i, '花旗'],
  [/瑞銀|\bUBS\b/, '瑞銀'], [/野村|Nomura/i, '野村'], [/大和|Daiwa/i, '大和'], [/麥格理|Macquarie/i, '麥格理'],
  [/匯豐|HSBC/, '匯豐'], [/瑞穗|Mizuho/i, '瑞穗'], [/里昂|CLSA/, '里昂'], [/巴克萊|Barclays/i, '巴克萊'],
  [/傑富瑞|Jefferies/i, '傑富瑞'], [/伯恩斯坦|Bernstein/i, '伯恩斯坦'], [/德銀|Deutsche/i, '德銀'],
  [/Aletheia/i, 'Aletheia'], [/TrendForce|集邦/i, 'TrendForce'], [/DIGITIMES/i, 'DIGITIMES'], [/SemiAnalysis/i, 'SemiAnalysis'],
  [/Counterpoint/i, 'Counterpoint'], [/IDC\b/, 'IDC'], [/Gartner/i, 'Gartner'], [/福邦/, '福邦'], [/日盛/, '日盛'], [/新光/, '新光'],
  [/法說|法人說明會/, '法說會'], [/年報/, '年報'],
  [/優分析|UAnalyze/i, '優分析'], [/Gemini|ChatGPT|Claude|AI生成|AI整理/i, 'AI整理'],
];

// ===== Webhook 入口 =====
function doPost(e) {
  const p = (e && e.parameter) || {};
  const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  if (p.action === 'submitJob') return json(scraperSubmit(p, body)); // 竄改猴交件
  if (p.action === 'submitReport') return json(runnerSubmit(p, body)); // Windows 小程式交報告
  if (p.action === 'screener') return json(screenerPush(p, body));     // v1.6 選股系統每日結果
  if (p.action === 'feed') return json(feedIngest(p, body));            // v1.9 竄改猴交「小助理更新重點」
  (body.events || []).forEach(function (ev) {
    try {
      handleEvent(ev);
    } catch (err) {
      console.error(err && err.stack ? err.stack : err);
      notify(ev, '⚠️ 處理時發生錯誤：' + (err && err.message ? err.message : err));
    }
  });
  return ContentService.createTextOutput('OK');
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'nextJob') return json(scraperNextJob(p)); // 竄改猴取件
  if (p.action === 'nextReport') return json(runnerNextReport(p)); // Windows 小程式領報告工作
  if (p.action === 'pack') return json(runnerPack(p));             // 指定股票的資料包（Gemini 測試用）
  if (p.action === 'holdings') return json(holdingsForCheck(p));    // v1.8 選股系統取持股做賣出檢查
  if (p.action === 'uaAlert') return json(uaAlert(p));              // v1.9.1 常開電腦的優分析被登出
  if (p.action === 'hasJob') return json(hasJobForScraper(p));      // v1.9.2 有沒有報告工作在等（不領工作）
  if (p.action === 'file') return runnerFile(p);                   // 下載單一檔案（base64 純文字）
  return ContentService.createTextOutput('股票檔案小幫手 ' + APP_VERSION + ' 運作中');
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handleEvent(ev) {
  const src = ev.source || {};
  const allowed = prop('ALLOWED_USER_ID');

  // 設定模式：還沒填 ALLOWED_USER_ID 時，回覆對方的 userId
  if (!allowed) {
    if (src.userId && ev.replyToken) {
      reply(ev.replyToken, [text('【設定模式】你的 LINE userId：\n' + src.userId +
        '\n\n請貼到 Apps Script 的指令碼屬性 ALLOWED_USER_ID，之後 bot 只會接受你的訊息。')]);
    }
    return;
  }
  if (src.type !== 'user' || !src.userId) return; // 只處理一對一聊天
  CUR_UID = src.userId;
  if (!isMember(src.userId)) return handleStranger(ev);

  if (ev.type === 'follow') return reply(ev.replyToken, [helpMsg()]);
  if (ev.type === 'postback') return handlePostback(ev);
  if (ev.type !== 'message') return;
  const m = ev.message;
  if (m.type === 'file') return handleFile(ev);
  if (m.type === 'image') return handleImageMsg(ev);
  if (m.type === 'text') return handleText(ev);
  reply(ev.replyToken, [text('目前收：檔案（PDF、Word、Excel、PPT、ZIP、TXT…）、圖片、連結和文字指令。輸入「說明」看用法。')]);
}

// ===== 收到檔案（v1.5：多格式） =====
function handleFile(ev) {
  const m = ev.message;
  const origName = m.fileName || 'unnamed';
  if (m.fileSize && m.fileSize > MAX_BYTES) {
    return reply(ev.replyToken, [text('「' + origName + '」超過 45MB，LINE 轉存有上限，請直接上傳到雲端資料夾。')]);
  }
  const blob = downloadLineContent(m.id);   // 下載不用排隊，先下載
  const lock = LockService.getScriptLock();
  lock.waitLock(LONG_LOCK_MS);   // v1.7.1 一次傳很多檔時要排隊，等久一點，不要報錯
  try {
    const ctx = newCtx(ev.timestamp);
    processIncoming(blob, origName, ctx);
    reply(ev.replyToken, finishCtx(ctx));
  } finally {
    lock.releaseLock();
  }
}

// LINE 用「相片」傳的圖片（沒有檔名）。連續傳多張時 2 分鐘內會併成同一組，只問一次股票。
function handleImageMsg(ev) {
  const blob = downloadLineContent(ev.message.id);
  const lock = LockService.getScriptLock();
  lock.waitLock(LONG_LOCK_MS);
  try {
    const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss');
    const name = 'LINE圖片_' + stamp + '_' + String(ev.message.id).slice(-4) + '.jpg';
    const ctx = newCtx(ev.timestamp);
    const next = nextTarget();
    if (next) { ctx.fallback = { target: next, source: '截圖', date: today(), force: next.type === 'industry' }; processIncoming(blob, name, ctx); return reply(ev.replyToken, finishCtx(ctx)); }

    const hash = md5(blob.getBytes());
    const dup = findLogByHash(ctx.log, hash);
    if (dup) return reply(ev.replyToken, [text(dupText(dup))]);
    const pid = savePending(blob.setName(name), name, hash, { source: '截圖', date: today(), kind: 'image', ext: 'jpg' }, ctx.log);

    const g = joinPendingGroup([pid], false);
    reply(ev.replyToken, [askGroup(g, '這張圖片', [], ctx.map)]);
  } finally {
    lock.releaseLock();
  }
}

// ===== 文字指令 =====
function handleText(ev) {
  const t = (ev.message.text || '').trim();

  // v1.5：訊息裡有連結 → 抓下來當資料（前面可加股號，例如「3443 https://...」）
  if (/https?:\/\/\S+/i.test(t)) return handleLinks(ev, t);

  if (/^(說明|使用說明|help|\?|？|指令)$/i.test(t)) return reply(ev.replyToken, [helpMsg()]);
  if (/^(傳檔說明|檔案說明|怎麼傳|格式)$/.test(t)) return reply(ev.replyToken, [withHelpButtons(text(fileHelpText()))]);

  if (/^清單$/.test(t)) {
    const rows = listStockFolders().map(function (f) { return '・' + f.name + '（' + f.count + ' 份）'; });
    listIndustries().forEach(function (x) { rows.push('・' + INDUSTRY_FOLDER + '／' + x.name + '（' + x.count + ' 份）'); });
    listUSFolders().forEach(function (x) { rows.push('・美股／' + x.name + '（' + x.count + ' 份）'); });
    return reply(ev.replyToken, [text(rows.length ? '目前資料夾：\n' + rows.join('\n') : '目前還沒有任何股票資料夾。')]);
  }

  if (/^待分類$/.test(t)) return reply(ev.replyToken, [pendingOverview()]);

  // 直接輸入股號 → 歸類最近一份待分類檔案
  const byName = /^[\u4e00-\u9fff][\u4e00-\u9fffA-Za-z\-*]{1,9}$/.test(t) ? findStockByName(t, true) : [];   // v2.7 單獨打股名（只接受完全相同）
  const codeOnly = t.match(/^(\d{4,6}[A-Z]?)$/) || (byName.length === 1 ? [t, byName[0]] : null) || (/^[A-Za-z]{1,5}(\.[A-Za-z])?$/.test(t) && getUSMap()[t.toUpperCase()] ? [t, t.toUpperCase()] : null);
  if (codeOnly && memoPending()) {
    const code = resolveCode(codeOnly[1], getStockMap());
    if (!code) return reply(ev.replyToken, [text('查不到股號「' + codeOnly[1] + '」，請再輸入一次。')]);
    return reply(ev.replyToken, [saveMemoPending([{ type: 'stock', code: code, name: stockName(code) }])]);
  }
  if (codeOnly && prop(pendKey())) {
    return reply(ev.replyToken, [withNextPending(text(classifyPending(prop(pendKey()), codeOnly[1])))]);
  }
  // 沒有待分類時單獨傳股號 → 接下來 5 分鐘內傳的圖片／檔案／連結都歸到這檔
  if (codeOnly) {
    const code = resolveCode(codeOnly[1], getStockMap());
    if (!code) return reply(ev.replyToken, [text('查不到股號「' + codeOnly[1] + '」。')]);
    prop('NEXT_TARGET_' + CUR_UID, JSON.stringify({ code: code, ts: Date.now() }));
    return reply(ev.replyToken, [text('👌 接下來 5 分鐘內傳的圖片、檔案、連結，看不出股票的都會歸到 ' + code + ' ' + stockName(code) + '。')]);
  }
  // v2.6 分錯了：「改 3167」「改 NVDA」「改 產業 記憶體」＝把剛剛存的檔案搬過去
  const fixCmd = t.match(/^改(?:到|成|存)?\s*(產業\s+\S+|\d{4,6}[A-Z]?|[A-Za-z.]{1,6}|[\u4e00-\u9fff]{2,6}(?:-KY)?)$/);
  if (fixCmd && lastAction() === 'memo') {   // v2.9 剛剛存的是筆記 → 筆記搬過去
    const arg = fixCmd[1];
    const im = arg.match(/^產業\s+(\S+)$/);
    if (im) return reply(ev.replyToken, [memoMoveTo({ type: 'industry', sub: cleanIndustry(im[1]) })]);
    const r = pickStock(arg);
    if (r.code) return reply(ev.replyToken, [memoMoveTo({ type: 'stock', code: r.code, name: stockName(r.code) })]);
    if (r.list) return reply(ev.replyToken, [stockChoiceMsg(r.list, '改', r.msg)]);
  }
  if (fixCmd && lastSaved()) {
    const arg = fixCmd[1];
    const im = arg.match(/^產業\s+(\S+)$/);
    if (im) return reply(ev.replyToken, [text(moveLastSaved({ type: 'industry', sub: cleanIndustry(im[1]) }))]);
    const r2 = pickStock(arg);
    const code = r2.code;
    if (r2.list) return reply(ev.replyToken, [stockChoiceMsg(r2.list, '改', r2.msg)]);
    if (code) return reply(ev.replyToken, [text(moveLastSaved({ type: 'stock', code: code, name: stockName(code) }))]);
    if (/^\d/.test(arg)) return reply(ev.replyToken, [text('查不到股號「' + arg + '」，請再確認一次，例如：改 3167')]);
  }

  // v2.3 文字筆記：「3167 法說會重點…」「NVDA 財報…」「產業 記憶體 HBM 報價…」「筆記 …」
  const memoMsg = tryMemo(t);
  if (memoMsg) return reply(ev.replyToken, [memoMsg]);

  // v1.6.1 產業：「產業」＝跳產業按鈕；「產業 記憶體」＝歸到產業/記憶體（沒有待分類時＝接下來 5 分鐘的目標）
  const indCmd = t.match(/^產業(?:[\s,，:：]+(.+))?$/);
  if (indCmd) {
    const pend = prop(pendKey());
    const nm = indCmd[1] ? cleanIndustry(indCmd[1]) : '';
    if (pend && nm) return reply(ev.replyToken, [withNextPending(withIndReportButton(text(classifyPending(pend, 'IND:' + nm)), nm))]);
    if (pend) return reply(ev.replyToken, [askIndustry(pend, '')]);
    if (nm) {
      prop('NEXT_TARGET_' + CUR_UID, JSON.stringify({ industry: nm, ts: Date.now() }));
      return reply(ev.replyToken, [text('👌 接下來 5 分鐘內傳的檔案、圖片、連結，都會歸到「' + INDUSTRY_FOLDER + '／' + nm + '」。')]);
    }
    return reply(ev.replyToken, [text(industryListText())]);
  }
  // 按了「✏️ 輸入新產業」後，下一句文字就是產業名稱
  const waitInd = safeJson(prop('AWAIT_IND_' + CUR_UID));
  if (waitInd.token && Date.now() - waitInd.ts < 10 * 60000 && !/^(說明|傳檔說明|報告|進度|清單|待分類|成員|買|賣|持股|庫存|停損|追蹤|取消追蹤|更新|雷達|摘要)/.test(t)) {
    props().deleteProperty('AWAIT_IND_' + CUR_UID);
    const nm = cleanIndustry(t);
    if (!nm) return reply(ev.replyToken, [text('產業名稱不能是空的，請再按一次「✏️ 輸入新產業」。')]);
    if (waitInd.token === 'FIX') return reply(ev.replyToken, [text(moveLastSaved({ type: 'industry', sub: nm }))]);
    if (waitInd.token === 'MEMO') return reply(ev.replyToken, [saveMemoPending([{ type: 'industry', sub: nm }])]);
    return reply(ev.replyToken, [withNextPending(withIndReportButton(text(classifyPending(waitInd.token, 'IND:' + nm)), nm))]);
  }

  // v2.0「美股 NVDA」＝接下來 5 分鐘的檔案歸到 NVDA；「美股」＝看美股資料夾
  const usCmd = t.match(/^美股(?:\s+([A-Za-z.]{1,7}))?$/);
  if (usCmd) {
    if (!usCmd[1]) return reply(ev.replyToken, [text(usFolderText())]);
    const code = resolveCode(usCmd[1], {});
    if (!code) return reply(ev.replyToken, [text('查不到美股代號「' + usCmd[1] + '」。')]);
    if (prop(pendKey())) return reply(ev.replyToken, [withNextPending(text(classifyPending(prop(pendKey()), code)))]);
    prop('NEXT_TARGET_' + CUR_UID, JSON.stringify({ code: code, ts: Date.now() }));
    return reply(ev.replyToken, [text('👌 接下來 5 分鐘內傳的檔案、圖片、連結，都會歸到美股 ' + code + ' ' + stockName(code) + '。')]);
  }

  // v1.9 追蹤清單、更新紀錄、雷達
  const trk = t.match(/^(追蹤|取消追蹤)\s*(\S{2,12})$/);
  if (trk && trk[2] !== '清單') {
    const r = pickStock(trk[2]);
    if (r.msg) return reply(ev.replyToken, [stockChoiceMsg(r.list, trk[1], r.msg)]);
    if (!r.code) return reply(ev.replyToken, [text('查不到「' + trk[2] + '」，請打股號或股名。')]);
    return reply(ev.replyToken, [text(trk[1] === '追蹤' ? watchAdd(r.code) : watchRemove(r.code))]);
  }
  if (/^(追蹤清單|watchlist)$/i.test(t)) return reply(ev.replyToken, [text(watchlistText())]);
  const setWl = t.match(/^設定追蹤表\s+(\S+)$/);
  if (setWl) return reply(ev.replyToken, [text(setWatchlistSheet(setWl[1]))]);
  const upd = t.match(/^更新\s*(\S{2,12})$/);
  if (upd) {
    const r = pickStock(upd[1]);
    if (r.msg) return reply(ev.replyToken, [stockChoiceMsg(r.list, '更新', r.msg)]);
    if (r.code) return reply(ev.replyToken, [text(stockUpdatesText(r.code, 12))]);
  }
  if (/^雷達$/.test(t)) return reply(ev.replyToken, [text(radarText(true) + (revisionClusterText() ? '\n\n' + revisionClusterText() : ''))]);
  if (/^(上修|同步上修|上下修)$/.test(t)) return reply(ev.replyToken, [text(revisionClusterText() || '近 7 天沒有同題材 2 家以上同步上修／下修的消息。')]);
  if (/^(摘要|今日摘要)$/.test(t)) return reply(ev.replyToken, digestMessages(CUR_UID, 'manual'));

  // v1.8 持股紀錄
  const buyCmd = t.match(/^買(?:進|入)?\s*(\d{4,6}[A-Z]?)\s+([\d.]+)(?:\s+(\d+(?:\.\d+)?)\s*張?)?(?:\s*停損\s*([\d.]+))?\s*$/);
  if (buyCmd) return reply(ev.replyToken, [text(addHolding(buyCmd[1], +buyCmd[2], buyCmd[3] ? +buyCmd[3] : 0, buyCmd[4] ? +buyCmd[4] : 0))]);
  const sellCmd = t.match(/^賣(?:出)?\s*(\d{4,6}[A-Z]?)(?:\s+([\d.]+))?\s*$/);
  if (sellCmd) return reply(ev.replyToken, [text(sellHolding(sellCmd[1], sellCmd[2] ? +sellCmd[2] : 0))]);
  if (/^(持股|庫存)$/.test(t)) return reply(ev.replyToken, [text(holdingsText())]);
  const stopCmd = t.match(/^停損\s*(\d{4,6}[A-Z]?)\s+([\d.]+)\s*$/);
  if (stopCmd) return reply(ev.replyToken, [text(setHoldingStop(stopCmd[1], +stopCmd[2]))]);

  // v2.10 選股系統突破訊號的自動報告：開／關
  const ar = t.match(/^自動報告\s*(開|關|開啟|關閉|on|off)?$/i);
  if (ar) {
    if (ar[1]) prop('AUTO_REPORT_OFF', /關|off/i.test(ar[1]) ? '1' : '0');
    const off = prop('AUTO_REPORT_OFF') === '1';
    return reply(ev.replyToken, [text('🤖 選股系統自動報告：' + (off ? '已關閉' : '開啟中') + '\n' +
      '（開啟時：每天收盤後選股系統出現「突破買進訊號」的股票，最多 3 檔會自動做整合報告；優分析資料要等常開電腦的 Edge 有連線才會抓，所以有時隔天才出現）\n' +
      '要' + (off ? '開啟' : '關閉') + '請傳「自動報告 ' + (off ? '開' : '關') + '」')]);
  }
  if (/^(額度|推播額度)$/.test(t)) return reply(ev.replyToken, [text(quotaText())]);
  if (/^成員$/.test(t)) return reply(ev.replyToken, [text(membersText())]);
  const rm = t.match(/^移除\s*(.+)$/);
  if (rm) return reply(ev.replyToken, [text(removeMember(rm[1].trim()))]);

  const rpt = t.match(/^(?:報告|report)\s*(.+)$/i);
  if (rpt) { CUR_SRC = '傳文字「' + t.slice(0, 30) + '」'; return reply(ev.replyToken, [requestReport(rpt[1], CUR_UID, false)]); }
  if (/^(報告|要報告)$/.test(t)) return reply(ev.replyToken, [pickStockMsg()]);
  if (/^進度$/.test(t)) return reply(ev.replyToken, [text(jobProgressText())]);

  // v2.3 比較長的文字（或多行）＝股票筆記，自動判斷是哪檔
  if (t.length >= MEMO_MIN_LEN || /\n/.test(t)) return reply(ev.replyToken, [autoMemo(t)]);
  reply(ev.replyToken, [text('看不懂這個指令，輸入「說明」看用法。\n要存成股票筆記：前面加股號，例如「3167 法說會重點：…」，或打「筆記 」開頭。')]);
}

function helpText() {
  return [
    '📘 股票檔案小幫手｜使用說明',
    '',
    '【存資料】',
    '・直接轉傳檔案、圖片給我，自動歸到對應股票資料夾',
    '・貼連結也可以（雲端檔案、網頁）',
    '・看不出股票時會跳按鈕讓你選',
    '・文字筆記：前面加股號，例如「3167 法說會重點：…」；美股「NVDA …」；產業「產業 記憶體 …」',
    '　比較長的文字沒寫股號，會自動找內文的股號／公司名，找不到就跳按鈕問你',
    '・分錯了：按「✏️ 分錯了，改」，或打「改 3167」「改 產業 記憶體」（6 小時內有效）',
    '・連結最準的傳法：股號＋空格＋連結，例如「3443 https://…」',
    '→ 詳細格式請按「傳檔說明」',
    '',
    '【要報告】',
    '報告 3167（或 報告 環球晶）　抓優分析小助理＋整合所有資料，完成推播連結；股號、股名都可以',
    '報告 產業 記憶體　整合該產業資料夾的所有報告（最新進度、改變、未來方向、關注清單）',
    '報告 NVDA　美股整合報告（用「美股/NVDA」資料夾的資料，不抓小助理）',
    '美股 NVDA　接下來 5 分鐘傳的檔案都歸到 NVDA',
    '　（3 天內做過又沒新資料，會直接給上次的報告）',
    '',
    '【追蹤（每天 08:30、21:00 推播重點）】',
    '追蹤 3167／取消追蹤 3167　加減追蹤清單',
    '追蹤清單　看目前追蹤哪些股票',
    '更新 3167　這檔最近的小助理更新紀錄',
    '雷達　哪些題材最近消息變熱、股價也跟上',
    '上修　近 7 天同題材多家同步上修／下修（產業可能有變化）',
    '摘要　立刻看一次今天的追蹤摘要',
    '',
    '【持股（每天收盤後自動檢查賣出規則）】',
    '買 3167 250 2張　記錄買進（可加：停損 235）',
    '賣 3167 280　記錄賣出',
    '持股　看目前持股與停損',
    '停損 3167 240　手動改停損價',
    '',
    '【查詢】',
    '進度　最近的報告做到哪',
    '自動報告 開／關　選股突破訊號的自動報告（預設開）',
    '額度　看 LINE 本月推播用了多少（用完時處理比較久的訊息會收不到回覆）',
    '清單　有哪些股票、產業資料夾',
    '產業　看有哪些產業資料夾',
    '待分類　還沒歸檔的檔案（可一次全部或逐一分類）',
    '成員　誰可以使用',
    '',
    '忘記時傳「說明」或點下方選單就好 👇',
  ].join('\n');
}

function fileHelpText() {
  return [
    '📎 傳檔說明',
    '',
    '【可以傳的東西】',
    '・PDF',
    '・Word（doc、docx）、Excel（xls、xlsx、csv）、PowerPoint（ppt、pptx）',
    '・TXT、HTML、ZIP（自動解壓縮）',
    '・圖片／截圖（用「相片」傳也可以，2 分鐘內多張會併一組）',
    '・連結：Google 雲端檔案或資料夾、一般網頁',
    '',
    '【怎麼讓它知道是哪一檔】',
    '① 檔名有股號 → 自動判斷（例：國泰-3443 創意-20260924.pdf）',
    '② 先傳股號「3443」→ 接下來 5 分鐘內傳的都歸到 3443',
    '③ 連結前加股號：3443 https://...',
    '④ 產業資料：傳完會問你是哪個產業（點按鈕或輸入名稱）',
    '　也可以先傳「產業 記憶體」→ 接下來 5 分鐘內傳的都歸到 產業／記憶體',
    '　連結：產業 記憶體 https://...',
    '⑤ 都沒有 → 會跳按鈕讓你選，或直接輸入股號',
    '',
    '【小提醒】',
    '・同一份重複傳會自動略過',
    '・Word／Excel／PPT 會另存一份可讀版給 AI',
    '・Gemini、ChatGPT 等 AI 產生的內容只當線索',
    '・需要登入的網頁抓不到，請改傳 PDF 或截圖',
    '・單檔上限 45MB',
  ].join('\n');
}

// 說明訊息＋快速按鈕
function helpMsg() { return withHelpButtons(text(helpText())); }

function withHelpButtons(msg) {
  const btn = function (label, t) { return { type: 'action', action: { type: 'message', label: label, text: t } }; };
  msg.quickReply = { items: [btn('📎 傳檔說明', '傳檔說明'), btn('📊 要報告', '報告'), btn('⏳ 進度', '進度'), btn('📁 清單', '清單'), btn('🗂 待分類', '待分類'), btn('📘 使用說明', '說明')] };
  return msg;
}

// 「報告」沒接股號 → 列出股票資料夾讓你點
function pickStockMsg() {
  const items = listStockFolders().concat(listUSFolders()).slice(0, 13).map(function (f) {
    return { type: 'action', action: { type: 'postback', label: f.name.slice(0, 20), data: 'rpt|' + f.code, displayText: '報告 ' + f.name } };
  });
  if (listIndustries().length) {
    items.splice(12);
    items.push({ type: 'action', action: { type: 'message', label: '🏭 產業報告', text: '報告 產業' } });
  }
  const msg = text('要哪一檔的報告？點下面的股票，或直接輸入「報告 股號」（例如：報告 3167、報告 NVDA）。\n產業報告：報告 產業 記憶體');
  if (items.length) msg.quickReply = { items: items };
  return msg;
}

// ===== 按鈕回傳（postback） =====
function handlePostback(ev) {
  const parts = (ev.postback.data || '').split('|');
  if (parts[0] === 'rpt') { CUR_SRC = '按按鈕（' + (ev.postback.data || '') + '）'; return reply(ev.replyToken, [requestReport(parts[1], CUR_UID, parts[2] === 'force')]); }
  if (parts[0] === 'mem') return reply(ev.replyToken, [text(handleMemberDecision(parts[1], parts[2]))]);
  if (parts[0] === 'pend') return reply(ev.replyToken, [nextPendingMsg()]);   // v1.7.1 逐一分類
  if (parts[0] === 'memo') return reply(ev.replyToken, [memoPostback(parts.slice(1))]);   // v2.3 筆記
  if (parts[0] === 'fix') return reply(ev.replyToken, [fixPostback(parts.slice(1))]);     // v2.6 分錯了
  if (parts[0] === 'ind' && parts[1] === 'FIX') {   // v2.6 分錯了 → 改成產業
    if (parts[2] === 'NEW') { prop('AWAIT_IND_' + CUR_UID, JSON.stringify({ token: 'FIX', ts: Date.now() })); return reply(ev.replyToken, [text('請輸入產業名稱，例如：記憶體、先進封裝、PCB')]); }
    if (parts[2] === 'LATER') return reply(ev.replyToken, [text('好，維持原本的分類。')]);
    return reply(ev.replyToken, [text(moveLastSaved({ type: 'industry', sub: parts.slice(2).join('|') }))]);
  }
  if (parts[0] === 'ind' && parts[1] === 'MEMO') {   // v2.3 筆記選產業
    if (parts[2] === 'NEW') {
      prop('AWAIT_IND_' + CUR_UID, JSON.stringify({ token: 'MEMO', ts: Date.now() }));
      return reply(ev.replyToken, [text('請輸入產業名稱，例如：記憶體、先進封裝、PCB')]);
    }
    if (parts[2] === 'LATER') { memoClear(); return reply(ev.replyToken, [text('好，這段筆記不存。')]); }
    return reply(ev.replyToken, [saveMemoPending([{ type: 'industry', sub: parts.slice(2).join('|') }])]);
  }
  if (parts[0] === 'ind') {   // v1.6.1 產業按鈕
    if (parts[2] === 'NEW') {
      prop('AWAIT_IND_' + CUR_UID, JSON.stringify({ token: parts[1], ts: Date.now() }));
      return reply(ev.replyToken, [text('請輸入產業名稱，例如：記憶體、先進封裝、PCB、AI伺服器')]);
    }
    if (parts[2] === 'LATER') return reply(ev.replyToken, [text('好，先放在「' + PENDING_FOLDER + '」。之後傳「待分類」就能一次或逐一處理，每晚 8 點也會提醒你。')]);
    const indName = parts.slice(2).join('|');
    return reply(ev.replyToken, [withNextPending(withIndReportButton(text(classifyPending(parts[1], 'IND:' + indName)), indName))]);
  }
  if (parts[0] !== 'cls') return;
  const fileId = parts[1], choice = parts[2];
  if (choice === 'LATER') return reply(ev.replyToken, [text('好，先放在「' + PENDING_FOLDER + '」。之後傳「待分類」就能一次或逐一處理，每晚 8 點也會提醒你。')]);
  if (choice === 'TYPE') return reply(ev.replyToken, [text('請直接輸入股號，例如 3167。')]);
  if (choice === 'IND') return reply(ev.replyToken, [askIndustry(fileId, '')]);
  const msg = text(classifyPending(fileId, choice));
  reply(ev.replyToken, [withNextPending(withReportButton(msg, { type: 'stock', code: choice }))]);
}

// 存好股票 PDF 後，附一顆「更新整合報告」按鈕
function withReportButton(msg, target) {
  if (!target || target.type !== 'stock' || !/^✅/.test(msg.text)) return msg;
  msg.quickReply = { items: [{ type: 'action', action: {
    type: 'postback', label: ('更新 ' + cn(target.code) + ' 報告').slice(0, 20), data: 'rpt|' + target.code, displayText: '報告 ' + cn(target.code),
  } }] };
  return msg;
}

// token 可以是單一檔案 ID，或一組檔案「G…」（ZIP／多張圖片）
function classifyPending(token, choice) {
  if (/^G/.test(token) && prop('PGROUP_' + token)) {
    const ids = safeJsonArr(prop('PGROUP_' + token));
    const msgs = ids.map(function (id) { return classifyPending(id, choice); });
    props().deleteProperty('PGROUP_' + token);
    props().deleteProperty('PGIND_' + token);
    if (prop(pendKey()) === token) props().deleteProperty(pendKey());
    const op = safeJson(prop('PGROUP_OPEN_' + CUR_UID));
    if (op.gid === token) props().deleteProperty('PGROUP_OPEN_' + CUR_UID);
    const ok = msgs.filter(function (m) { return /^✅/.test(m); }).length;
    return (ok ? '✅ 已歸檔 ' + ok + ' 個檔案\n' : '') + msgs.map(function (m) { return m.replace(/^✅ /, '・'); }).join('\n');
  }
  const fileId = token;
  const lock = LockService.getScriptLock();
  lock.waitLock(LONG_LOCK_MS);
  try {
    let file;
    try { file = DriveApp.getFileById(fileId); } catch (e) { return '找不到那份檔案，可能已經被移動或刪除。'; }

    const pending = getChildIfExists(rootFolder(), PENDING_FOLDER);
    const parents = file.getParents();
    let inPending = false;
    while (parents.hasNext()) if (pending && parents.next().getId() === pending.getId()) inPending = true;
    if (!inPending) return '「' + file.getName() + '」已經歸檔過了。';

    const meta = safeJson(file.getDescription());
    const map = getStockMap();
    let target;
    if (/^IND:/.test(choice)) {
      const nm = cleanIndustry(choice.slice(4));
      if (!nm) return '產業名稱不能是空的。';
      target = { type: 'industry', sub: nm };
    } else if (choice === 'IND') {
      return '請選擇或輸入產業名稱（傳「產業 名稱」，例如：產業 記憶體）。';
    } else {
      const code = resolveCode(choice, map);
      if (!code) return '查不到股號「' + choice + '」，請確認後再輸入一次。';
      target = { type: 'stock', code: code, name: stockName(code) };
    }

    const origName = meta.orig || file.getName();
    const info = { target: target, source: meta.source || '未知來源', date: meta.date || today(), topic: extractTopic(origName) };
    const fr = targetFolder(target);
    const ext = meta.kind === 'gnative' ? '' : (meta.ext || extOf(origName) || 'pdf');
    let newName = uniqueName(fr.folder, buildFileName(info, ext));
    if (meta.kind === 'gnative' && meta.label) newName = uniqueName(fr.folder, buildFileName(info, '').replace(/\.$/, '') + '_' + meta.label);
    file.setName(newName);
    file.moveTo(fr.folder);
    file.setDescription('原始檔名：' + origName + (meta.url ? '\n來源網址：' + meta.url : '') + '\nMD5：' + (meta.hash || ''));
    let conv = '';
    if (CONVERT_TO[meta.kind]) conv = convertCopy(file.getBlob(), newName, meta.kind, ext, fr.folder.getId());

    updateLogByFileId(getLogSheet(), fileId, { newName: newName, category: categoryLabel(target), folder: fr.folder.getName(), status: '已歸檔' });
    if (prop(pendKey()) === fileId) props().deleteProperty(pendKey());

    return savedMessage(fr, newName, info.source) + conv;
  } finally {
    lock.releaseLock();
  }
}

// ===== 存檔 =====
function savedMessage(fr, newName, source) {
  const lines = ['✅ 已存入「' + fr.folder.getName() + '」', newName];
  if (fr.created) lines.push('（新建立的資料夾）');
  if (source === '未知來源') lines.push('※ 檔名看不出券商，來源先標為「未知來源」');
  if (source === 'AI整理') lines.push('※ 這份看起來是 AI 整理的文件，不是券商原始報告，整合時會降低採信等級');
  return lines.join('\n');
}

function targetFolder(target) {
  if (target.type === 'industry') {
    const top = getOrCreateChild(rootFolder(), INDUSTRY_FOLDER).folder;
    if (!target.sub) return { folder: top, created: false };
    return getOrCreateChild(top, target.sub);
  }
  return getStockFolder(target.code, target.name);
}

function categoryLabel(target) {
  if (target.type === 'industry') return INDUSTRY_FOLDER + (target.sub ? '／' + target.sub : '');
  return target.code + ' ' + (target.name || '');
}

// 找「3167 大量」這類以股號開頭的資料夾，沒有就建立
function getStockFolder(code, name) {
  if (isUS(code)) return getUSFolder(code, name);   // v2.0 美股放在「美股」資料夾底下
  const it = rootFolder().getFolders();
  const re = new RegExp('^' + code + '(?![0-9A-Z])');
  while (it.hasNext()) {
    const f = it.next();
    if (re.test(f.getName())) return { folder: f, created: false };
  }
  return { folder: rootFolder().createFolder((code + ' ' + (name || '')).trim()), created: true };
}

function uniqueName(folder, name) {
  if (!folder.getFilesByName(name).hasNext()) return name;
  const m = name.match(/^(.*?)(\.[A-Za-z0-9]{1,5})?$/);
  const base = m[1], ext = m[2] || '';
  for (let i = 2; i < 100; i++) {
    const n = base + '_' + i + ext;
    if (!folder.getFilesByName(n).hasNext()) return n;
  }
  return base + '_' + Date.now() + ext;
}

// ===== 檔名分析（純邏輯，不碰雲端） =====
function analyzeFileName(origName, map, timestamp) {
  const stem = cleanStem(origName);
  const stock = detectStock(stem, map);
  const stemForSource = stock.code && map[stock.code] ? stem.split(map[stock.code]).join(' ') : stem;
  const source = detectSource(stemForSource);
  const date = detectDate(stem) || (timestamp ? formatDate(new Date(timestamp)) : today());
  const topic = extractTopic(origName);

  let target = null;
  if (!stock.code) { const us = detectUSTicker(stem); if (us) stock.code = us; }   // v2.0 美股檔名
  if (stock.code) target = { type: 'stock', code: stock.code, name: map[stock.code] || stockName(stock.code) || stock.name || '' };
  else if (INDUSTRY_KEYWORDS.test(stem)) target = { type: 'industry' };

  return { target: target, source: source, date: date, topic: topic, candidates: stock.candidates || [] };
}

function cleanStem(name) {
  return name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .replace(/^[0-9A-Fa-f]{16,}[_\-\s]*/, '') // 去掉系統自動加的長串編號
    .replace(/\s*\(\d+\)$/, '')
    .trim();
}

function detectStock(stem, map) {
  const hasMap = Object.keys(map).length > 0;
  const re = /(?<![0-9A-Za-z])(\d{4,6})([A-Z]?)(?![0-9])/g;
  const found = {};
  let m;
  while ((m = re.exec(stem)) !== null) {
    const after = stem.slice(m.index + m[0].length);
    if (!m[2] && /^\s*(年|月|日|Q|H|\/|[-.]\d)/i.test(after)) continue; // 2026年、2026/5/7 這類是日期
    // v2.6 1990～2039 很可能是年份（2025 千興、2030 彰源…）：要同時看到公司名稱才算
    if (!m[2] && +m[1] >= 1990 && +m[1] <= 2039 && !(map[m[1]] && stem.indexOf(String(map[m[1]]).replace(/-KY$|\*$/, '')) >= 0)) continue;
    let code = null;
    if (m[2] && map[m[1] + m[2]]) code = m[1] + m[2];
    else if (map[m[1]]) code = m[1];
    else if (!hasMap && m[1].length === 4 && !/^(19|20)\d{2}$/.test(m[1])) code = m[1]; // 股票清單抓不到時的退路
    if (!code) continue;
    const nm = map[code] || '';
    found[code] = !!found[code] || (!!nm && stem.indexOf(nm) >= 0);
  }
  const codes = Object.keys(found);
  if (codes.length === 1) return { code: codes[0] };
  const strong = codes.filter(function (c) { return found[c]; });
  if (strong.length === 1) return { code: strong[0] };
  if (codes.length > 1) return { candidates: codes.slice(0, 5) };

  // 檔名沒有股號 → 用公司名稱找「建議選項」（只當按鈕建議，不自動歸檔）
  const byName = [];
  if (hasMap) {
    Object.keys(map).forEach(function (c) {
      const nm = map[c];
      if (nm && nm.length >= 2 && /^\d{4}$/.test(c) && stem.indexOf(nm) >= 0) byName.push(c);
    });
  }
  return { candidates: byName.slice(0, 5) };
}

function detectSource(s) {
  for (let i = 0; i < SOURCES.length; i++) if (SOURCES[i][0].test(s)) return SOURCES[i][1];
  return '未知來源';
}

function detectDate(s) {
  let m = s.match(/(20\d{2})\s*[年\-_.\/]\s*(\d{1,2})\s*[月\-_.\/]\s*(\d{1,2})(?!\d)/);
  if (m) { const d = ymd(m[1], m[2], m[3]); if (d) return d; }
  m = s.match(/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m) { const d = ymd(m[1], m[2], m[3]); if (d) return d; }
  return null;
}

function ymd(y, mo, d) {
  const M = parseInt(mo, 10), D = parseInt(d, 10);
  if (M < 1 || M > 12 || D < 1 || D > 31) return null;
  return y + ('0' + M).slice(-2) + ('0' + D).slice(-2);
}

function extractTopic(origName) {
  let s = cleanStem(origName);
  SOURCES.forEach(function (x) { s = s.replace(x[0], ' '); });
  s = s.replace(/(20\d{2})\s*[年\-_.\/]\s*\d{1,2}\s*[月\-_.\/]\s*\d{1,2}日?/g, ' ')
       .replace(/(?<!\d)20\d{6}(?!\d)/g, ' ')
       .replace(/[\\\/:*?"<>|]/g, ' ')
       .replace(/[\s_\-－—]+/g, '-')
       .replace(/^-+|-+$/g, '');
  return s.slice(0, 30);
}

function buildFileName(info, ext) {
  ext = ext === undefined ? 'pdf' : ext;
  const tail = ext ? '.' + ext : '';
  if (info.target.type === 'industry') {
    return [INDUSTRY_FOLDER, info.target.sub, info.source, info.date, info.topic].filter(Boolean).join('_') + tail;
  }
  return info.target.code + '_' + info.source + '_' + info.date + tail;
}

function resolveCode(input, map) {
  const s = String(input).trim().toUpperCase();
  if (isUS(s)) return getUSMap()[s] ? s : null;   // v2.0 美股代號（NVDA、AVGO、BRK.B）
  if (!Object.keys(map).length) return /^\d{4,6}[A-Z]?$/.test(s) ? s : null;
  if (map[s]) return s;
  // v2.8 清單裡沒有（上櫃、興櫃、新上市）→ 即時到證交所 ISIN 查一次，查到就補進清單
  if (/^\d{4,6}[A-Z]?$/.test(s)) {
    const r = lookupOneStock(s);
    if (r.name) { map[s] = r.name; saveStockMapEntry(s, r.name); return s; }
    if (r.error) return s;   // 查詢網站連不上 → 相信你打的股號
  }
  return null;
}

// 證交所 ISIN 單筆查詢（涵蓋上市、上櫃、興櫃、ETF）；回傳 { name } 或 { error }
function lookupOneStock(code) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('STK_' + code);
  if (hit) return hit === '-' ? {} : { name: hit };
  try {
    const res = UrlFetchApp.fetch('https://isin.twse.com.tw/isin/single_main.jsp?owncode=' + encodeURIComponent(code), { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.getResponseCode() !== 200) return { error: true };
    let html = '';
    try { html = res.getContentText('Big5'); } catch (e) { html = res.getContentText(); }
    const cells = (html.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(function (c) { return c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(); });
    for (let i = 0; i < cells.length - 1; i++) {
      if (cells[i] === code && cells[i + 1] && !/^\d+$/.test(cells[i + 1])) {
        const name = cells[i + 1].replace(/\s+/g, '');
        cache.put('STK_' + code, name, 21600);
        return { name: name };
      }
    }
    cache.put('STK_' + code, '-', 3600);
    return {};
  } catch (e) {
    return { error: true };
  }
}

function saveStockMapEntry(code, name) {
  try {
    const sys = getOrCreateChild(rootFolder(), SYSTEM_FOLDER).folder;
    const it = sys.getFilesByName(STOCK_MAP_FILE);
    if (!it.hasNext()) return;
    const f = it.next();
    const m = safeJson(f.getBlob().getDataAsString());
    m[code] = name;
    f.setContent(JSON.stringify(m));
  } catch (e) { console.warn('補股票清單失敗：' + e); }
}

// ===== 分類按鈕 =====
function askClassify(fileId, origName, candidates, map) {
  const items = [];
  const seen = {};
  function add(label, data, display) {
    if (items.length >= 13 || seen[data]) return;
    seen[data] = true;
    items.push({ type: 'action', action: { type: 'postback', label: label.slice(0, 20), data: data, displayText: display } });
  }
  (candidates || []).forEach(function (c) { add(c + ' ' + (map[c] || ''), 'cls|' + fileId + '|' + c, '歸到 ' + cn(c)); });
  listStockFolders().forEach(function (f) { add(f.name, 'cls|' + fileId + '|' + f.code, '歸到 ' + f.name); });
  items.splice(10); // 保留位置給下面三個固定按鈕
  add('產業', 'cls|' + fileId + '|IND', '歸到產業');
  add('輸入其他股號', 'cls|' + fileId + '|TYPE', '輸入其他股號');
  add('先放著', 'cls|' + fileId + '|LATER', '先放著');

  const hint = (candidates && candidates.length) ? '\n（依檔名內容，可能是：' + candidates.map(function (c) { return c + ' ' + (map[c] || ''); }).join('、') + '）' : '';
  const more = /^G/.test(fileId) ? '\n（3 分鐘內接著傳的檔案、圖片會併在同一組，最後選一次就好）' : '';
  return { type: 'text', text: '看不出「' + origName + '」屬於哪一檔，請點選：' + hint + more, quickReply: { items: items } };
}

function listStockFolders() {
  const out = [];
  const it = rootFolder().getFolders();
  while (it.hasNext()) {
    const f = it.next();
    const m = f.getName().match(/^(\d{4,6}[A-Z]?)/);
    if (m) out.push({ code: m[1], name: f.getName(), count: countFiles(f) });
  }
  return out.sort(function (a, b) { return a.code < b.code ? -1 : 1; });
}

function countFiles(folder) {
  let n = 0; const it = folder.getFiles();
  while (it.hasNext()) { it.next(); n++; }
  return n;
}

// ===== 股票代號清單（上市＋上櫃，每 7 天更新一次，存在 _系統 資料夾） =====
let STOCK_MAP_MEMO = null;
function getStockMap() {
  if (STOCK_MAP_MEMO) return STOCK_MAP_MEMO;
  const sys = getOrCreateChild(rootFolder(), SYSTEM_FOLDER).folder;
  const files = sys.getFilesByName(STOCK_MAP_FILE);
  let file = files.hasNext() ? files.next() : null;
  const fresh = file && (Date.now() - file.getLastUpdated().getTime()) < STOCK_MAP_MAX_AGE_DAYS * 86400000;
  if (file && fresh) {
    STOCK_MAP_MEMO = safeJson(file.getBlob().getDataAsString());
    // v2.7 清單不完整（例如上櫃沒抓到，環球晶 6488 查不到）→ 每 6 小時最多重抓一次
    const n = Object.keys(STOCK_MAP_MEMO).length;
    const lastTry = +(prop('STOCK_MAP_RETRY') || 0);
    if (n >= STOCK_MAP_MIN && STOCK_MAP_MEMO['6488']) return STOCK_MAP_MEMO;
    if (n && Date.now() - lastTry < 6 * 3600000) return STOCK_MAP_MEMO;
    prop('STOCK_MAP_RETRY', String(Date.now()));
  }
  const map = fetchStockMap();
  if (Object.keys(map).length >= (file ? Math.min(STOCK_MAP_MIN, Object.keys(safeJson(file.getBlob().getDataAsString())).length) : 1)) {
    const json = JSON.stringify(map);
    if (file) file.setContent(json); else sys.createFile(STOCK_MAP_FILE, json, MimeType.PLAIN_TEXT);
    STOCK_MAP_MEMO = map;
  } else {
    STOCK_MAP_MEMO = file ? safeJson(file.getBlob().getDataAsString()) : {}; // 抓不到就用舊的
  }
  return STOCK_MAP_MEMO;
}

function fetchStockMap() {
  const map = {};
  const sources = [
    'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',              // 上市
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',    // 上櫃
  ];
  sources.push('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes');   // v2.7 上櫃備用
  sources.forEach(function (url) {
    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      if (res.getResponseCode() !== 200) return;
      const rows = JSON.parse(res.getContentText());
      rows.forEach(function (r) {
        const code = String(r.Code || r.SecuritiesCompanyCode || r['證券代號'] || r['公司代號'] || '').trim();
        const name = String(r.Name || r.CompanyName || r['證券名稱'] || r['公司簡稱'] || '').trim();
        if (/^\d{4,6}[A-Z]?$/.test(code) && name && !map[code]) map[code] = name;
      });
    } catch (e) {
      console.warn('股票清單下載失敗：' + url + ' ' + e);
    }
  });
  // v2.7 再用 FinMind 股票總表補（上市＋上櫃＋興櫃；有設定 FINMIND_TOKEN 會更穩）
  try {
    const tk = prop('FINMIND_TOKEN');
    const res = UrlFetchApp.fetch('https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo' + (tk ? '&token=' + encodeURIComponent(tk) : ''), { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      (JSON.parse(res.getContentText()).data || []).forEach(function (r) {
        const code = String(r.stock_id || '').trim(), name = String(r.stock_name || '').trim();
        if (/^\d{4}[A-Z]?$/.test(code) && name && !map[code]) map[code] = name;
      });
    }
  } catch (e) { console.warn('FinMind 股票清單失敗：' + e); }
  return map;
}

// ===== 上傳紀錄試算表 =====
function getLogSheet() {
  const id = prop('LOG_SHEET_ID');
  if (id) {
    try {
      const sh0 = SpreadsheetApp.openById(id).getSheets()[0];
      if (sh0.getRange(1, 11).getValue() !== '上傳者') sh0.getRange(1, 11).setValue('上傳者'); // v1.3 新欄位
      return sh0;
    } catch (e) { /* 被刪掉就重建 */ }
  }
  const ss = SpreadsheetApp.create('_上傳紀錄');
  DriveApp.getFileById(ss.getId()).moveTo(getOrCreateChild(rootFolder(), SYSTEM_FOLDER).folder);
  const sh = ss.getSheets()[0];
  sh.setName('紀錄');
  sh.appendRow(LOG_HEADERS.concat(['上傳者']));
  sh.setFrozenRows(1);
  prop('LOG_SHEET_ID', ss.getId());
  return sh;
}

function appendLog(sh, row) { sh.appendRow(row); }

function findLogByHash(sh, hash) {
  const v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    if (v[i][9] === hash) return { newName: v[i][2], folder: v[i][4], status: v[i][7], time: toDate(v[i][0]), uploader: String(v[i][10] || '') };
  }
  return null;
}

function updateLogByFileId(sh, fileId, u) {
  const v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    if (v[i][8] === fileId) {
      sh.getRange(i + 1, 3).setValue(u.newName);
      sh.getRange(i + 1, 4).setValue(u.category);
      sh.getRange(i + 1, 5).setValue(u.folder);
      sh.getRange(i + 1, 8).setValue(u.status);
      return;
    }
  }
}

// ===== v1.1 報告工作：建立、查詢 =====
function getJobSheet() {
  const ss = getLogSheet().getParent();
  let sh = ss.getSheetByName(JOB_SHEET);
  if (!sh) {
    sh = ss.insertSheet(JOB_SHEET);
    sh.appendRow(JOB_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('C:C').setNumberFormat('@'); // 股號保持文字，00878 不會變 878
  }
  if (sh.getRange(1, 11).getValue() !== '要求者') sh.getRange(1, 11).setValue('要求者'); // v1.3 新欄位
  if (sh.getRange(1, 12).getValue() !== '來源') sh.getRange(1, 12).setValue('來源');     // v2.10 新欄位
  return sh;
}

function jobRows(sh) {
  return sh.getDataRange().getValues().slice(1).map(function (r, i) {
    return { row: i + 2, id: String(r[0]), created: toDate(r[1]), code: String(r[2]), name: String(r[3]),
      status: String(r[4]), dataUrl: String(r[5]), reportUrl: String(r[6]), summary: String(r[7]),
      updated: toDate(r[8]), note: String(r[9]),
      requesters: String(r[10] || '').split(',').filter(Boolean) };
  });
}

function setJob(sh, row, fields) {
  const col = { status: 5, dataUrl: 6, reportUrl: 7, summary: 8, note: 10, requesters: 11 };
  Object.keys(fields).forEach(function (k) { sh.getRange(row, col[k]).setValue(fields[k]); });
  sh.getRange(row, 9).setValue(now());
}

function toDate(v) {
  if (v instanceof Date) return v;
  const s = String(v || '');
  if (!s) return null;
  const d = new Date(s.replace(' ', 'T') + '+08:00');
  return isNaN(d) ? null : d;
}

// 回傳一則 LINE 訊息物件（可能附「強制更新」按鈕）
function requestReport(input, uid, force, note) {
  const map = getStockMap();
  const s = String(input || '').trim();
  const indm = s.match(/^產業(?:[\s_:：]+(.*))?$/);   // v1.7「報告 產業 記憶體」
  if (indm) return requestIndustryReport(indm[1] || '', uid, force);
  let code = resolveCode(s, map);
  if (!code) {   // v2.7 也接受公司名稱：「報告 環球晶」「報告 台積」「報告 臻鼎」
    const hits = findStockByName(s);
    if (hits.length === 1) code = hits[0];
    else if (hits.length > 1) return stockChoiceMsg(hits, '報告', '「' + s + '」符合好幾檔，要哪一檔的報告？');
  }
  if (!code) return text('查不到「' + s + '」。可以打股號或股名，例如「報告 6488」「報告 環球晶」，美股「報告 NVDA」。');
  const name = stockName(code);
  uid = uid || prop('ALLOWED_USER_ID');

  const lock = LockService.getScriptLock();
  lock.waitLock(LONG_LOCK_MS);
  try {
    const sh = getJobSheet();
    const rows = jobRows(sh).filter(function (j) { return j.code === code; });

    // ① 正在處理中 → 不重做，把這個人加進通知名單
    const active = rows.filter(function (j) { return ACTIVE_STATUSES.indexOf(j.status) >= 0; })[0];
    if (active) {
      const first = active.requesters[0];
      if (active.requesters.indexOf(uid) < 0) setJob(sh, active.row, { requesters: active.requesters.concat([uid]).join(',') });
      const by = first && first !== uid ? '已經由 ' + memberName(first) + ' 在 ' + fmtShort(active.created) + ' 要求，' : '已經在';
      return text('⏳ ' + code + ' ' + name + ' ' + by + '處理中（' + active.status + '），完成後會一起通知你。');
    }

    // ② 3 天內已完成、之後沒有新 PDF → 直接給舊報告
    if (!force) {
      const done = rows.filter(function (j) { return j.status === '完成' && j.reportUrl; }).pop();
      if (done && done.updated && Date.now() - done.updated.getTime() < REUSE_REPORT_DAYS * 86400000 && !hasNewPdfSince(code, done.updated)) {
        const msg = text('📑 ' + code + ' ' + name + ' 在 ' + fmtShort(done.updated) + ' 已有最新報告，之後沒有新的法人報告：\n' +
          (done.summary ? done.summary + '\n' : '') + '\n📑 整合報告：\n' + done.reportUrl + (done.dataUrl ? '\n\n📖 小助理原文：\n' + done.dataUrl : '') +
          '\n\n真的要重新產生的話，按下面「🔄 強制更新」。');
        msg.quickReply = { items: [{ type: 'action', action: { type: 'postback', label: '🔄 強制更新', data: 'rpt|' + code + '|force', displayText: '強制更新 ' + cn(code) } }] };
        return msg;
      }
    }

    // ③ 建立新工作
    const id = 'J' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHHmmss');
    sh.appendRow([id, now(), code, name, isUS(code) ? '已抓取' : '待抓取', '', '', '', now(), force ? '強制更新' : (note || (isUS(code) ? '美股（不抓小助理）' : '')), uid,
      jobSource(note, uid)]);   // v2.10 L 欄「來源」：誰、用什麼方式要的（之後不會被覆蓋）
    prop('ACTIVE_JOBS', '1');
  } finally {
    lock.releaseLock();
  }

  if (isUS(code)) return text('📥 已排入美股整合報告：' + code + ' ' + name + '\n美股沒有優分析小助理，會用「美股/' + code + '」資料夾裡的法人報告、新聞、截圖來寫。\n常開電腦約 10～20 分鐘；完成後推播給所有成員。');
  const lines = ['📥 已排入：' + code + ' ' + name,
    '① Edge 抓優分析小助理（約 1～5 分鐘）',
    '② Claude 整合法人報告（常開電腦約 10 分鐘；電腦離線時雲端排程一小時內補上）',
    '報告完成後會推播給所有成員。'];
  const lastPoll = Number(prop('LAST_POLL') || 0);
  if (Date.now() - lastPoll > 3 * 60 * 1000) {
    lines.push('', '⚠️ Edge 上的抓取腳本最近 3 分鐘沒有回報。請確認常開的電腦上 Edge 開著優分析頁面、而且還在登入狀態。');
  }
  return text(lines.join('\n'));
}

// 上次報告之後，這檔股票有沒有新歸檔的 PDF（看上傳紀錄）
function hasNewPdfSince(code, since) {
  const v = getLogSheet().getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    const t = toDate(v[i][0]);
    if (!t || t.getTime() <= since.getTime()) break;
    if (String(v[i][3]).indexOf(code + ' ') === 0 && v[i][7] === '已歸檔') return true;
  }
  return false;
}

function jobProgressText() {
  const rows = jobRows(getJobSheet()).slice(-6).reverse();
  if (!rows.length) return '還沒有任何報告工作。輸入「報告 3167」開始。';
  const icon = { '待抓取': '🕐', '抓取中': '🔄', '已抓取': '📝', '完成': '✅', '失敗': '❌' };
  const out = rows.map(function (j) {
    const t = j.updated ? Utilities.formatDate(j.updated, TZ, 'MM/dd HH:mm') : '';
    let line = (icon[j.status] || '・') + ' ' + jobLabel(j) + '｜' + j.status + (j.status === '已抓取' ? '（等整合報告）' : '') + '｜' + t;
    if (j.status === '失敗' && j.note) line += '\n　原因：' + j.note;
    if (j.status === '完成' && j.reportUrl) line += '\n　' + j.reportUrl;
    return line;
  });
  const lastPoll = Number(prop('LAST_POLL') || 0);
  out.push('', '抓取腳本最後回報：' + (lastPoll ? Utilities.formatDate(new Date(lastPoll), TZ, 'MM/dd HH:mm:ss') : '從未'));
  return out.join('\n');
}

// ===== v1.1 竄改猴介面：取件／交件 =====
function checkScrapeKey(p) {
  const key = prop('SCRAPE_KEY');
  return !!key && p.key === key;
}

function scraperNextJob(p) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  prop('LAST_POLL', String(Date.now()));
  if (prop('ACTIVE_JOBS') !== '1') return { ok: true, job: null };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: true, job: null };
  try {
    const sh = getJobSheet();
    const rows = jobRows(sh);
    // 抓取中太久沒交件 → 重派一次，第二次就判定失敗
    rows.forEach(function (j) {
      if (j.status !== '抓取中' || !j.updated) return;
      if (Date.now() - j.updated.getTime() < SCRAPE_STALE_MIN * 60000) return;
      if (j.note.indexOf('重派') < 0) { setJob(sh, j.row, { status: '待抓取', note: '逾時重派' }); j.status = '待抓取'; }
      else { setJob(sh, j.row, { status: '失敗', note: '抓取逾時兩次' }); j.status = '失敗'; pushJob(j, [text('❌ ' + j.code + ' ' + j.name + ' 抓取逾時兩次，已取消。請確認 Edge 上的優分析頁面正常後再傳一次「報告 ' + j.code + '」。')]); }
    });
    const job = rows.filter(function (j) { return j.status === '待抓取'; })[0];
    if (!job) return { ok: true, job: null };
    setJob(sh, job.row, { status: '抓取中' });
    return { ok: true, job: { id: job.id, code: job.code, name: job.name, prompts: UA_PROMPTS, productId: UA_PRODUCT_ID } };
  } finally {
    lock.releaseLock();
  }
}

function scraperSubmit(p, body) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  prop('LAST_POLL', String(Date.now()));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = getJobSheet();
    const job = jobRows(sh).filter(function (j) { return j.id === String(body.jobId); })[0];
    if (!job) return { ok: false, error: 'job not found' };
    if (job.status !== '抓取中' && job.status !== '待抓取') return { ok: true, ignored: true };

    if (body.error || !body.markdown) {
      const reason = body.error === 'AUTH' ? '優分析登入過期，請在常開電腦的 Edge 重新登入' : String(body.error || '沒有抓到任何內容');
      setJob(sh, job.row, { status: '失敗', note: reason });
      pushJob(job, [text('❌ ' + job.code + ' ' + job.name + ' 優分析資料抓取失敗\n原因：' + reason + '\n處理好後再傳一次「報告 ' + job.code + '」。')]);
      return { ok: true };
    }

    const folder = getStockFolder(job.code, job.name).folder;
    let title = job.code + '_優分析小助理_' + today();
    if (folder.getFilesByName(title).hasNext()) title += '_' + Utilities.formatDate(new Date(), TZ, 'HHmm');
    const doc = DocumentApp.create(title);
    const parsed = parseMarks(String(body.markdown));
    doc.getBody().setText(parsed.text);
    colorMarks(doc.getBody(), parsed.ranges);
    doc.saveAndClose();
    const file = DriveApp.getFileById(doc.getId());
    file.moveTo(folder);
    file.setDescription('來源：優分析產業情報小助理（竄改猴自動抓取）\n工作ID：' + job.id);

    const miss = (body.failed || []).length;
    const auto = isAutoJob(job);
    setJob(sh, job.row, { status: '已抓取', dataUrl: file.getUrl(), note: (auto ? AUTO_NOTE + ' ' : '') + (miss ? '缺 ' + miss + ' 類：' + body.failed.join('、') : '') });
    pushJob(job, [text((auto ? autoReason(job) + '\n' : '') + '📦 ' + job.code + ' ' + job.name + ' 優分析資料已抓好（' + (body.okCount || '?') + '/' + (body.total || UA_PROMPTS.length) + ' 類）' +
      (miss ? '\n缺：' + body.failed.join('、') : '') + '\n\n📖 小助理原文（可先看）：\n' + file.getUrl() + '\n\n整合報告約 10 分鐘內產生（常開電腦的 Claude Code）；電腦離線時雲端排程會在一小時內補上。')]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ===== v1.2 小助理原文上色：[[紅字]] <<綠字>> → 🔴/🟢 開頭＋真的紅字／綠字 =====
const MARK_RED = '#d93025';
const MARK_GREEN = '#188038';

// 把優分析原始標記拆出來：回傳純文字（保留 🔴🟢 符號方便 Claude 閱讀）與要上色的位置
function parseMarks(md) {
  md = md.replace(/<\/?key>/g, '');
  const re = /\[\[([\s\S]*?)\]\]|<<([\s\S]*?)>>/g;
  let out = '', last = 0, m;
  const ranges = [];
  while ((m = re.exec(md)) !== null) {
    out += md.slice(last, m.index);
    const isRed = m[1] !== undefined;
    const inner = isRed ? m[1] : m[2];
    const start = out.length;
    out += (isRed ? '🔴' : '🟢') + inner;
    if (inner.length) ranges.push({ start: start, end: out.length - 1, color: isRed ? MARK_RED : MARK_GREEN });
    last = re.lastIndex;
  }
  out += md.slice(last);
  return { text: out, ranges: ranges };
}

function colorMarks(docBody, ranges) {
  if (!ranges.length) return;
  try {
    const t = docBody.editAsText();
    const len = t.getText().length;
    ranges.forEach(function (r) {
      if (r.end >= len) return;
      t.setForegroundColor(r.start, r.end, r.color);
      t.setBold(r.start, r.end, true);
    });
  } catch (e) {
    console.warn('小助理原文上色失敗（文字已保存）：' + e); // 上色失敗不影響存檔
  }
}

// ===== v1.1 定時檢查：報告完成 → 推播（每 10 分鐘，由 setupTriggers 建立） =====
function checkReports() {
  try { importEstimates(); } catch (e) { console.warn('法人預估登錄失敗：' + e); }
  try { pendingReminder(); } catch (e) { console.warn('待分類提醒失敗：' + e); }
  try { digestTick(); } catch (e) { console.warn('摘要推播失敗：' + e); }
  try { if (prop('CLEANUP_DAY') !== today()) { prop('CLEANUP_DAY', today()); cleanupProps(); } } catch (e) { console.warn('清理暫存失敗：' + e); }
  if (prop('ACTIVE_JOBS') !== '1') return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const sh = getJobSheet();
    const rows = jobRows(sh);
    rows.forEach(function (j) {
      if (j.status !== '已抓取') return;
      const report = findReportDoc(j);
      if (report) { completeJob(sh, j, report); return; }
      if (j.updated && Date.now() - j.updated.getTime() > REPORT_WARN_HOURS * 3600000 && j.note.indexOf('已提醒') < 0) {
        setJob(sh, j.row, { note: (j.note ? j.note + '；' : '') + '已提醒' });
        pushJob(j, [text('⚠️ ' + jobLabel(j) + ' 的優分析資料抓好超過 ' + REPORT_WARN_HOURS + ' 小時，還沒看到整合報告。請確認常開電腦的報告小程式（runner.log）或 Claude 的排程任務最近一次執行有沒有出錯。')]);
      }
    });
    const stillActive = rows.some(function (j) { return ACTIVE_STATUSES.indexOf(j.status) >= 0; });
    if (!stillActive) prop('ACTIVE_JOBS', '0');
  } finally {
    lock.releaseLock();
  }
}

// 在股票資料夾找「3167_整合報告_yyyyMMdd」且建立時間晚於工作建立時間的 Google 文件
function findReportDoc(job) {
  const folder = jobFolder(job.code, job.name);
  const it = folder.searchFiles("title contains '" + job.code + REPORT_TITLE + "' and trashed = false");
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    if (job.created && f.getDateCreated().getTime() < job.created.getTime()) continue;
    if (!best || f.getDateCreated() > best.getDateCreated()) best = f;
  }
  return best;
}

// 報告文件裡以「摘要：」開頭的那一行，給 LINE 推播用
function readSummary(file) {
  try {
    if (file.getMimeType() !== MimeType.GOOGLE_DOCS) return '';
    const lines = DocumentApp.openById(file.getId()).getBody().getText().split('\n');
    const hit = lines.filter(function (l) { return /^\s*摘要[:：]/.test(l); })[0];
    return hit ? hit.trim().slice(0, 150) : '';
  } catch (e) { return ''; }
}

// ===== v1.5 多格式檔案處理 =====
const EXT_KIND = {
  pdf: 'pdf', zip: 'zip',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', heic: 'image', heif: 'image',
  doc: 'word', docx: 'word', rtf: 'word', odt: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', ods: 'excel', csv: 'excel', tsv: 'excel',
  ppt: 'ppt', pptx: 'ppt', odp: 'ppt',
  txt: 'text', md: 'text', markdown: 'text',
  html: 'html', htm: 'html',
};
const CONVERT_TO = {
  word: 'application/vnd.google-apps.document', text: 'application/vnd.google-apps.document', html: 'application/vnd.google-apps.document',
  excel: 'application/vnd.google-apps.spreadsheet', ppt: 'application/vnd.google-apps.presentation',
};
const CONVERT_LABEL = { word: 'Google 文件', text: 'Google 文件', html: 'Google 文件', excel: 'Google 試算表', ppt: 'Google 簡報' };
const UPLOAD_MIME = {
  pdf: 'application/pdf', zip: 'application/zip',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', csv: 'text/csv', tsv: 'text/tab-separated-values',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odp: 'application/vnd.oasis.opendocument.presentation',
  txt: 'text/plain', md: 'text/plain', markdown: 'text/plain', html: 'text/html', htm: 'text/html',
};

function extOf(name) { const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/); return m ? m[1].toLowerCase() : ''; }

// 一次處理（可能包含 ZIP 裡的多個檔案）共用的狀態
function newCtx(timestamp) {
  const next = nextTarget();
  return { ts: timestamp, log: getLogSheet(), map: getStockMap(), results: [], pendings: [], targets: [], depth: 0, saved: [], cands: [],
    fallback: next ? { target: next, source: '', date: '', force: true } : null };   // v2.6 先傳股號＝你指定的，一定優先
}

// 「先傳股號」的暫時目標（5 分鐘內有效）
function nextTarget() {
  const n = safeJson(prop('NEXT_TARGET_' + CUR_UID));
  if ((!n.code && !n.industry) || Date.now() - n.ts > 5 * 60000) return null;
  if (n.industry) return { type: 'industry', sub: n.industry };
  return { type: 'stock', code: n.code, name: stockName(n.code) };
}

function dupText(dup) {
  const where = dup.status === '待分類' ? '（還在待分類，請先選股票）' : '（' + dup.folder + '）';
  const who = dup.uploader ? '由 ' + (dup.uploader === memberName(CUR_UID) ? '你' : dup.uploader) + ' ' : '';
  const when = dup.time ? '在 ' + fmtShort(dup.time) + ' ' : '';
  return '🔁 重複了，' + who + when + '已經上傳過：' + dup.newName + ' ' + where;
}

// 處理一個檔案（ZIP 會遞迴展開）
function processIncoming(blob, origName, ctx) {
  const ext = extOf(origName);
  const kind = EXT_KIND[ext];
  if (!kind) { ctx.results.push('⏭️ 略過「' + origName + '」（不支援的格式）'); return; }

  if (kind === 'zip') {
    if (ctx.depth >= 2) { ctx.results.push('⏭️ 略過「' + origName + '」（壓縮檔包太多層）'); return; }
    let entries;
    try { entries = Utilities.unzip(blob.setContentType('application/zip')); }
    catch (e) {
      // Google 內建解壓縮失敗（常見：中文檔名、Mac／手機壓縮、ZIP64）→ 改用自己寫的解壓縮
      try { entries = manualUnzip(blob); }
      catch (e2) { ctx.results.push('❌ 「' + origName + '」解壓縮失敗：' + e2.message); return; }
    }
    const zipInfo = analyzeFileName(origName, ctx.map, ctx.ts);
    const saved = ctx.fallback;
    ctx.fallback = {
      target: (saved && saved.force) ? saved.target : (zipInfo.target || (saved && saved.target) || null),
      force: !!(saved && saved.force),
      source: zipInfo.source !== '未知來源' ? zipInfo.source : (saved && saved.source) || '',
      date: detectDate(cleanStem(origName)) || (saved && saved.date) || '',
    };
    ctx.depth++;
    const files = entries.filter(function (e) {
      const n = e.getName() || '';
      return !/\/$/.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n) && !/(^|\/)Thumbs\.db$/i.test(n);
    });
    ctx.results.push('📦 解開「' + origName + '」：' + files.length + ' 個檔案');
    files.forEach(function (e) { processIncoming(e, (e.getName() || '').split('/').pop(), ctx); });
    ctx.depth--;
    ctx.fallback = saved;
    return;
  }

  const hash = md5(blob.getBytes());
  const dup = findLogByHash(ctx.log, hash);
  if (dup) { ctx.results.push(dupText(dup)); return; }

  const info = analyzeFileName(origName, ctx.map, ctx.ts);
  const fb = ctx.fallback;
  if (fb) {
    if ((!info.target || fb.force) && fb.target) info.target = fb.target;
    if (info.source === '未知來源' && fb.source) info.source = fb.source;
    if (fb.date && !detectDate(cleanStem(origName))) info.date = fb.date;
  }
  // v2.4 檔名看不出股票 → 讀圖片／PDF／文字檔的內容（圖片用 Google 文字辨識 OCR）
  let ocrNote = '';
  if (!info.target && (kind === 'image' || kind === 'pdf' || kind === 'text') && ext !== 'heic' && ext !== 'heif' && (ctx.ocrN || 0) < OCR_MAX_PER_MSG) {
    ctx.ocrN = (ctx.ocrN || 0) + 1;
    const g = guessFromContent(blob, kind, ctx.map);
    if (g.split) {   // v2.5 多檔股票的整理：原檔放「綜合整理」，內容拆成各公司的筆記
      const fr = getOrCreateChild(rootFolder(), DIGEST_FOLDER);
      const nm = uniqueName(fr.folder, today() + '_' + (g.split.header || '綜合整理').replace(/[\\\/:*?"<>|\n]/g, ' ').slice(0, 30).trim() + (ext ? '.' + ext : ''));
      const file = fr.folder.createFile(blob.setName(nm));
      file.setDescription('原始檔名：' + origName + '\nMD5：' + hash);
      appendLog(ctx.log, [now(), origName, nm, DIGEST_FOLDER, fr.folder.getName(), info.source, info.date, '已歸檔', file.getId(), hash, memberName(CUR_UID)]);
      const msg = saveSplitMemo(g.split, g.text, '\n🖼 原檔：' + file.getUrl(), true);
      ctx.results.push('✅ 已存入「' + DIGEST_FOLDER + '」：' + nm + '\n' + msg.text);
      return;
    }
    if (g.target) { info.target = g.target; ocrNote = '\n🔎 從' + (kind === 'image' ? '圖片文字' : '內容') + '認出：' + g.hit; }
    else if (g.candidates.length) info.candidates = g.candidates.concat(info.candidates.filter(function (c) { return g.candidates.indexOf(c) < 0; })).slice(0, 5);
    if (g.target && info.source === '未知來源') { const src = detectSource(g.head); if (src !== '未知來源') info.source = src; }
  }
  if (needsAsk(info.target)) {   // v1.6.1 產業要先問是哪個產業
    const isInd = !!info.target;
    const pid = savePending(blob, origName, hash, { source: info.source, date: info.date, kind: kind, ext: ext }, ctx.log);
    ctx.pendings.push({ id: pid, name: origName, candidates: info.candidates, industry: isInd });
    return;
  }
  const fr = targetFolder(info.target);
  const newName = uniqueName(fr.folder, buildFileName(info, ext));
  const file = fr.folder.createFile(blob.setName(newName));
  file.setDescription('原始檔名：' + origName + '\nMD5：' + hash);
  appendLog(ctx.log, [now(), origName, newName, categoryLabel(info.target), fr.folder.getName(), info.source, info.date, '已歸檔', file.getId(), hash, memberName(CUR_UID)]);
  ctx.saved.push(file.getId()); ctx.cands = ctx.cands.concat(info.candidates || []);
  let line = savedMessage(fr, newName, info.source) + ocrNote;
  if (CONVERT_TO[kind]) line += convertCopy(blob, newName, kind, ext, fr.folder.getId());
  if (ext === 'heic' || ext === 'heif') line += '\n※ HEIC 格式 AI 可能讀不到，下次建議改傳 JPG／PNG 或截圖';
  ctx.results.push(line);
  if (info.target.type === 'stock') ctx.targets.push(info.target);
}

function savePending(blob, origName, hash, meta, log) {
  const pending = getOrCreateChild(rootFolder(), PENDING_FOLDER).folder;
  const file = pending.createFile(blob.setName(origName));
  meta.orig = origName; meta.hash = hash;
  file.setDescription(JSON.stringify(meta));
  appendLog(log, [now(), origName, origName, '', PENDING_FOLDER, meta.source || '', meta.date || '', '待分類', file.getId(), hash, memberName(CUR_UID)]);
  return file.getId();
}

// 把處理結果整理成 LINE 回覆（有待分類的就附股票按鈕）
function finishCtx(ctx) {
  const msgs = [];
  const lines = ctx.results.slice();
  if (ctx.pendings.length) {
    const allIndHere = ctx.pendings.every(function (p) { return p.industry; });
    const g = joinPendingGroup(ctx.pendings.map(function (p) { return p.id; }), allIndHere);   // v1.7.1 連續傳的併成一組
    const cands = [];
    ctx.pendings.forEach(function (p) { (p.candidates || []).forEach(function (c) { if (cands.indexOf(c) < 0) cands.push(c); }); });
    const label = ctx.pendings.length === 1 ? ctx.pendings[0].name : ctx.pendings.length + ' 個檔案（' + ctx.pendings.map(function (p) { return p.name; }).slice(0, 3).join('、') + (ctx.pendings.length > 3 ? '…' : '') + '）';
    if (ctx.saved && ctx.saved.length) rememberSaved(ctx.saved, ctx.cands);
    if (lines.length) msgs.push(text(lines.join('\n\n')));
    msgs.push(askGroup(g, label, cands, ctx.map));
    return msgs.slice(0, 5);
  }
  const first = ctx.targets[0];
  const allSame = first && ctx.targets.every(function (t) { return t.code === first.code; });
  const msg = text(lines.length ? lines.join('\n\n') : '沒有可以存的檔案。');
  const items = [];
  if (ctx.saved && ctx.saved.length) {   // v2.6 分錯了一鍵改
    rememberSaved(ctx.saved, ctx.cands);
    items.push({ type: 'action', action: { type: 'postback', label: '✏️ 分錯了，改', data: 'fix|ASK', displayText: '分錯了' } });
    msg.text += '\n\n分錯了？按「✏️ 分錯了，改」，或打「改 股號」（例如：改 3167、改 產業 記憶體）。';
  }
  if (allSame && /✅/.test(msg.text)) {
    items.unshift({ type: 'action', action: { type: 'postback', label: ('更新 ' + cn(first.code) + ' 報告').slice(0, 20), data: 'rpt|' + first.code, displayText: '報告 ' + cn(first.code) } });
  }
  if (items.length) msg.quickReply = { items: items };
  return [msg];
}

// Office／文字檔另外轉一份 Google 格式（原檔保留），讓 AI 讀得到內容
function convertCopy(blob, newName, kind, ext, folderId) {
  try {
    const title = newName.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '（轉檔）';
    uploadToDrive(blob.getBytes(), UPLOAD_MIME[ext] || blob.getContentType(), title, CONVERT_TO[kind], folderId);
    return '\n＋ 另存可讀版：' + CONVERT_LABEL[kind];
  } catch (e) {
    return '\n⚠️ 轉成 ' + CONVERT_LABEL[kind] + ' 失敗（原檔已保存）：' + String(e.message || e).slice(0, 80);
  }
}

// 用 Drive API 上傳（可指定轉成 Google 文件／試算表／簡報）
function uploadToDrive(bytes, mediaMime, title, targetMime, folderId) {
  const boundary = 'b' + Utilities.getUuid().replace(/-/g, '');
  const meta = { name: title, parents: [folderId] };
  if (targetMime) meta.mimeType = targetMime;
  const head = Utilities.newBlob('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
    '\r\n--' + boundary + '\r\nContent-Type: ' + mediaMime + '\r\n\r\n').getBytes();
  const tail = Utilities.newBlob('\r\n--' + boundary + '--').getBytes();
  const payload = head.concat(bytes).concat(tail);
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: payload,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Drive 上傳失敗：' + res.getContentText().slice(0, 200));
  return DriveApp.getFileById(JSON.parse(res.getContentText()).id);
}

// ===== v1.5 連結：Google 雲端檔案／資料夾、一般網頁 =====
function handleLinks(ev, t) {
  const urls = t.match(/https?:\/\/[^\s<>"'，。）)]+/gi) || [];
  const lead = t.match(/^(\d{4,6}[A-Z]?)[\s,，:：]/) || t.match(/^([A-Za-z]{1,5}(?:\.[A-Za-z])?)[\s,，:：]+https?:/);
  const lock = LockService.getScriptLock();
  // v2.11 等太久 LINE 回覆會失效（看起來像沒反應）→ 最多等 25 秒，等不到就請你稍後再傳
  if (!lock.tryLock(25000)) return reply(ev.replyToken, [text('⏳ 系統正在處理前一批資料，這個連結還沒存。請 1 分鐘後再傳一次。')]);
  try {
    const ctx = newCtx(ev.timestamp);
    // v2.9 連結前後只寫股名也算指定：「聯發科 https://…」「https://… 聯發科」
    const shortRest = t.replace(/https?:\/\/[^\s<>"'，。）)]+/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!lead && shortRest && shortRest.length <= 12 && !/^產業/.test(shortRest)) {
      const pr = pickStock(shortRest.split(' ')[0]);
      if (pr.code) ctx.fallback = { target: { type: 'stock', code: pr.code, name: stockName(pr.code) }, source: '', date: '', force: true };
    }
    if (lead) {
      const code = resolveCode(lead[1], ctx.map);
      if (code) ctx.fallback = { target: { type: 'stock', code: code, name: stockName(code) }, source: '', date: '', force: true };   // v2.6 你指定的股號一定優先
    } else if (/^產業[\s,，:：]/.test(t)) {
      const nm = cleanIndustry((t.match(/^產業[\s,，:：]+([^\s]+?)[\s,，:：]+https?:/) || [])[1] || '');
      ctx.fallback = { target: { type: 'industry', sub: nm || '' }, source: '', date: '', force: !!nm };   // 指定產業名稱就以你說的為準
    }
    urls.slice(0, 10).forEach(function (u) {
      try { processLink(u, ctx); } catch (e) { ctx.results.push('❌ 處理失敗：' + u + '\n' + String(e.message || e).slice(0, 120)); }
    });
    const out = finishCtx(ctx);
    // v2.3 連結旁邊寫了一段自己的看法 → 也存成筆記（附上連結）
    let rest = t.replace(/https?:\/\/[^\s<>"'，。）)]+/gi, ' ');
    if (lead) rest = rest.replace(lead[0], ' ');
    rest = rest.replace(/^產業[\s,，:：]+[^\s]+/, ' ').replace(/\s+\n/g, '\n').trim();
    if (rest.length >= MEMO_MIN_LEN) {
      lock.releaseLock();
      const spl = splitSegments(rest);
      if (spl.segs.length >= 2) { out.push(saveSplitMemo(spl, rest, '\n🔗 ' + urls.join('\n🔗 '))); reply(ev.replyToken, out.slice(0, 5)); return; }
      const tg = ctx.fallback ? ctx.fallback.target : (nextTarget() || (function () { const f = findMemoTargets(rest); return f.length === 1 ? f[0] : null; })());
      if (tg && (tg.type !== 'industry' || tg.sub)) out.push(saveMemo([tg], rest + '\n🔗 ' + urls.join('\n🔗 ')));
      reply(ev.replyToken, out.slice(0, 5));
      return;
    }
    reply(ev.replyToken, out);
  } finally {
    lock.releaseLock();
  }
}

function processLink(url, ctx) {
  let m = url.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([\w-]{15,})/);
  if (m) {
    let folder;
    try { folder = DriveApp.getFolderById(m[1]); } catch (e) { ctx.results.push('❌ 無法開啟這個雲端資料夾（沒有權限或連結錯誤）'); return; }
    const it = folder.getFiles(); let n = 0;
    ctx.results.push('📁 雲端資料夾「' + folder.getName() + '」');
    while (it.hasNext() && n < 30) { processDriveFile(it.next(), ctx); n++; }
    if (it.hasNext()) ctx.results.push('⚠️ 資料夾超過 30 個檔案，只處理前 30 個');
    return;
  }
  m = url.match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)|docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/)([\w-]{15,})/);
  if (m) {
    let f;
    try { f = DriveApp.getFileById(m[1]); } catch (e) { ctx.results.push('❌ 無法開啟這個雲端檔案（沒有權限或連結錯誤）'); return; }
    processDriveFile(f, ctx);
    return;
  }
  processWebPage(url, ctx);
}

function processDriveFile(f, ctx) {
  const mime = f.getMimeType();
  if (/^application\/vnd\.google-apps\.(document|spreadsheet|presentation)$/.test(mime)) {
    const key = 'gdrive:' + f.getId();
    const dup = findLogByHash(ctx.log, key);
    if (dup) { ctx.results.push(dupText(dup)); return; }
    const info = analyzeFileName(f.getName() + '.x', ctx.map, ctx.ts);
    applyFallback(info, ctx);
    if (needsAsk(info.target)) {
      const pending = getOrCreateChild(rootFolder(), PENDING_FOLDER).folder;
      const copy = f.makeCopy(f.getName(), pending);
      copy.setDescription(JSON.stringify({ orig: f.getName(), hash: key, source: info.source, date: info.date, kind: 'gnative', label: f.getName().slice(0, 30) }));
      appendLog(ctx.log, [now(), f.getName(), f.getName(), '', PENDING_FOLDER, info.source, info.date, '待分類', copy.getId(), key, memberName(CUR_UID)]);
      ctx.pendings.push({ id: copy.getId(), name: f.getName(), candidates: info.candidates, industry: !!info.target });
      return;
    }
    const fr = targetFolder(info.target);
    const newName = uniqueName(fr.folder, buildFileName(info, '') + '_' + f.getName().slice(0, 30));
    const copy = f.makeCopy(newName, fr.folder);
    copy.setDescription('複製自：' + f.getUrl());
    appendLog(ctx.log, [now(), f.getName(), newName, categoryLabel(info.target), fr.folder.getName(), info.source, info.date, '已歸檔', copy.getId(), key, memberName(CUR_UID)]);
    ctx.saved.push(copy.getId());
    ctx.results.push(savedMessage(fr, newName, info.source));
    if (info.target.type === 'stock') ctx.targets.push(info.target);
    return;
  }
  if (mime === 'application/vnd.google-apps.folder' || /^application\/vnd\.google-apps\./.test(mime)) {
    ctx.results.push('⏭️ 略過「' + f.getName() + '」（這種 Google 檔案類型不支援）');
    return;
  }
  processIncoming(f.getBlob(), f.getName(), ctx);
}

function applyFallback(info, ctx) {
  const fb = ctx.fallback;
  if (!fb) return;
  if ((!info.target || fb.force) && fb.target) info.target = fb.target;
  if (info.source === '未知來源' && fb.source) info.source = fb.source;
}

// 網站 → 來源名稱；AI 產生的內容一律標「AI整理」（整合報告只當線索）
function webSource(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  const map = [
    [/gemini\.google\.com|^g\.co$|bard\.google|notebooklm|chatgpt\.com|openai\.com|claude\.ai|perplexity\.ai|copilot\.microsoft|poe\.com|grok\.com|x\.ai|deepseek|web\.app$|firebaseapp\.com$/, 'AI整理'],
    [/cnyes\.com/, '鉅亨網'], [/moneydj\.com/, 'MoneyDJ'], [/udn\.com/, '經濟日報'], [/ctee\.com\.tw/, '工商時報'],
    [/digitimes/, 'DIGITIMES'], [/technews\.tw/, '科技新報'], [/wealth\.com\.tw/, '財訊'], [/businesstoday/, '今周刊'],
    [/cw\.com\.tw/, '天下'], [/bnext\.com\.tw/, '數位時代'], [/trendforce/, 'TrendForce'], [/mops\.twse|twse\.com\.tw|tpex\.org\.tw/, '公開資訊'],
    [/bloomberg/, 'Bloomberg'], [/reuters/, 'Reuters'], [/nikkei|asia\.nikkei/, '日經'], [/semianalysis/, 'SemiAnalysis'],
    [/uanalyze/, '優分析'], [/youtube\.com|youtu\.be/, 'YouTube'],
  ];
  for (let i = 0; i < map.length; i++) if (map[i][0].test(host)) return map[i][1];
  return host.split('.').slice(-3).join('.') || '網頁';
}

function processWebPage(url, ctx) {
  const key = 'url:' + md5(Utilities.newBlob(url).getBytes());
  const dup = findLogByHash(ctx.log, key);
  if (dup) { ctx.results.push(dupText(dup)); return; }
  const host = (url.match(/^https?:\/\/([^\/?#]+)/i) || [])[1] || '';
  // v2.6 X（推特）貼文：網頁要登入抓不到，改用 X 公開的 oEmbed 取得貼文全文
  if (/(^|\.)(x|twitter)\.com$/i.test(host) && /\/status\/\d+/.test(url)) {
    // v2.12 先用 FxTwitter／VxTwitter 拿「Show more 之後」的完整長文、引用貼文、圖片；都失敗才用 oEmbed（長文會被截斷）
    const full = fetchXPostFull(url);
    if (full) { ctx.webNote = full.note; return processWebHtml(url, host, full.html, ctx, key); }
    const oe = UrlFetchApp.fetch('https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=' + encodeURIComponent(url.replace(/^https?:\/\/(www\.)?x\.com/i, 'https://twitter.com')), { muteHttpExceptions: true });
    if (oe.getResponseCode() === 200) {
      const d = JSON.parse(oe.getContentText());
      const html0 = '<html><head><title>X貼文 ' + (d.author_name || '') + '</title></head><body>' + String(d.html || '').replace(/<br\s*\/?>/gi, '<br>') + '</body></html>';
      ctx.webNote = '⚠️ 只拿到 X 的簡短版本，長文「Show more」後面可能沒有。建議複製全文或截圖再傳一次。';
      return processWebHtml(url, host, html0, ctx, key);
    }
    ctx.results.push('⚠️ 抓不到這則 X 貼文（可能是私人帳號或已刪除），建議改複製文字或截圖傳給我：' + url);
    return;
  }
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' } });
  const code = res.getResponseCode();
  if (code >= 400) { ctx.results.push('❌ 打不開這個網頁（HTTP ' + code + '），可能需要登入：' + url); return; }
  const headers = res.getHeaders();
  const ct = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();

  // 連結本身是檔案（PDF、圖片、Office…）
  const pathName = decodeURIComponent((url.split(/[?#]/)[0].split('/').pop() || ''));
  let ext = extOf(pathName);
  if (!ext) { const hit = Object.keys(UPLOAD_MIME).filter(function (k) { return ct.indexOf(UPLOAD_MIME[k]) === 0; })[0]; if (hit && hit !== 'html' && hit !== 'htm') ext = hit; }
  if (ext && EXT_KIND[ext] && ext !== 'html' && ext !== 'htm' && ct.indexOf('text/html') < 0) {
    processIncoming(res.getBlob(), pathName && extOf(pathName) ? pathName : 'download_' + today() + '.' + ext, ctx);
    return;
  }

  // 一般網頁 → 存成 Google 文件
  return processWebHtml(url, host, res.getContentText(), ctx, key);
}

function processWebHtml(url, host, html, ctx, key) {
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || host).replace(/\s+/g, ' ').trim();
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  // v2.5 網頁是多檔股票的整理 → 網頁存到「綜合整理」，內容拆到各公司筆記
  const lined = html.replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n');
  const spw = splitSegments(lined);
  if (spw.segs.length >= 2) {
    const frd = getOrCreateChild(rootFolder(), DIGEST_FOLDER);
    const dname = uniqueName(frd.folder, today() + '_網頁_' + title.replace(/[\\\/:*?"<>|]/g, ' ').slice(0, 30));
    const dfile = createDocFromHtml('<p><b>來源網址：</b>' + url + '</p><hr>' + (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, html])[1], dname, frd.folder.getId());
    appendLog(ctx.log, [now(), url, dname, DIGEST_FOLDER, frd.folder.getName(), webSource(host), today(), '已歸檔', dfile.getId(), key, memberName(CUR_UID)]);
    const msg = saveSplitMemo(spw, lined, '\n🔗 ' + url, true);
    ctx.results.push('✅ 已存入「' + DIGEST_FOLDER + '」：' + dname + '\n' + msg.text);
    if (ctx.webNote) { ctx.results.push(ctx.webNote); ctx.webNote = ''; }
    return;
  }
  const source = webSource(host);
  const info = analyzeFileName(title + '.x', ctx.map, ctx.ts);
  info.source = source;
  // v2.6 不只看標題：網址、標題、描述、關鍵字、內文開頭一起打分數，分數夠高又明顯領先才自動歸檔
  const meta = function (re) { return ((html.match(re) || [])[1] || '').replace(/\s+/g, ' '); };
  const rk = rankStocks([
    { text: urlStockHints(url), w: 4 },
    { text: title, w: 2 },
    { text: meta(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)/i), w: 2 },
    { text: meta(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) + ' ' + meta(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i), w: 1 },
    { text: meta(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)/i) + ' ' + meta(/<meta[^>]+name=["']news_keywords["'][^>]+content=["']([^"']*)/i), w: 1 },
    { text: plain.slice(0, 1500), w: 0.5 },
  ], ctx.map);
  const pick = rankDecide(rk);
  if (pick) info.target = { type: 'stock', code: pick, name: ctx.map[pick] || stockName(pick) };
  else if (info.target && info.target.type === 'stock') info.target = null;   // 標題猜的不夠可靠 → 改問你
  info.candidates = rk.slice(0, 5).map(function (x) { return x.code; });
  applyFallback(info, ctx);
  info.source = source; // 網站來源優先
  const label = '網頁_' + title.replace(/[\\\/:*?"<>|]/g, ' ').slice(0, 30);
  const body = '<p><b>來源網址：</b>' + url + '</p><p><b>抓取時間：</b>' + now() + '</p>' +
    (source === 'AI整理' ? '<p><b>⚠️ 這是 AI 產生的內容，整合報告只當線索，數字須以券商原文或小助理為準。</b></p>' : '') + '<hr>' +
    (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [null, html])[1];

  let file, fr = null;
  if (!needsAsk(info.target)) {
    fr = targetFolder(info.target);
    const name = uniqueName(fr.folder, buildFileName(info, '') + '_' + label);
    file = createDocFromHtml(body, name, fr.folder.getId());
    file.setDescription('來源網址：' + url);
    appendLog(ctx.log, [now(), url, name, categoryLabel(info.target), fr.folder.getName(), source, info.date, '已歸檔', file.getId(), key, memberName(CUR_UID)]);
    ctx.saved.push(file.getId()); ctx.cands = ctx.cands.concat(info.candidates || []);
    ctx.results.push(savedMessage(fr, name, source));
    if (info.target.type === 'stock') ctx.targets.push(info.target);
  } else {
    const pending = getOrCreateChild(rootFolder(), PENDING_FOLDER).folder;
    file = createDocFromHtml(body, label, pending.getId());
    file.setDescription(JSON.stringify({ orig: title, hash: key, source: source, date: info.date, kind: 'gnative', label: label, url: url }));
    appendLog(ctx.log, [now(), url, label, '', PENDING_FOLDER, source, info.date, '待分類', file.getId(), key, memberName(CUR_UID)]);
    ctx.pendings.push({ id: file.getId(), name: title.slice(0, 30), candidates: info.candidates, industry: !!info.target });
  }
  // v2.12 存檔後自我檢查：字數、被截斷的跡象、需要登入的跡象
  const qc = webQualityCheck(plain, title);
  ctx.results.push('📄 已存 ' + plain.length.toLocaleString() + ' 字' + (ctx.webNote ? '\n' + ctx.webNote : '') + (qc ? '\n' + qc : ''));
  ctx.webNote = '';
}

function webQualityCheck(plain, title) {
  const t = String(plain || '');
  if (t.length < 300) return '⚠️ 「' + String(title).slice(0, 30) + '」抓到的文字很少，可能需要登入或是動態產生的頁面，建議改傳 PDF、截圖或複製全文。';
  const tail = t.slice(-400);
  if (/(Show more|Read more|顯示更多|閱讀全文|看更多|繼續閱讀|展開全文|…\s*$|\.\.\.\s*$)/i.test(tail)) return '⚠️ 結尾看起來被截斷（有「顯示更多／閱讀全文」），可能只存到前半段，建議複製全文或截圖補傳。';
  if (/(請先登入|登入後|會員專屬|訂閱以閱讀|付費會員|Sign in to|Log in to|Subscribe to (continue|read)|JavaScript is (not available|disabled))/i.test(t.slice(0, 3000))) return '⚠️ 頁面要求登入或訂閱，內容可能不完整，建議截圖或複製全文補傳。';
  return '';
}

// ===== v1.4 報告完成（共用）：更新工作清單＋推播所有成員 =====
function completeJob(sh, j, report) {
  const summary = readSummary(report);
  const auto = isAutoJob(j);
  setJob(sh, j.row, { status: '完成', reportUrl: report.getUrl(), summary: summary, note: auto ? AUTO_NOTE : '' });
  j.status = '完成';
  pushAll([text((auto ? '🤖 選股系統自動做的｜' : '') + '📊 ' + jobLabel(j) + ' 整合報告完成\n' + (summary ? summary + '\n' : '') +
    '\n📑 整合報告：\n' + report.getUrl() + (j.dataUrl ? '\n\n📖 小助理原文：\n' + j.dataUrl : ''))]);
}

// ===== v1.4 報告規則（Claude Code、Gemini 共用；改這裡就兩邊一起改） =====
// v2.1 超額利潤期判斷框架（整理自優分析產業循環分析框架影片）
const EXCESS_PROFIT_RULES = [
  '## 超額利潤期判斷框架（使用者指定，必須照這套邏輯寫）',
  'A. 價漲期有兩種，一定要分開判斷（可以兩種都有，要說哪一種是主力、各占多少可佐證）：',
  '  ① 既有產品獲利改善＝原地漲價＋稼動率提升：產品沒明顯改變，靠漲價或滿載變好賺。持續性有上限：產能大量開出、供需缺口縮小後，漲價的理由就消退。',
  '  ② 產品組合升級＝高階產品占比提高：把有限產能從低毛利產品轉去做高毛利、高 ASP 產品（例：高階 CCL），平均單價與毛利率提高。有機會持續更久：即使新產能開出，只要高階占比繼續提高，ASP 與毛利率仍可能往上。',
  '  佐證要找：報價／合約價、稼動率、產品別或應用別營收占比、ASP、毛利率（季）、法說會對產品組合的說法。',
  'B. 供需缺口：價漲期＝供給不變、缺口擴大（需求不清楚、不斷被畫餅喊高；高階產品難做、良率低，供給上不來）。',
  '  - Brownfield（既有廠區擴充、去瓶頸）用到極限後，只能蓋新產能＝Greenfield 進場，新增供給開始進來。',
  '  - 資本支出上修的意義會反轉：初期（大家都沒產能）上修＝訂單越來越多，是正面；大量產能逐漸出現後還在上修，市場會擔心缺口變小、甚至供過於求，變成反動力。',
  '  - 要列出：公司與主要同業的新產能（地點、規模、量產時間）、Brownfield 還剩多少空間、Greenfield 何時開出。',
  'C. 轉折點＝決策點：供給集中開出的「過渡期」。這時需求上修大多已經清楚、反而開始出現需求下修；新廠蓋好、生產技術也順了，反而出現供給上修，缺口收斂得比想像中快。',
  '  - 不能只看「需求還是很好」：市場對需求上修有反應，對供給增加的訊息卻常沒反應，報告必須把供給面的訊號明確寫出來。',
  'D. 關鍵問題：第一階段讓公司變得更好賺的那股動能，到了第二階段（量產／產能開出後）還在嗎？',
  'E. 轉折點的三種劇本（看第二階段還剩幾股驅動力）：',
  '  ③ 價量齊揚（價↑＋量↑，雙驅動）→ 續抱：超額利潤可延續（訂單持續增加、新產能被吃下，出貨量成長承接超額利潤）。',
  '  ④ 價轉量（價→＋量↑，只剩量驅動）→ 趁高檔跑：能成長，但難有超額漲幅，有更好的選擇就換。',
  '  ⑤ 價跌量增（價↓＋量↑，跌價抵銷量增）→ 快跑：跌價拖累盈餘（同業產能開出、分食搶單、價格鬆動＝超額利潤見頂）。',
  '  驅動力越少，越接近離場時刻。',
  'F. 每一個判斷都要附佐證數字與來源；資料不夠就寫「資料不足」並列出要補什麼資料，不可以硬下結論。',
].join('\n');

// v2.15 產業循環課：供應鏈受惠順序、法人上下修、跟著 EPS 走
const ROTATION_RULES = [
  '## 產業輪動判斷框架（使用者上課整理，必須照這套邏輯寫）',
  'A. 供應鏈受惠有先後順序，而且順序不會改變：需求會沿著供應鏈一路往下傳，不會同時發生。',
  '  例（CoWoS 擴產）：①先擴 CoWoS 產能 → ②設備先受惠（如萬潤）→ ③CoWoS 產能開出 → ④ABF 載板用量增加 → ⑤封裝量增加（如日月光）→ ⑥後段測試需求再往上（如京元電）。',
  '  → 要知道某一環會不會好，先看「它前面那一環」走到哪了。報告要寫：這家公司在供應鏈第幾棒、前一棒現在的狀態、目前正在出貨的是哪一棒、下一棒是誰。',
  'B. 法人上下修＝出貨時間點的訊號：公司與法人通常只說「第幾季」出貨，不說幾月；當法人 EPS 突然上修或下修，代表他們算出了營收何時進來。',
  '  - 同產業「不同公司同時上修」（例：穩懋、宏捷科同一天上修）＝這個產業有改變，要找出改變是什麼。',
  '  - 供需資料顯示需求＞供給（例：PCB 鑽針 2026 年起轉為供不應求，尖點被上修）也會帶來上修。',
  '  - 上修的時間點就是需求發生的時間點，上修機會出現時股價常大漲。',
  'C. 上修原因決定週期走到哪：',
  '  - 需求端上修（終端需求上修）＝週期還沒到尾巴，還有時間。',
  '  - 供給端上修（出貨量、產量優於預期，或搶到別人的市占率）＝可能已到尾段，週期將結束。',
  'D. 跟著 EPS 走、估值會回歸：資金先追超額利潤，最後還是回到估值。',
  '  - A 產業今年 EPS 已大幅成長但股價不漲（本益比被壓低）、B 產業明年才成長但股價已提前反映（估值被拉高）→ 都不合理，資金會重新配置；B 這種「明年才好、今年先漲」的最容易遇到估值修正。',
  '  - 永遠要確認「公司什麼時候真的有 EPS」；故事要能改變 EPS 走向才是真的。',
  'E. 資金配置步驟：①抓出成長趨勢、關注何時進入超額利潤週期 ②盡量在超額利潤發生前佈局（沒抓到，開始發生時也可以趕快佈局）③判斷哪家公司本輪有 EPS 推升力量（含金量比預期高、盈餘被上修、價格漲較多、成長率較高）④隨供應鏈往下一棒轉移資金（例：封裝產能開出後換測試、雷射光源出貨後換光模組 PCB）。',
].join('\n');

const REPORT_RULES = [
  '# 股票整合報告撰寫規則',
  '全程使用繁體中文。你是使用者的股票研究助理，使用者用「循環週期」框架判斷股票（見下方六階段）。',
  '',
  '## 判斷版本',
  '- files/ 裡沒有「過去整合報告」→ 寫「首次全面版」。',
  '- 有 → 寫「追蹤版」，要跟最近一份過去報告、上一份小助理原文比較。',
  '',
  '## 查證原則（最重要）',
  '- 每個數字都必須能在 files/ 的原文（券商 PDF 或小助理）中找到，禁止憑記憶或推測補數字。',
  '- 數字互相矛盾時，列在「查證提醒」並說明以哪個為準。',
  '- 來源分級：券商 PDF 原文＞優分析小助理＞其他二手整理。檔名來源為「AI整理」的文件只能當線索，不可引用其數字。',
  '- 超過 3 個月的法人報告標示「資料偏舊」。',
  '- 上漲空間、本益比、營收達成所需數字等要實際計算，四捨五入到小數一位。',
  '- 小助理原文中 🔴 開頭的句子是原文紅字（偏正面），🟢 開頭是原文綠字（偏風險）。',
  '- files/ 可能還有：圖片／截圖（請直接看圖讀數字）、.csv（Excel 轉出）、簡報 PDF、網頁存檔 .md（檔名含「網頁_」）、Word／TXT 轉檔。',
  '- 檔名或內容標示「AI整理」（Gemini、ChatGPT 等 AI 產生）的資料只能當線索：裡面的數字必須在券商原文、小助理或公開資訊中找得到才可引用，找不到就列入「查證提醒」。',
  '- 新聞、網頁資料標明出處網站與日期；與券商原文衝突時以券商原文為準並說明。',
  '- 若你有網路搜尋工具，可以補「最新且可查證」的公開資料（公司公告、月營收、法說會簡報、產業報價、同業擴產新聞），每一筆都要附網址與日期，來源標「網路」；與 files 原文衝突時以券商原文為準並說明。沒有搜尋工具就只用 files。',
  '- files/選股系統技術面.md 是使用者自己的 SEPA 選股系統（超級績效趨勢模板＋VCP）當天的計算結果，技術面數字以它為準。',
  '- files/我的筆記.md 是使用者自己用 LINE 記下的筆記（最新在最上面，每則有日期）：代表使用者的觀察與疑問，不是查證過的資料。報告要①在決策卡或相關段落回應筆記裡的疑問與論點（同意／不同意＋證據）②筆記裡的數字若找不到原文佐證，列入查證提醒，不可當成事實引用。',
  '- files/小助理更新紀錄.md 是優分析「小助理更新重點」逐日累積的一句話重點（最多約 4 個月）：在本期重點與論點追蹤中，指出最近的更新與較早的說法相比「改變了什麼」（例如由樂觀轉保守、數字上修或下修），並標出日期。',
  '',
  '## 閱讀設計（最重要：讓使用者 1 分鐘看懂，再決定要不要往下讀）',
  '- 第一屏就是「⚡ 決策卡」，使用者只看這張表就要知道結論；後面各段只放支撐決策卡的證據，不重複決策卡已寫過的句子。',
  '- 每一段開頭第一行是一句粗體結論（20 字內），下面才是表格；能用表格就不要寫長段落，每格 1～2 句。',
  '- 同一個數字全文只詳細出現一次，其他地方用「見二」帶過。沒有新資訊的段落直接寫「本期無變化」，不要湊字。',
  '- 篇幅：首次全面版約 2500～3500 字，追蹤版約 1200～2000 字（不含表格數字）。',
  '- 資料不夠的問題，決策卡寫「資料不足：缺〇〇」，不要硬給結論；這比錯的結論更有價值。',
  '',
  '## 首次全面版，依序：',
  '⚡ 決策卡（緊接在圖例後面，表格四欄：問題｜結論｜信心 高／中／低｜關鍵佐證：1 個數字＋來源日期）。八列固定：',
  '  ① 產業階段＋供應鏈位置：價漲期／量增期／趨緩期／下行期（對應六階段：③漲價＝價漲期、④⑤＝量增期、⑥＝趨緩期、之後＝下行期）；並寫「本公司是第幾棒、前一棒走到哪」（依「產業輪動判斷框架」A）。',
  '  ② 獲利主要來自：漲價／稼動率／產品升級／出貨量，依貢獻排序（例：產品升級＞稼動率＞漲價）。',
  '  ③ 新產能開出後劇本：價量齊揚／ASP 持平或小漲、由出貨量接棒／量增價跌；並寫「增幅最大的時間點」（例：2027H1）。',
  '  ④ 誰掌控新增有效供給＋客戶換供應商難易（認證期、良率門檻、綁定程度）：寫成「供給集中在〇〇；換供應商難／中／易」。',
  '  ⑤ 本輪上行原因與上一輪不同處：強度比上次 更強／相當／較弱，何時轉強（或已轉強的時間點）。',
  '  ⑥ 公司營運轉折點：預估落在哪一季（向上或向下的轉折都要寫明方向）。',
  '  ⑦ 股價已反映多少＋EPS 時間軸：例「已反映正常化 EPS 的 1.3 倍＝反映到 2027 年」；並寫 EPS 是「今年就有」還是「明年才有、股價先反映」（後者標⚠️估值修正風險）。',
  '  ⑧ 最近的上下修：有沒有被法人上修／下修、原因是需求端（週期未到尾）還是供給端（出貨／產量優於預期、搶市占＝可能尾段）、同業是否同步上修。沒有上下修資料就寫「近期無」。',
  '  決策卡下方一行「🎯 結論：續抱／趁高檔跑／快跑／觀察（尚未到轉折點）」＋一行「📅 下一個驗證點：事件＋日期」（例：11/10 十月營收、法說會）。',
  '',
  '一、本期重點（最多 3 點，只放會改變決策卡的事）',
  '二、景氣與供需（支撐決策卡①④⑤）：',
  '  表格六列固定：需求｜ASP／報價｜庫存（公司與通路）｜訂單（在手、合約負債、交期）｜稼動率｜新增產能（公司與同業：地點、規模、量產時間，分 Brownfield／Greenfield）；欄位：指標｜最新狀況｜趨勢 ↑→↓｜來源日期。',
  '  接著：誰掌控新增有效供給（前幾大廠商的擴產節奏、新進者門檻）、客戶轉換成本；本輪 vs 上一輪循環比較表（驅動力、需求來源、供給紀律、價格漲幅、持續時間）。',
  '  設備商要提醒：客戶擴產放緩時設備訂單會提前反轉，需追蹤主要客戶資本支出。',
  '  供應鏈位置（支撐①）：一張表列出這條供應鏈的順序（第幾棒｜環節｜代表公司｜目前狀態：已出貨／準備中／尚未）＋本公司位置；說明前一棒的進度對本公司何時受惠的意義、下一棒是誰。',
  '三、獲利引擎與劇本（支撐決策卡②③⑥，依「超額利潤期判斷框架」）：',
  '  (1) 獲利拆解：營收與毛利的成長，各有多少來自 漲價／稼動率／產品升級（高階占比、ASP）／出貨量，能量化就量化，不能就說明依據。',
  '  (2) 第一階段的獲利動能，到新產能開出後還在嗎？→ 劇本判斷（③價量齊揚續抱／④價轉量趁高檔跑／⑤價跌量增快跑）與增幅最大的時間點。',
  '  (3) 轉折點時間：需求是否開始下修、供給是否開始上修、資本支出上修是正面還是反動力；推估公司營運轉折落在哪一季。',
  '  選股系統技術面.md 若有「超額利潤型態」標籤，對照說明是否一致。',
  '四、估值：已反映多少成長（支撐決策卡⑦）—— 禁止直接用景氣高峰 EPS 算便宜貴：',
  '  (1) 正常化 EPS：用一個完整循環（含一次谷底，約 5～8 年）的平均毛利率或營益率 × 目前合理營收規模估算；若產品升級有實證，可上調並寫明理由與幅度。歷史資料不足就寫「資料不足」並改用法人中期（明後年）EPS 的保守值，並標明。',
  '  (2) 比較：歷史本益比／股價淨值比區間（低、中位、高）與 2～4 家同業目前估值（表格：公司｜股價｜PE（正常化）｜PB｜備註）。',
  '  (3) 結論：股價 ÷ 正常化 EPS ＝ 正常化 PE，對照歷史中位數 → 已反映程度與「反映到哪一年」；再列法人目標價共識區間（最高／最低／中位數，只有一家就註明）與上漲空間。',
  '  (4) EPS 時間軸：今年／明年／後年 EPS（法人共識）與各年本益比；判斷是「今年就有 EPS 支撐」還是「明年才好、今年先反映」，後者要提醒估值修正風險（依「產業輪動判斷框架」D）。',
  '五、法人觀點與上下修（支撐決策卡⑧）：最新橫向表（券商｜日期｜評等｜目標價｜今年 F／明年 F EPS）；上修／下修表（日期｜券商｜幅度｜原因｜需求端或供給端）；同業是否同一段時間也被上修（有就點名，代表產業有變化）。',
  '六、優分析小助理與技術面（精簡）：🔴紅字重點、🟢綠字重點各最多 3 點；技術面一行（趨勢模板、VCP 評分、RS、買點／停損／風險%），並說明基本面階段與股價位置是否一致（例：價漲期但股價離 50 日線很遠＝追高風險）。沒有技術面檔案就寫「無選股系統資料」。',
  '七、追蹤與風險：論點追蹤表（約 8 項：追蹤項目｜目前數值｜轉好／轉壞的門檻｜下次觀察時間），至少含季毛利率、高階占比或 ASP、稼動率、同業新產能時間、報價；最後列 3 個最大風險。',
  '附錄：查證提醒（數字矛盾、AI整理線索）、法人縱向明細、資料清單。',
  '',
  '## 追蹤版（第二次以後），依序：',
  '⚡ 決策卡：同首次版七列，多一欄「與上版比」（↑轉好／↓轉壞／＝不變，變了要寫舊→新）；任何一列結論改變，標題標「⚠️ 結論改變」並寫進摘要。',
  '  決策卡下方同樣有「🎯 結論」與「📅 下一個驗證點」。',
  '一、本期重點（最多 3 點，只講這段期間的變化）',
  '二、改變了什麼：小助理差異（🆕新增、🔄數字改變 舊→新、❌消失）＋法人上修／下修＋新資料；沒變的不要重複。',
  '三、決策卡有變化的列才展開證據（對應首次版二～四段的格式），沒變的列寫「同上版」。',
  '四、論點追蹤：上一版追蹤表逐條標 ✅符合／⚠️待觀察／❌不符，再產出新追蹤表。',
  '五、技術面一行與風險變化。附錄：查證提醒、資料清單。',
  '',
  '## HTML 格式',
  '- 完整 HTML 文件（<html><head><meta charset="utf-8"></head><body>…</body></html>）。',
  '- 第一行 <h1>{股號} {名稱}｜整合報告（首次全面版／追蹤版）</h1>。',
  '- 第二段必須是單獨一個 <p>，以「摘要：」開頭，100 字以內，給 LINE 推播用，格式：「〔產業階段〕〔劇本〕〔估值反映〕＋最重要變化＋下一個驗證點」，例：「價漲期→量增期過渡；產品升級撐毛利，劇本偏價量齊揚；已反映到2027年；留意11月同業新產能」。',
  '- 第三段：報告日期、版本、資料來源、「僅供研究參考，不構成投資建議」。',
  '- 第四段顏色圖例：<span style="color:#d93025;font-weight:bold">紅字＝偏正面重點</span>、<span style="color:#188038;font-weight:bold">綠字＝偏風險／需留意</span>、<b>粗體＝關鍵數字</b>。',
  '- 全文照優分析方式上色：偏正面用 <span style="color:#d93025;font-weight:bold">，偏風險用 <span style="color:#188038;font-weight:bold">，關鍵數字用 <b>。',
  '- 表格用 <table border="1" cellpadding="4" cellspacing="0">。不要用 CSS class 或 <style>，只用行內 style。',
  '',
  EXCESS_PROFIT_RULES,
  '',
  ROTATION_RULES,
].join('\n');

const ESTIMATE_RULES = [
  '## 法人預估 CSV（estimates.csv）',
  '對報告中引用的每一份法人報告各寫一列，第一列是標題，欄位與順序固定：',
  ESTIMATE_HEADERS.join(','),
  '報告日期用 yyyy-MM-dd；資料等級填「原文」或「二手」；沒有的欄位留空；欄位內不要有逗號。',
].join('\n');

// ===== v1.4 資料包：把一檔股票的資料整理成清單（小助理原文、法人 PDF、過去報告、追蹤表紀錄） =====
function buildPack(code, name) {
  if (isIndCode(code)) return buildIndustryPack(code, name);
  const folder = getStockFolder(code, name).folder;
  const files = [];
  const docs = [], reports = [], pdfs = [], images = [], others = [], sheets = [], slides = [];
  let techDoc = null, memoDoc = null;
  if (!isUS(code)) { try { techDoc = refreshScreenerDoc(code, name || getStockMap()[code] || '', folder); } catch (e) { console.warn('選股系統技術面失敗：' + e); } }
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const n = f.getName();
    const mt = f.getMimeType();
    if (/_舊版|_Gemini測試報告_|_選股系統技術面|_小助理更新紀錄/.test(n)) continue;
    if (n.indexOf(MEMO_SUFFIX) >= 0 && mt === MimeType.GOOGLE_DOCS) { memoDoc = f; continue; }
    if (mt === MimeType.PDF) pdfs.push(f);
    else if (/^image\//.test(mt) && !/heic|heif/.test(mt)) images.push(f);
    else if (mt === MimeType.GOOGLE_DOCS && n.indexOf(code + '_優分析小助理_') === 0) docs.push(f);
    else if (mt === MimeType.GOOGLE_DOCS && n.indexOf(code + REPORT_TITLE) === 0) reports.push(f);
    else if (mt === MimeType.GOOGLE_DOCS) others.push(f);          // Word／TXT／網頁轉檔、雲端複製的文件
    else if (mt === MimeType.GOOGLE_SHEETS) sheets.push(f);        // Excel 轉檔
    else if (mt === MimeType.GOOGLE_SLIDES) slides.push(f);        // PowerPoint 轉檔
    // Office 原檔略過（已有轉檔版）
  }
  const byNew = function (a, b) { return b.getDateCreated() - a.getDateCreated(); };
  [docs, reports, pdfs, images, others, sheets, slides].forEach(function (a) { a.sort(byNew); });
  const clean = function (n) { return n.replace(/[\\\/:*?"<>|]/g, '_'); };
  if (techDoc) files.push({ id: techDoc.getId(), name: '選股系統技術面.md', kind: 'doc' });
  if (memoDoc) files.push({ id: memoDoc.getId(), name: '我的筆記.md', kind: 'doc' });
  if (!isUS(code)) try { const ud = refreshUpdatesDoc(code, name || getStockMap()[code] || '', folder); if (ud) files.push({ id: ud.getId(), name: '小助理更新紀錄.md', kind: 'doc' }); } catch (e) { console.warn('小助理更新紀錄失敗：' + e); }
  docs.slice(0, 2).forEach(function (f, i) { files.push({ id: f.getId(), name: (i === 0 ? '小助理原文_最新_' : '小助理原文_上一份_') + clean(f.getName()) + '.md', kind: 'doc' }); });
  reports.slice(0, 1).forEach(function (f) { files.push({ id: f.getId(), name: '過去整合報告_' + clean(f.getName()) + '.md', kind: 'doc' }); });
  pdfs.slice(0, 12).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()), kind: 'pdf', size: f.getSize() }); });
  others.slice(0, 10).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()) + '.md', kind: 'doc' }); });
  sheets.slice(0, 6).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()) + '.csv', kind: 'sheet' }); });
  slides.slice(0, 6).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()) + '.pdf', kind: 'slides' }); });
  images.slice(0, 10).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()), kind: 'image' }); });

  // 追蹤表裡這檔股票的既有紀錄（讓報告能做縱向比較）
  let history = '';
  try {
    const rows = getEstimateSheet().getDataRange().getValues();
    const mine = rows.slice(1).filter(function (r) { return normalizeCell(r[0], 0) === code; });
    if (mine.length) history = [ESTIMATE_HEADERS.join(',')].concat(mine.map(function (r) { return r.map(function (v, i) { return normalizeCell(v, i); }).join(','); })).join('\n');
  } catch (e) { /* 沒有追蹤表就算了 */ }

  return { code: code, name: name || stockName(code), folderId: folder.getId(), today: today(), files: files,
    history: history, rules: isUS(code) ? REPORT_RULES + US_RULES_NOTE : REPORT_RULES, estimateRules: ESTIMATE_RULES, hasPrevious: reports.length > 0 };
}

// ===== v1.4 Windows 小程式介面 =====
// 領一份「已抓取、還沒寫報告、沒有人在寫」的工作
function runnerNextReport(p) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  prop('LAST_RUNNER_POLL', String(Date.now()));
  if (prop('ACTIVE_JOBS') !== '1') return { ok: true, job: null };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: true, job: null };
  try {
    const sh = getJobSheet();
    const job = jobRows(sh).filter(function (j) {
      if (j.status !== '已抓取') return false;
      if (j.note.indexOf('本機寫作中') >= 0 && j.updated && Date.now() - j.updated.getTime() < 40 * 60000) return false;
      if (j.note.indexOf('本機失敗') >= 0 && j.updated && Date.now() - j.updated.getTime() < 30 * 60000) return false; // 失敗後 30 分鐘再試（例如額度用完）
      return !findReportDoc(j);
    })[0];
    if (!job) return { ok: true, job: null };
    setJob(sh, job.row, { note: (isAutoJob(job) ? AUTO_NOTE + ' ' : '') + '本機寫作中 ' + Utilities.formatDate(new Date(), TZ, 'HH:mm') });
    const pack = buildPack(job.code, job.name);
    pack.jobId = job.id;
    return { ok: true, job: pack };
  } finally {
    lock.releaseLock();
  }
}

// 指定股票的資料包（Gemini 測試或手動使用），不動工作清單
function runnerPack(p) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  const code = resolveCode(p.code, getStockMap());
  if (!code) return { ok: false, error: '查不到股號 ' + p.code };
  return { ok: true, job: buildPack(code) };
}

// 下載單一檔案：Google 文件回傳純文字，PDF 回傳 base64
function runnerFile(p) {
  if (!checkScrapeKey(p)) return ContentService.createTextOutput('ERR bad key');
  const f = DriveApp.getFileById(p.id);
  const root = rootFolder().getId();
  let ok = false; // 只允許下載根資料夾底下的檔案
  const parents = f.getParents();
  while (parents.hasNext()) { const par = parents.next(); const pp = par.getParents(); if (par.getId() === root || (pp.hasNext() && pp.next().getId() === root)) ok = true; }
  if (!ok) return ContentService.createTextOutput('ERR not allowed');
  const mt = f.getMimeType();
  if (mt === MimeType.GOOGLE_DOCS) return ContentService.createTextOutput(DocumentApp.openById(f.getId()).getBody().getText());
  if (mt === MimeType.GOOGLE_SHEETS) return ContentService.createTextOutput(sheetToText(f.getId()));
  if (mt === MimeType.GOOGLE_SLIDES) return ContentService.createTextOutput(Utilities.base64Encode(exportAs(f.getId(), 'application/pdf')));
  return ContentService.createTextOutput(Utilities.base64Encode(f.getBlob().getBytes()));
}

// 試算表 → 每個工作表一段 CSV 文字（每表最多 500 列）
function sheetToText(id) {
  return SpreadsheetApp.openById(id).getSheets().map(function (sh) {
    const v = sh.getDataRange().getDisplayValues().slice(0, 500);
    return '## 工作表：' + sh.getName() + '\n' + v.map(function (r) { return r.map(function (c) { c = String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\n');
  }).join('\n\n');
}

function exportAs(id, mime) {
  const res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=' + encodeURIComponent(mime), {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('匯出失敗：' + res.getContentText().slice(0, 200));
  return res.getBlob().getBytes();
}

// 交報告：HTML → Google 文件；CSV → 法人預估追蹤表；完成工作並推播
function runnerSubmit(p, body) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  const code = String(body.code || '');
  if (p.test === 'gemini') { // Gemini 對照測試：只存文件，不動工作清單
    const folder = getStockFolder(code, body.name).folder;
    const doc = createDocFromHtml(String(body.html || ''), code + '_Gemini測試報告_' + today() + '_' + Utilities.formatDate(new Date(), TZ, 'HHmm'), folder.getId());
    return { ok: true, url: doc.getUrl() };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = getJobSheet();
    const j = jobRows(sh).filter(function (x) { return x.id === String(body.jobId); })[0];
    if (!j) return { ok: false, error: 'job not found' };
    if (body.error) {
      setJob(sh, j.row, { note: (isAutoJob(j) ? AUTO_NOTE + ' ' : '') + '本機失敗：' + String(body.error).slice(0, 200) + '（雲端排程會補寫）' });
      return { ok: true };
    }
    if (j.status !== '已抓取') return { ok: true, ignored: true };
    const existing = findReportDoc(j);
    if (existing) { completeJob(sh, j, existing); return { ok: true, url: existing.getUrl(), note: '已有報告' }; }

    const folder = jobFolder(j.code, j.name);
    let title = j.code + '_整合報告_' + today();
    if (folder.getFilesByName(title).hasNext()) title += '_' + Utilities.formatDate(new Date(), TZ, 'HHmm');
    const report = createDocFromHtml(String(body.html || ''), title, folder.getId());
    if (body.csv) {
      try { importEstimateRows(Utilities.parseCsv(String(body.csv).replace(/^﻿/, ''))); } catch (e) { console.warn('CSV 登錄失敗：' + e); }
    }
    completeJob(sh, j, report);
    return { ok: true, url: report.getUrl() };
  } finally {
    lock.releaseLock();
  }
}

// HTML 轉成 Google 文件（用 Drive API 匯入，保留顏色、表格）
function createDocFromHtml(html, title, folderId) {
  if (!/<html/i.test(html)) html = '<html><head><meta charset="utf-8"></head><body>' + html + '</body></html>';
  const boundary = 'b' + Utilities.getUuid().replace(/-/g, '');
  const meta = JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] });
  const payload = Utilities.newBlob(
    '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n' +
    '--' + boundary + '\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n' + html + '\r\n--' + boundary + '--').getBytes();
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary, payload: payload,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('建立 Google 文件失敗：' + res.getContentText().slice(0, 300));
  return DriveApp.getFileById(JSON.parse(res.getContentText()).id);
}

// 把多列法人預估併入追蹤表（重複的跳過）；rows 第一列是標題
function importEstimateRows(rows) {
  const target = getEstimateSheet();
  const existing = target.getDataRange().getValues().slice(1).map(estimateKey);
  let added = 0;
  rows.slice(1).forEach(function (r) {
    if (!r[0] || !r[2]) return;
    const row = ESTIMATE_HEADERS.map(function (_, i) { return normalizeCell(r[i], i); });
    const key = estimateKey(row);
    if (existing.indexOf(key) >= 0) return;
    target.appendRow(row);
    existing.push(key);
    added++;
  });
  return added;
}

// ===== v1.3 成員管理 =====
// 成員存在指令碼屬性 MEMBERS（JSON）。ALLOWED_USER_ID 永遠是管理者。
function getMembers() {
  const admin = prop('ALLOWED_USER_ID');
  let list = safeJsonArr(prop('MEMBERS'));
  if (admin && !list.some(function (m) { return m.id === admin; })) {
    list.unshift({ id: admin, name: lineName(admin) || '管理者', role: 'admin', added: now() });
    prop('MEMBERS', JSON.stringify(list));
  }
  return list;
}
function isMember(uid) { return getMembers().some(function (m) { return m.id === uid; }); }
function isAdmin(uid) { return uid && uid === prop('ALLOWED_USER_ID'); }
function memberName(uid) {
  const m = getMembers().filter(function (x) { return x.id === uid; })[0];
  return m ? m.name : '';
}

function lineName(uid) {
  try {
    const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + uid, {
      headers: { Authorization: 'Bearer ' + prop('LINE_CHANNEL_ACCESS_TOKEN') }, muteHttpExceptions: true });
    return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).displayName : '';
  } catch (e) { return ''; }
}

// 非成員傳訊息 → 回覆等待審核，並通知管理者（同一人一天只通知一次）
function handleStranger(ev) {
  const uid = ev.source.userId;
  const name = lineName(uid) || '（未知名稱）';
  const asked = safeJson(prop('JOIN_REQUESTS'));
  const last = Number(asked[uid] || 0);
  if (Date.now() - last > 86400000) {
    asked[uid] = Date.now();
    prop('JOIN_REQUESTS', JSON.stringify(asked));
    const msg = text('🙋 有人申請使用股票檔案小幫手：' + name + '\n要讓他使用嗎？');
    msg.quickReply = { items: [
      { type: 'action', action: { type: 'postback', label: '✅ 允許', data: 'mem|add|' + uid, displayText: '允許 ' + name } },
      { type: 'action', action: { type: 'postback', label: '❌ 拒絕', data: 'mem|no|' + uid, displayText: '拒絕 ' + name } },
    ] };
    push([msg]);
  }
  if (ev.replyToken) reply(ev.replyToken, [text('你好！你還沒有使用權限，已經通知管理者，審核通過後會通知你。')]);
}

function handleMemberDecision(action, uid) {
  if (!isAdmin(CUR_UID)) return '只有管理者可以審核成員。';
  if (!uid) return '資料不完整。';
  const asked = safeJson(prop('JOIN_REQUESTS'));
  delete asked[uid];
  prop('JOIN_REQUESTS', JSON.stringify(asked));
  if (action === 'no') return '已拒絕。';
  const list = getMembers();
  if (list.some(function (m) { return m.id === uid; })) return '他已經是成員了。';
  const name = lineName(uid) || ('成員' + list.length);
  list.push({ id: uid, name: name, role: 'member', added: now() });
  prop('MEMBERS', JSON.stringify(list));
  push([text('✅ 你已經可以使用股票檔案小幫手了！\n\n' + helpText())], uid);
  return '✅ 已加入成員：' + name + '\n之後報告完成會同時推播給他。';
}

function membersText() {
  const lines = getMembers().map(function (m) { return (m.role === 'admin' ? '👑 ' : '・') + m.name + '（' + (m.role === 'admin' ? '管理者' : '成員') + '，' + String(m.added).slice(0, 10) + ' 加入）'; });
  return '目前成員：\n' + lines.join('\n') + (isAdmin(CUR_UID) ? '\n\n要移除請傳「移除 名字」。' : '');
}

function removeMember(name) {
  if (!isAdmin(CUR_UID)) return '只有管理者可以移除成員。';
  const list = getMembers();
  const hit = list.filter(function (m) { return m.name === name && m.role !== 'admin'; })[0];
  if (!hit) return '找不到成員「' + name + '」（管理者不能移除）。傳「成員」看名單。';
  prop('MEMBERS', JSON.stringify(list.filter(function (m) { return m.id !== hit.id; })));
  return '已移除：' + hit.name;
}

// 每個人各自的「最近一份待分類檔案」
function pendKey() { return 'LAST_PENDING_FILE_ID' + (CUR_UID && !isAdmin(CUR_UID) ? '_' + CUR_UID : ''); }

// ===== v1.3 法人預估自動登錄：排程任務產生的「法人預估_待登錄_*」→ 併入「法人預估追蹤表」 =====
function importEstimates() {
  const sys = getOrCreateChild(rootFolder(), SYSTEM_FOLDER).folder;
  const it = sys.searchFiles("title contains '" + ESTIMATE_PREFIX + "' and trashed = false");
  const files = [];
  while (it.hasNext()) files.push(it.next());
  if (!files.length) return;

  let added = 0;
  files.forEach(function (f) {
    let rows = [];
    try {
      if (f.getMimeType() === MimeType.GOOGLE_SHEETS) rows = SpreadsheetApp.openById(f.getId()).getSheets()[0].getDataRange().getValues();
      else rows = Utilities.parseCsv(f.getBlob().getDataAsString('UTF-8'));
    } catch (e) { console.warn('讀不到 ' + f.getName() + '：' + e); return; }
    added += importEstimateRows(rows);
    f.setTrashed(true); // 已登錄 → 移到垃圾桶（30 天內可救回）
  });
  if (added) console.log('法人預估登錄 ' + added + ' 筆');
}

function getEstimateSheet() {
  const it = rootFolder().getFilesByName(ESTIMATE_SHEET_NAME);
  while (it.hasNext()) {
    const f = it.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return SpreadsheetApp.openById(f.getId()).getSheets()[0];
  }
  const ss = SpreadsheetApp.create(ESTIMATE_SHEET_NAME);
  DriveApp.getFileById(ss.getId()).moveTo(rootFolder());
  const sh = ss.getSheets()[0];
  sh.appendRow(ESTIMATE_HEADERS);
  sh.setFrozenRows(1);
  return sh;
}

// 股號＋券商＋報告日期 相同就視為同一筆
function estimateKey(r) { return [normalizeCell(r[0], 0), String(r[2]).trim(), normalizeCell(r[3], 3)].join('|'); }

function normalizeCell(v, i) {
  if (v === null || v === undefined) return '';
  if ((i === 3 || i === 15) && v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  if (i === 0) return String(v).trim().replace(/\.0$/, '');
  return typeof v === 'string' ? v.trim() : v;
}

function fmtShort(d) { return d ? Utilities.formatDate(d, TZ, 'MM/dd HH:mm') : ''; }
function safeJsonArr(s) { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

// ===== LINE API =====
function downloadLineContent(messageId) {
  const res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + messageId + '/content', {
    headers: { Authorization: 'Bearer ' + prop('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('從 LINE 下載檔案失敗（HTTP ' + res.getResponseCode() + '），檔案可能已過期，請重新轉傳');
  return res.getBlob();
}

function reply(replyToken, messages) {
  const res = lineApi('https://api.line.me/v2/bot/message/reply', { replyToken: replyToken, messages: messages });
  if (res.getResponseCode() !== 200) push(messages, CUR_UID || undefined); // 回覆逾時就改用推播給同一個人
}

// 推播給管理者（或指定的人）
function push(messages, to) {
  to = to || prop('ALLOWED_USER_ID');
  if (to) lineApi('https://api.line.me/v2/bot/message/push', { to: to, messages: messages });
}

function pushTo(ids, messages) {
  const uniq = ids.filter(function (x, i) { return x && ids.indexOf(x) === i; });
  if (uniq.length === 1) return push(messages, uniq[0]);
  if (uniq.length > 1) lineApi('https://api.line.me/v2/bot/message/multicast', { to: uniq, messages: messages });
}

// 報告完成 → 所有成員
function pushAll(messages) { pushTo(getMembers().map(function (m) { return m.id; }), messages); }

// 抓取進度／失敗 → 要求這份報告的人（沒有紀錄就給管理者）
function pushJob(job, messages) { pushTo(job.requesters && job.requesters.length ? job.requesters : [prop('ALLOWED_USER_ID')], messages); }

function notify(ev, msg) {
  try {
    if (ev && ev.replyToken) reply(ev.replyToken, [text(msg)]); else push([text(msg)], CUR_UID || undefined);
  } catch (e) { console.error(e); }
}

function lineApi(url, payload) {
  return UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function text(t) { return { type: 'text', text: t.slice(0, 5000) }; }

// ===== 小工具 =====
function props() { return PropertiesService.getScriptProperties(); }
function prop(k, v) { if (v === undefined) return props().getProperty(k); props().setProperty(k, v); }
function rootFolder() { return DriveApp.getFolderById(prop('ROOT_FOLDER_ID') || DEFAULT_ROOT_FOLDER_ID); }
function getChildIfExists(parent, name) { const it = parent.getFoldersByName(name); return it.hasNext() ? it.next() : null; }
function getOrCreateChild(parent, name) {
  const f = getChildIfExists(parent, name);
  return f ? { folder: f, created: false } : { folder: parent.createFolder(name), created: true };
}
function md5(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function formatDate(d) { return Utilities.formatDate(d, TZ, 'yyyyMMdd'); }
function today() { return formatDate(new Date()); }
function now() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }
function safeJson(s) { try { return JSON.parse(s || '{}') || {}; } catch (e) { return {}; } }

// ===== 設定檢查：部署前先在編輯器執行一次（會跳出授權畫面） =====
function setupCheck() {
  const out = [];
  out.push('LINE_CHANNEL_ACCESS_TOKEN：' + (prop('LINE_CHANNEL_ACCESS_TOKEN') ? '已設定' : '❌ 未設定'));
  out.push('ALLOWED_USER_ID：' + (prop('ALLOWED_USER_ID') ? '已設定' : '未設定（部署後傳任一訊息給 bot 取得）'));
  out.push('根資料夾：' + rootFolder().getName());
  out.push('上傳紀錄：' + getLogSheet().getParent().getName());
  const map = getStockMap();
  out.push('股票清單：' + Object.keys(map).length + ' 檔（3167 → ' + (map['3167'] || '找不到') + '）');
  const test = analyzeFileName('633323964789424218_3167大量-法人展望研究-1.pdf', map, Date.now());
  out.push('檔名測試：' + (test.target ? buildFileName(test) : '需人工分類'));
  out.push('SCRAPE_KEY：' + (prop('SCRAPE_KEY') ? '已設定' : '❌ 未設定（請執行 setupTriggers）'));
  out.push('定時檢查：' + (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'checkReports'; }) ? '已建立' : '❌ 未建立（請執行 setupTriggers）'));
  out.push('工作清單：' + getJobSheet().getName());
  const lastPoll = Number(prop('LAST_POLL') || 0);
  out.push('抓取腳本最後回報：' + (lastPoll ? Utilities.formatDate(new Date(lastPoll), TZ, 'yyyy-MM-dd HH:mm:ss') : '從未'));
  console.log(out.join('\n'));
}

// ===== v1.1 安裝：產生竄改猴金鑰＋建立每 10 分鐘的報告檢查（只要執行一次） =====
function setupTriggers() {
  if (!prop('SCRAPE_KEY')) prop('SCRAPE_KEY', Utilities.getUuid().replace(/-/g, ''));
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkReports') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkReports').timeBased().everyMinutes(10).create();
  getJobSheet();
  console.log('完成。\n竄改猴腳本的 KEY 請填：' + prop('SCRAPE_KEY') + '\n（這串等同密碼，不要公開）');
}


// ===== 備用解壓縮（v1.5.2）：Utilities.unzip 失敗時自己解析 ZIP =====
function manualUnzip(blob) {
  const b = blob.getBytes();
  const n = b.length;
  const u8 = function (i) { return b[i] & 255; };
  const u16 = function (i) { return u8(i) | (u8(i + 1) << 8); };
  const u32 = function (i) { return (u8(i) | (u8(i + 1) << 8) | (u8(i + 2) << 16)) + u8(i + 3) * 16777216; };
  const slice = function (a, z) { return Array.prototype.slice.call(b, a, z); };
  if (n < 22 || u8(0) !== 0x50 || u8(1) !== 0x4b) throw new Error(zipSignatureText(b));
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 65557); i--) { if (u32(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('檔案不完整（可能傳送中斷，請重傳一次）');
  let count = u16(eocd + 10), cdOff = u32(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) {           // ZIP64
    const loc = eocd - 20;
    if (loc >= 0 && u32(loc) === 0x07064b50) {
      const z = u32(loc + 8);
      if (u32(z) === 0x06064b50) { count = u32(z + 32); cdOff = u32(z + 48); }
    }
  }
  const out = [];
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (u32(p) !== 0x02014b50) break;
    const flag = u16(p + 8), method = u16(p + 10);
    const crc = slice(p + 16, p + 20);
    let csize = u32(p + 20), usize = u32(p + 24);
    const nl = u16(p + 28), xl = u16(p + 30), cl = u16(p + 32);
    let lho = u32(p + 42);
    const nameBytes = slice(p + 46, p + 46 + nl);
    let x = p + 46 + nl; const xe = x + xl;
    while (x + 4 <= xe) {                                  // ZIP64 額外欄位
      const id = u16(x), sz = u16(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = u32(q); q += 8; }
        if (csize === 0xffffffff) { csize = u32(q); q += 8; }
        if (lho === 0xffffffff) { lho = u32(q); }
      }
      x += 4 + sz;
    }
    p = xe + cl;
    const name = decodeZipName(nameBytes, flag);
    if (/\/$/.test(name)) continue;
    if (flag & 1) throw new Error('壓縮檔有密碼，請先解開再傳');
    const start = lho + 30 + u16(lho + 26) + u16(lho + 28);
    const data = slice(start, start + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) {
      const sb = function (v) { v = v & 255; return v > 127 ? v - 256 : v; };
      const head = [0x1f, -117, 8, 0, 0, 0, 0, 0, 0, -1];
      const tail = crc.concat([sb(usize), sb(usize >> 8), sb(usize >> 16), sb(usize >>> 24)]);
      bytes = Utilities.ungzip(Utilities.newBlob(head.concat(data, tail), 'application/x-gzip')).getBytes();
    } else throw new Error('壓縮方式不支援（代號 ' + method + '），請改用 Windows 內建或一般 ZIP 格式重新壓縮');
    out.push(Utilities.newBlob(bytes, null, name));
  }
  if (!out.length) throw new Error('壓縮檔裡沒有檔案');
  return out;
}

// 檔名編碼：有 UTF-8 標記就用 UTF-8；否則先試 UTF-8，亂碼再改用 Big5（台灣 Windows 壓縮的中文檔名）
function decodeZipName(bytes, flag) {
  const utf = Utilities.newBlob(bytes).getDataAsString('UTF-8');
  if ((flag & 0x800) || utf.indexOf('\uFFFD') < 0) return utf;
  try { return Utilities.newBlob(bytes).getDataAsString('Big5'); } catch (e) { return utf; }
}

// 不是 ZIP 時，判斷它其實是什麼
function zipSignatureText(b) {
  const h = Array.prototype.slice.call(b, 0, 6).map(function (v) { return v & 255; });
  if (h[0] === 0x37 && h[1] === 0x7a && h[2] === 0xbc && h[3] === 0xaf) return '這其實是 7z 檔（只是副檔名是 .zip），請改用 ZIP 格式重新壓縮';
  if (h[0] === 0x52 && h[1] === 0x61 && h[2] === 0x72 && h[3] === 0x21) return '這其實是 RAR 檔，請改用 ZIP 格式重新壓縮';
  if (h[0] === 0x7b || h[0] === 0x3c) return '檔案下載失敗（LINE 可能已過期），請重新傳一次';
  return '不是 ZIP 檔或檔案已損壞';
}


// ===== v1.6 SEPA 選股系統串接 =====
const SCREENER_SITE = 'https://k6107055.github.io/stock-screener/';

function fetchJson(url) {
  const r = UrlFetchApp.fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  try { return JSON.parse(r.getContentText('UTF-8')); } catch (e) { return null; }
}

// 把選股系統當天的結果寫成 Markdown（給報告用）
function screenerTechMarkdown(code) {
  const d = fetchJson(SCREENER_SITE + 'data/latest.json');
  if (!d) return '';
  const s = (d.stocks || []).filter(function (x) { return x.id === code; })[0];
  const m = d.market || {};
  const yn = function (b) { return b ? '✔' : '✘'; };
  const v = function (x, suf) { return x === null || x === undefined ? '-' : x + (suf || ''); };
  const L = ['# 選股系統技術面（SEPA 趨勢模板＋VCP）', '資料日期：' + d.date + '｜來源：' + SCREENER_SITE,
    '大盤：加權指數 ' + v(m.close) + '，' + (m.above50 && m.above200 ? '在 50、200 日線之上（多頭，可進場）' : '跌破 ' + (!m.above50 ? '50 日線 ' : '') + (!m.above200 ? '200 日線' : '') + '（轉弱，暫停新進場）'), ''];
  if (!s) {
    L.push('## ' + code + '：今天沒有通過趨勢模板 8 條（不在選股名單上）',
      '代表股價目前不在《超級績效》定義的第二階段上升趨勢（可能在整理、跌破長期均線或 RS 不足）。');
  } else {
    const r = s.rules || {};
    L.push('## ' + code + ' ' + s.name + '：通過趨勢模板 8 條' + (s.new ? '（新上榜）' : ''),
      '- 收盤 ' + v(s.close) + '｜RS ' + v(s.rs) + '（全市場百分位）｜20 日漲幅 ' + v(s.ret20, '%') + '｜離 50 日線 ' + v(s.ext50, '%') + '｜離一年高點 ' + v(s.dist_hi, '%'),
      '- VCP 評分 ' + s.score + '/4：' + yn(r.r1) + '不追高 ' + yn(r.r2) + '近突破點 ' + yn(r.r3) + '波動收斂（' + v(s.r3, '%') + '→' + v(s.r2, '%') + '→' + v(s.r1, '%') + '） ' + yn(r.r4) + '量縮（量比 ' + v(s.dry) + '）',
      '- 今日突破：' + (s.breakout ? '是（量 ' + v(s.vol_ratio) + ' 倍）' : '否'),
      '- 買點 ' + v(s.entry) + '｜停損 ' + v(s.stop) + '｜風險 ' + v(s.risk, '%') + (s.risk_ok ? '' : '（超過 8%，依規則不做）'),
      '- 產業 ' + (s.industry || '-') + '：族群排名 ' + v(s.ind_rank) + '，產業平均 RS ' + v(s.ind_rs) + '，今天同產業上榜 ' + v(s.ind_n) + ' 檔' + (s.ind_hot ? '（主流族群）' : ''));
    const f = s.fund;
    if (f && (f.has_q || f.has_m)) {
      L.push('', '## 選股系統的基本面評分（FinMind 公開資料）',
        '- 書中基本面 ' + f.fscore + '/3：' + yn(f.f.f1) + '季EPS年增≥25%（' + v(f.eps_yoy, '%') + '） ' + yn(f.f.f2) + 'EPS加速 ' + yn(f.f.f3) + '營收年增≥20%＋利潤率擴張（營收年增 ' + v(f.rev_q_yoy, '%') + '）｜季報 ' + v(f.q_last),
        '- 循環分 ' + f.cscore + '/3：' + yn(f.c.c1) + '月營收加速（最新年增 ' + v(f.mrev_yoy, '%') + '） ' + yn(f.c.c2) + '毛利率翻揚（' + v(f.gm, '%') + '） ' + yn(f.c.c3) + '營收創24月新高｜月營收 ' + v(f.m_last),
        '- 資本支出年增 ' + v(f.capex_yoy, '%') + (f.tags && f.tags.length ? '｜標籤：' + f.tags.join('、') : ''),
        '- 超額利潤型態（' + v(f.q_last) + '）：' + (f.pv || '季營收年增未達 10%，不判斷') + '｜季營收年增 ' + v(f.rev_q_yoy, '%') + '｜毛利率年比 ' + v(f.gm_yoy_pp, ' 個百分點') + '、季比 ' + v(f.gm_qoq_pp, ' 個百分點'));
    }
  }
  const hot = (d.industries || []).filter(function (x) { return x.hot; }).map(function (x) { return x.industry + '（RS ' + x.avg_rs + '）'; });
  if (hot.length) L.push('', '今日主流族群：' + hot.join('、'));
  return L.join('\n');
}

// 股票資料夾裡維持一份「{股號}_選股系統技術面（自動更新）」文件
function refreshScreenerDoc(code, name, folder) {
  const md = screenerTechMarkdown(code);
  if (!md) return null;
  const title = code + '_選股系統技術面（自動更新）';
  const it = folder.getFilesByName(title);
  let doc;
  if (it.hasNext()) doc = DocumentApp.openById(it.next().getId());
  else {
    doc = DocumentApp.create(title);
    DriveApp.getFileById(doc.getId()).moveTo(folder);
  }
  doc.getBody().setText(md);
  doc.saveAndClose();
  return DriveApp.getFileById(doc.getId());
}

// 選股系統每天跑完呼叫：推播給所有成員＋訊號股自動排入報告
function screenerPush(p, body) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  if (!body || !body.date) return { ok: false, error: 'no data' };
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (prop('SCREENER_LAST') === body.date) return { ok: true, skipped: '這個資料日已經推播過' };
    prop('SCREENER_LAST', body.date);
  } finally { lock.releaseLock(); }

  const queued = [], reused = [];
  (body.auto_report || []).slice(0, 3).forEach(function (code) {
    try {
      if (prop('AUTO_REPORT_OFF') === '1') return;   // v2.10 傳「自動報告 關」可關閉
      const msg = requestReport(code, '', false, AUTO_NOTE);
      if (/^📥/.test(msg.text)) queued.push(code);
      else if (/^📑/.test(msg.text)) reused.push(code);
    } catch (e) { console.warn('自動報告失敗 ' + code + '：' + e); }
  });

  const tagStr = function (s) {
    const t = [];
    if (s.fscore !== null && s.fscore !== undefined) t.push('基本面' + s.fscore + '・循環' + s.cscore);
    if (s.tags && s.tags.length) t.push(s.tags.join('、'));
    if (s.warn && s.warn.length) t.push('⚠️' + s.warn.join('、'));
    return t.length ? '\n　' + t.join('｜') : '';
  };
  const md = body.date.slice(5).replace('-', '/');
  const L = ['📈 SEPA 選股 ' + md + '｜' + (body.mkt_ok ? '大盤多頭 ✅' : '大盤轉弱 ⚠️ 暫停新進場'), '趨勢模板過關 ' + body.total + ' 檔'];
  const sig = body.signals || [];
  if (sig.length) {
    L.push('', '🔔 今日買進訊號 ' + sig.length + ' 檔');
    sig.forEach(function (s) {
      L.push('・' + s.id + ' ' + s.name + '｜買點 ' + s.entry + ' 停損 ' + s.stop + '（風險 ' + s.risk + '%）｜RS ' + s.rs + tagStr(s));
    });
  } else if (body.mkt_ok) {
    L.push('', '🔔 今天沒有買進訊號');
  }
  const ready = body.ready || [];
  if (ready.length) {
    L.push('', '🟡 準備區（盤中突破可買）');
    ready.forEach(function (s) {
      L.push('・' + s.id + ' ' + s.name + (s.prefer ? '⭐' : '') + '｜突破價 ' + s.pivot + '、量 > ' + (s.bo_lots || '-') + ' 張｜停損 ' + s.stop);
    });
  }
  const watch = body.watch || [];
  if (watch.length) {
    L.push('', '👀 新上榜高分股');
    watch.forEach(function (s) { L.push('・' + s.id + ' ' + s.name + '｜評分 ' + s.score + '/4｜RS ' + s.rs + tagStr(s)); });
  }
  if ((body.hot || []).length) L.push('', '🔥 主流族群：' + body.hot.map(function (x) { return x.industry + '（RS ' + x.avg_rs + '）'; }).join('、'));
  if (queued.length) L.push('', '📄 已自動排入整合報告：' + queued.join('、') + '（完成後會再推播）');
  if (reused.length) L.push('', '📑 ' + reused.join('、') + ' 3 天內已有報告，沒有重做（傳「報告 股號」可看連結）');
  L.push('', '🌐 全部名單：' + (body.site || SCREENER_SITE));

  const msg = text(L.join('\n'));
  const qr = sig.concat(watch).filter(function (s) { return queued.indexOf(s.id) < 0; }).slice(0, 13);
  if (qr.length) msg.quickReply = { items: qr.map(function (s) {
    return { type: 'action', action: { type: 'message', label: ('📄 ' + s.id + ' ' + s.name).slice(0, 20), text: '報告 ' + s.id } };
  }) };
  if (eveningPending()) prop('EVE_SCREENER', JSON.stringify({ day: today(), msg: msg }));   // v1.9 併進 21:00 晚間總整理
  else pushAll([msg]);
  try { applyHoldingChecks(body.holdings || [], body.date); } catch (e) { console.warn('持股檢查失敗：' + e); }
  return { ok: true, queued: queued, reused: reused };
}


// ===== v1.6.1 產業子資料夾 =====
// 看不出股票，或只知道是產業但不知道哪個產業 → 先放待分類再問
function needsAsk(target) { return !target || (target.type === 'industry' && !target.sub); }
function cleanIndustry(s) {
  return String(s || '').replace(/[\\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/(產業|行業)$/, '').trim().slice(0, 20);
}

function listIndustries() {
  const top = getChildIfExists(rootFolder(), INDUSTRY_FOLDER);
  if (!top) return [];
  const out = [];
  const it = top.getFolders();
  while (it.hasNext()) { const f = it.next(); out.push({ name: f.getName(), count: countFiles(f), updated: f.getLastUpdated().getTime() }); }
  return out.sort(function (a, b) { return b.updated - a.updated; });   // 最近用過的排前面
}

function industryListText() {
  const list = listIndustries();
  if (!list.length) return '還沒有產業資料夾。傳產業報告給我時會問你是哪個產業，或先傳「產業 名稱」（例如：產業 記憶體）。';
  return '產業資料夾：\n' + list.map(function (x) { return '・' + x.name + '（' + x.count + ' 份）'; }).join('\n') +
    '\n\n先傳「產業 名稱」，接下來 5 分鐘內傳的檔案都會歸到那個產業。';
}

// 問「是哪個產業？」：最近用過的產業按鈕＋輸入新產業＋先放著
function askIndustry(token, label) {
  const items = listIndustries().slice(0, 11).map(function (x) {
    return { type: 'action', action: { type: 'postback', label: x.name.slice(0, 20), data: 'ind|' + token + '|' + x.name, displayText: '產業 ' + x.name } };
  });
  items.push({ type: 'action', action: { type: 'postback', label: '✏️ 輸入新產業', data: 'ind|' + token + '|NEW', displayText: '輸入新產業' } });
  items.push({ type: 'action', action: { type: 'postback', label: '先放著', data: 'ind|' + token + '|LATER', displayText: '先放著' } });
  const what = label ? '「' + label + '」' : '這份資料';
  return { type: 'text', text: '🏭 ' + what + '是哪個產業？\n點下面的產業，或按「✏️ 輸入新產業」，也可以直接打「產業 名稱」（例如：產業 記憶體）。', quickReply: { items: items } };
}


// ===== v1.7 產業整合報告 =====
const IND_CODE_PREFIX = '產業_';
function isIndCode(code) { return String(code || '').indexOf(IND_CODE_PREFIX) === 0; }
function jobLabel(j) { return isIndCode(j.code) ? '🏭 產業｜' + j.name : j.code + ' ' + j.name; }
function jobFolder(code, name) {
  if (isIndCode(code)) return targetFolder({ type: 'industry', sub: name || String(code).slice(IND_CODE_PREFIX.length) }).folder;
  return getStockFolder(code, name).folder;
}

function withIndReportButton(msg, name) {
  if (!/^✅/.test(msg.text) || !name) return msg;
  msg.quickReply = { items: [{ type: 'action', action: { type: 'postback', label: ('更新 ' + name + ' 產業報告').slice(0, 20),
    data: 'rpt|產業_' + cleanIndustry(name), displayText: '報告 產業 ' + cleanIndustry(name) } }] };
  return msg;
}

function industryPickMsg() {
  const list = listIndustries().filter(function (x) { return x.count > 0; });
  if (!list.length) return text('還沒有產業資料夾。先把產業報告傳給我（會問你是哪個產業），再傳「報告 產業 名稱」。');
  const msg = text('要哪個產業的整合報告？點下面的產業，或輸入「報告 產業 名稱」。');
  msg.quickReply = { items: list.slice(0, 13).map(function (x) {
    return { type: 'action', action: { type: 'postback', label: (x.name + '（' + x.count + '）').slice(0, 20), data: 'rpt|產業_' + x.name, displayText: '報告 產業 ' + x.name } };
  }) };
  return msg;
}

// 上次報告之後，這個產業資料夾有沒有新歸檔的檔案（看上傳紀錄的分類欄）
function hasNewIndustryFileSince(name, since) {
  const label = INDUSTRY_FOLDER + '／' + name;
  const v = getLogSheet().getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    const t = toDate(v[i][0]);
    if (!t || t.getTime() <= since.getTime()) break;
    if (String(v[i][3]) === label && v[i][7] === '已歸檔') return true;
  }
  return false;
}

function requestIndustryReport(rawName, uid, force) {
  const name = cleanIndustry(rawName);
  if (!name) return industryPickMsg();
  const top = getChildIfExists(rootFolder(), INDUSTRY_FOLDER);
  const folder = top ? getChildIfExists(top, name) : null;
  if (!folder || countFiles(folder) === 0) {
    const m = industryPickMsg();
    m.text = '找不到「' + name + '」產業的資料。' + (listIndustries().length ? '\n' + m.text : '\n先把這個產業的報告傳給我，選產業「' + name + '」，再要報告。');
    return m;
  }
  const code = IND_CODE_PREFIX + name;
  uid = uid || prop('ALLOWED_USER_ID');
  const lock = LockService.getScriptLock();
  lock.waitLock(LONG_LOCK_MS);
  try {
    const sh = getJobSheet();
    const rows = jobRows(sh).filter(function (j) { return j.code === code; });
    const active = rows.filter(function (j) { return ACTIVE_STATUSES.indexOf(j.status) >= 0; })[0];
    if (active) {
      if (active.requesters.indexOf(uid) < 0) setJob(sh, active.row, { requesters: active.requesters.concat([uid]).join(',') });
      return text('⏳ 「' + name + '」產業報告已經在處理中，完成後會一起通知你。');
    }
    if (!force) {
      const done = rows.filter(function (j) { return j.status === '完成' && j.reportUrl; }).pop();
      if (done && done.updated && Date.now() - done.updated.getTime() < REUSE_REPORT_DAYS * 86400000 && !hasNewIndustryFileSince(name, done.updated)) {
        const msg = text('📑 「' + name + '」產業報告在 ' + fmtShort(done.updated) + ' 做過，之後沒有新資料：\n' +
          (done.summary ? done.summary + '\n' : '') + '\n📑 產業整合報告：\n' + done.reportUrl + '\n\n真的要重新產生，按下面「🔄 強制更新」。');
        msg.quickReply = { items: [{ type: 'action', action: { type: 'postback', label: '🔄 強制更新', data: 'rpt|' + code + '|force', displayText: '強制更新 產業 ' + name } }] };
        return msg;
      }
    }
    const id = 'J' + Utilities.formatDate(new Date(), TZ, 'yyyyMMddHHmmss');
    // 產業報告不用抓優分析小助理，直接進「已抓取」等 Claude 寫
    sh.appendRow([id, now(), code, name, '已抓取', '', '', '', now(), force ? '強制更新' : '產業報告', uid]);
    prop('ACTIVE_JOBS', '1');
  } finally {
    lock.releaseLock();
  }
  return text('📥 已排入產業整合報告：' + name + '（' + countFiles(folder) + ' 份資料）\n' +
    'Claude 會整理：最新進度、改變了什麼、未來發展方向、需要關注的指標。\n常開電腦約 10～20 分鐘；電腦離線時雲端排程一小時內補上。完成後推播給所有成員。');
}

const INDUSTRY_RULES = [
  '# 產業整合報告撰寫規則',
  '全程使用繁體中文。你是使用者的產業研究助理。這份是「產業」報告，不是個股報告；資料是同一產業的券商／研究機構報告、新聞、截圖等。',
  '使用者最想知道四件事：① 產業現在的最新進度 ② 到底改變了什麼 ③ 未來發展方向 ④ 接下來要關注什麼。',
  '使用者用「循環週期」框架判斷產業：①訂單回溫 ②滿載缺貨 ③漲價（超額利潤期，股價漲最快）④宣布擴產 ⑤量增、折舊壓毛利 ⑥同業產能開出＝準備出場。',
  '',
  '## 判斷版本',
  '- files/ 沒有「過去整合報告」→ 寫「首次全面版」；有 → 寫「追蹤版」，要跟最近一份過去產業報告比較。',
  '',
  '## 查證原則（最重要）',
  '- 每個數字都要能在 files/ 原文找到，註明來源與報告日期，禁止憑記憶補數字。',
  '- 報告之間數字或看法衝突時，並列並說明差異（誰、何時、為什麼），不要自行平均掉。',
  '- 超過 3 個月的資料標「資料偏舊」；以最新日期的資料代表「現況」。',
  '- 來源分級：券商／研究機構原文＞新聞＞二手整理；檔名或內容標「AI整理」的只能當線索。',
  '- 圖片／截圖要直接看圖讀數字；.csv 是 Excel 轉出；檔名含「網頁_」是網頁存檔。',
  '- files/我的筆記.md 是使用者自己用 LINE 記下的產業筆記：代表使用者的觀察與疑問，報告要回應裡面的疑問與論點；裡面的數字找不到原文佐證就列入查證提醒。',
  '- 若你有網路搜尋工具，可以補最新且可查證的公開資料（報價、廠商擴產、法說會），每筆附網址與日期，來源標「網路」；沒有就只用 files。',
  '',
  '## 閱讀設計（最重要：讓使用者 1 分鐘看懂）',
  '- 第一屏就是「⚡ 產業決策卡」，後面各段只放證據，不重複決策卡已寫過的句子；每段開頭一句粗體結論（20 字內），能用表格就不要長段落。',
  '- 同一個數字全文只詳細出現一次；沒有新資訊的段落寫「本期無變化」。首次版約 3000～4000 字，追蹤版約 1500～2000 字。',
  '- 資料不夠的問題，決策卡寫「資料不足：缺〇〇」，不要硬給結論。',
  '',
  '## 首次全面版，依序：',
  '⚡ 產業決策卡（表格：問題｜結論｜信心 高／中／低｜關鍵佐證：1 個數字＋來源日期）。七列固定：',
  '  ① 產業階段：價漲期／量增期／趨緩期／下行期（對應六階段：③漲價＝價漲期、④⑤＝量增期、⑥＝趨緩期、之後＝下行期）。',
  '  ② 這波獲利主要來自：漲價／稼動率／產品升級（高階規格滲透）／出貨量。',
  '  ③ 新產能開出後劇本：價量齊揚／ASP 持平小漲、量接棒／量增價跌，增幅最大的時間點。',
  '  ④ 誰掌控新增有效供給（前幾大廠商、擴產紀律、新進者門檻）＋客戶換供應商難易。',
  '  ⑤ 本輪上行原因與上一輪不同處：強度 更強／相當／較弱，何時轉強。',
  '  ⑥ 產業轉折點：預估落在哪一季（方向要寫清楚）。',
  '  ⑦ 最值得研究的公司：1～3 家（股號），一句話理由（優先：產品組合升級型、掌控有效供給者、下一棒將出貨者）。',
  '  ⑧ 輪動位置：這條供應鏈目前正在出貨的是哪一棒、下一棒是誰、預估何時輪到；近期有哪些公司同步被上修（需求端或供給端）。',
  '  決策卡下方一行「📅 下一個驗證點：事件＋日期」。',
  '',
  '一、本期重點（最多 3 點）',
  '一之一、供應鏈輪動表（依「產業輪動判斷框架」）：第幾棒｜環節｜代表公司（股號）｜狀態：已出貨／準備中／尚未｜預估受惠時間｜證據。標出「目前出貨」與「下一棒」。',
  '二、產業最新進度：表格六列固定：需求｜ASP／報價｜庫存｜訂單｜稼動率｜新增產能（廠商｜Brownfield／Greenfield｜規模｜量產時間）；欄位：指標｜最新狀況｜趨勢 ↑→↓｜來源日期。再加技術／規格演進、主要廠商動態各 1～3 點。',
  '三、改變了什麼：依資料日期由舊到新，🆕新出現的趨勢、🔄數字或看法改變（舊→新，註明日期與來源）、❌不再被提起的舊論點。這一段是重點，要具體。',
  '四、景氣劇本（依「超額利潤期判斷框架」）：價漲型態（①原地漲價＋稼動率／②產品組合升級）、供需缺口擴大或縮小、資本支出上修是正面還是反動力、新產能開出後劇本與時間；本輪 vs 上一輪循環比較表（驅動力、需求來源、供給紀律、價格漲幅、持續時間）。',
  '五、未來發展方向：短期（1～2 季）與中長期（1～3 年）分開；各機構一致處與分歧處；有預估數字的做共識區間（最高／最低／中位數，只有一家就註明）。',
  '六、受惠與受害公司：表格（公司｜股號｜角色｜受惠或受害原因｜超額利潤型態：產品升級／只靠漲價／量增｜提到的機構）。使用者已追蹤的股票標「★追蹤中」（清單在本規則最後）。',
  '七、需要關注的東西（追蹤清單約 8 項：指標／事件｜目前數值｜轉好／轉壞的門檻｜下次觀察時間）。必須包含供給面指標（新產能開出、同業擴產、價格是否鬆動），不能只放需求面。最後列 3 個最大風險。',
  '附錄：查證提醒、資料清單（檔名、來源、日期）。',
  '',
  '## 追蹤版（第二次以後），依序：',
  '⚡ 產業決策卡：同首次版七列，多一欄「與上版比」（↑／↓／＝，變了寫舊→新）；任何一列結論改變，標題標「⚠️ 結論改變」並寫進摘要。',
  '一、本期重點（只講這段期間的變化）',
  '二、改變了什麼（與上一份產業報告比）：🆕新增、🔄改變（舊→新）、❌消失。',
  '三、決策卡有變化的列才展開證據，沒變的寫「同上版」。',
  '四、關注清單檢查：上一版追蹤清單逐條標 ✅符合預期／⚠️待觀察／❌不如預期，再產出新清單。',
  '五、受惠與受害公司的變化、風險變化。附錄：查證提醒、資料清單。',
  '',
  '## HTML 格式',
  '- 完整 HTML 文件（<html><head><meta charset="utf-8"></head><body>…</body></html>）。',
  '- 第一行 <h1>產業｜{產業名稱}｜產業整合報告（首次全面版／追蹤版）</h1>。',
  '- 第二段必須是單獨一個 <p>，以「摘要：」開頭，100 字以內，給 LINE 推播用，格式：「〔產業階段〕〔劇本〕＋最大的改變＋下一個驗證點」。',
  '- 第三段：報告日期、版本、資料範圍（最舊～最新資料日期、共幾份）、「僅供研究參考，不構成投資建議」。',
  '- 第四段顏色圖例：<span style="color:#d93025;font-weight:bold">紅字＝偏正面</span>、<span style="color:#188038;font-weight:bold">綠字＝偏風險／需留意</span>、<b>粗體＝關鍵數字</b>。',
  '- 全文照優分析方式上色：偏正面用 <span style="color:#d93025;font-weight:bold">，偏風險用 <span style="color:#188038;font-weight:bold">，關鍵數字用 <b>。',
  '- 表格用 <table border="1" cellpadding="4" cellspacing="0">。不要用 CSS class 或 <style>，只用行內 style。',
  '',
  EXCESS_PROFIT_RULES,
  '',
  ROTATION_RULES,
].join('\n');

const INDUSTRY_ESTIMATE_RULES = [
  '## 法人預估 CSV（estimates.csv）',
  '產業報告裡如果有券商對「個別公司」的 EPS、目標價、評等預估，每家公司每份報告寫一列（沒有就只寫標題列）。第一列是標題，欄位與順序固定：',
  ESTIMATE_HEADERS.join(','),
  '股號必須是台股代號（查不到代號的外國公司不要寫）；報告日期用 yyyy-MM-dd；資料等級填「原文」或「二手」；沒有的欄位留空；欄位內不要有逗號。',
].join('\n');

function buildIndustryPack(code, name) {
  name = name || String(code).slice(IND_CODE_PREFIX.length);
  const folder = jobFolder(code, name);
  const files = [];
  const reports = [], pdfs = [], images = [], others = [], sheets = [], slides = [];
  let memoDoc = null;
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const n = f.getName();
    const mt = f.getMimeType();
    if (/_舊版|_Gemini測試報告_/.test(n)) continue;
    if (n.indexOf(MEMO_SUFFIX) >= 0 && mt === MimeType.GOOGLE_DOCS) { memoDoc = f; continue; }
    if (mt === MimeType.PDF) pdfs.push(f);
    else if (/^image\//.test(mt) && !/heic|heif/.test(mt)) images.push(f);
    else if (mt === MimeType.GOOGLE_DOCS && n.indexOf(code + REPORT_TITLE) === 0) reports.push(f);
    else if (mt === MimeType.GOOGLE_DOCS) others.push(f);
    else if (mt === MimeType.GOOGLE_SHEETS) sheets.push(f);
    else if (mt === MimeType.GOOGLE_SLIDES) slides.push(f);
  }
  const byNew = function (a, b) { return b.getDateCreated() - a.getDateCreated(); };
  [reports, pdfs, images, others, sheets, slides].forEach(function (a) { a.sort(byNew); });
  const clean = function (n) { return n.replace(/[\\\/:*?"<>|]/g, '_'); };
  if (memoDoc) files.push({ id: memoDoc.getId(), name: '我的筆記.md', kind: 'doc' });
  reports.slice(0, 1).forEach(function (f) { files.push({ id: f.getId(), name: '過去整合報告_' + clean(f.getName()) + '.md', kind: 'doc' }); });
  pdfs.slice(0, 20).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()), kind: 'pdf', size: f.getSize() }); });
  others.slice(0, 15).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()) + '.md', kind: 'doc' }); });
  sheets.slice(0, 6).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()) + '.csv', kind: 'sheet' }); });
  slides.slice(0, 6).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()) + '.pdf', kind: 'slides' }); });
  images.slice(0, 15).forEach(function (f) { files.push({ id: f.getId(), name: clean(f.getName()), kind: 'image' }); });
  const tracked = listStockFolders().map(function (f) { return f.name; });
  const rules = INDUSTRY_RULES + '\n\n## 使用者追蹤中的股票（★追蹤中）\n' + (tracked.length ? tracked.join('、') : '（無）') +
    '\n\n產業名稱：' + name + '；資料夾內共 ' + (pdfs.length + others.length + sheets.length + slides.length + images.length) + ' 份資料，本次提供 ' + files.length + ' 份（越新的越優先）。';
  return { code: code, name: name, folderId: folder.getId(), today: today(), files: files,
    history: '', rules: rules, estimateRules: INDUSTRY_ESTIMATE_RULES, hasPrevious: reports.length > 0, industry: true };
}


// ===== v1.7.1 待分類：併組、逐一處理、每晚提醒 =====
const LONG_LOCK_MS = 240000;          // 同時傳很多檔時最多排隊 4 分鐘
const GROUP_WINDOW_MS = 3 * 60000;    // 3 分鐘內接著傳的待分類併成一組
const PEND_REMIND_HOUR = 20;          // 每晚 8 點提醒還有待分類

// 把這次的待分類加進「目前開著的一組」（3 分鐘內），沒有就開新的一組
function joinPendingGroup(ids, allInd) {
  const openKey = 'PGROUP_OPEN_' + CUR_UID;
  const open = safeJson(prop(openKey));
  let gid, list, ind;
  if (open.gid && Date.now() - open.ts < GROUP_WINDOW_MS && prop('PGROUP_' + open.gid)) {
    gid = open.gid;
    list = safeJsonArr(prop('PGROUP_' + gid)).concat(ids);
    ind = prop('PGIND_' + gid) === '1' && allInd;
  } else {
    gid = 'G' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    list = ids.slice();
    ind = allInd;
  }
  prop('PGROUP_' + gid, JSON.stringify(list));
  prop('PGIND_' + gid, ind ? '1' : '0');
  prop(openKey, JSON.stringify({ gid: gid, ts: Date.now() }));
  prop(pendKey(), gid);
  return { gid: gid, count: list.length, allInd: ind };
}

// 依這一組的性質問「哪一檔股票」或「哪個產業」（每次都附按鈕，按鈕只會出現在最新一則訊息）
function askGroup(g, label, cands, map) {
  const lab = g.count > 1 ? g.count + ' 份檔案（這次：' + label + '）' : label;
  const msg = g.allInd ? askIndustry(g.gid, lab) : askClassify(g.gid, lab, cands, map);
  if (g.count > 1) {   // v1.7.2 一批裡混了不同股票／產業 → 可以改成逐一分類
    const items = msg.quickReply.items;
    const later = items.pop();                 // 先拿掉「先放著」，放回最後
    items.splice(11);
    items.push({ type: 'action', action: { type: 'postback', label: '📋 不一樣，逐一分類', data: 'pend|next', displayText: '逐一分類' } });
    items.push(later);
    msg.text += '\n\n👉 這 ' + g.count + ' 份是同一檔／同一產業：直接點按鈕，一次歸檔\n👉 混了不同的：按「📋 不一樣，逐一分類」';
  }
  return msg;
}

function listPendingFiles() {
  const p = getChildIfExists(rootFolder(), PENDING_FOLDER);
  const out = [];
  if (!p) return out;
  const it = p.getFiles();
  while (it.hasNext()) out.push(it.next());
  return out.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });   // 舊的先
}

function pendingLabel(f) {
  const meta = safeJson(f.getDescription());
  return meta.orig || f.getName();
}

// 「待分類」：列出全部，可以一次全部歸到同一處，或逐一分類
function pendingOverview() {
  const files = listPendingFiles();
  if (!files.length) return text('👍 沒有待分類的檔案。');
  const lines = files.slice(0, 20).map(function (f, i) { return (i + 1) + '. ' + pendingLabel(f).slice(0, 40) + '（' + fmtShort(f.getDateCreated()) + '）'; });
  if (files.length > 20) lines.push('…還有 ' + (files.length - 20) + ' 份');
  const gid = 'G' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  prop('PGROUP_' + gid, JSON.stringify(files.map(function (f) { return f.getId(); })));
  prop('PGIND_' + gid, '0');
  prop(pendKey(), gid);
  const msg = askClassify(gid, '全部 ' + files.length + ' 份', [], getStockMap());
  msg.text = '🗂 待分類 ' + files.length + ' 份：\n' + lines.join('\n') +
    '\n\n👉 都是同一檔／同一產業：直接點下面的按鈕，全部一次歸檔\n👉 不一樣：按「📋 逐一分類」，一份一份問你';
  const items = msg.quickReply.items.filter(function (x) { return x.action.label !== '先放著'; });
  items.splice(12);
  items.push({ type: 'action', action: { type: 'postback', label: '📋 逐一分類', data: 'pend|next', displayText: '逐一分類' } });
  msg.quickReply.items = items;
  return msg;
}

// 逐一分類：拿最舊的一份來問
function nextPendingMsg() {
  const files = listPendingFiles();
  if (!files.length) return text('👍 待分類都處理完了。');
  const f = files[0];
  const name = pendingLabel(f);
  prop(pendKey(), f.getId());
  const map = getStockMap();
  const info = analyzeFileName(name, map, f.getDateCreated().getTime());
  const head = '（剩 ' + files.length + ' 份）';
  const msg = (info.target && info.target.type === 'industry') ? askIndustry(f.getId(), name) : askClassify(f.getId(), name, info.candidates, map);
  msg.text = head + msg.text;
  return msg;
}

// 歸檔完如果還有待分類，附一顆「下一份」按鈕
function withNextPending(msg) {
  let n = 0;
  try { n = listPendingFiles().length; } catch (e) { return msg; }
  if (!n) return msg;
  msg.text += '\n\n🗂 還有 ' + n + ' 份待分類';
  const items = (msg.quickReply && msg.quickReply.items) || [];
  items.push({ type: 'action', action: { type: 'postback', label: '🗂 下一份（' + n + '）', data: 'pend|next', displayText: '下一份待分類' } });
  items.push({ type: 'action', action: { type: 'message', label: '全部列出', text: '待分類' } });
  msg.quickReply = { items: items.slice(0, 13) };
  return msg;
}

// 每晚 8 點，如果還有待分類，提醒所有成員一次
function pendingReminder() {
  const h = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  if (h !== PEND_REMIND_HOUR || prop('PEND_REMIND_DATE') === today()) return;
  prop('PEND_REMIND_DATE', today());
  const files = listPendingFiles();
  if (!files.length) return;
  const msg = text('🗂 提醒：還有 ' + files.length + ' 份檔案待分類（最舊的是 ' + fmtShort(files[0].getDateCreated()) + ' 傳的）。\n沒分類的檔案不會進到報告裡喔。');
  msg.quickReply = { items: [
    { type: 'action', action: { type: 'message', label: '🗂 看待分類', text: '待分類' } },
    { type: 'action', action: { type: 'postback', label: '📋 逐一分類', data: 'pend|next', displayText: '逐一分類' } }] };
  pushAll([msg]);
}


// ===== v1.8 持股紀錄＋每日賣出檢查（賣出規則 A） =====
const HOLD_SHEET = '持股';
const HOLD_HEADERS = ['代號', '名稱', '買進日', '買價', '張數', '初始停損', '目前停損', '狀態', '賣出日', '賣價', '報酬%',
  '使用者', '已保本', '最新收盤', '檢查日', '檢查結果'];

function getHoldSheet() {
  const ss = getLogSheet().getParent();
  let sh = ss.getSheetByName(HOLD_SHEET);
  if (!sh) {
    sh = ss.insertSheet(HOLD_SHEET);
    sh.appendRow(HOLD_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
  }
  return sh;
}

function holdRows() {
  const sh = getHoldSheet();
  return sh.getDataRange().getValues().slice(1).map(function (r, i) {
    return { row: i + 2, code: String(r[0]), name: String(r[1]), buyDate: toDate(r[2]), price: +r[3], lots: +r[4] || 0,
      stop0: +r[5] || 0, stop: +r[6] || 0, status: String(r[7]), user: String(r[11]), be: r[12] === true || r[12] === '是',
      close: +r[13] || 0, checked: String(r[14] || ''), result: String(r[15] || '') };
  });
}

// 選股系統今天的資料（有上榜才有停損建議）
function screenerStock(code) {
  try {
    const d = fetchJson(SCREENER_SITE + 'data/latest.json');
    return d ? (d.stocks || []).filter(function (x) { return x.id === code; })[0] || null : null;
  } catch (e) { return null; }
}

function addHolding(code0, price, lots, stop) {
  const map = getStockMap();
  const code = resolveCode(code0, map);
  if (!code) return '查不到股號「' + code0 + '」。';
  if (!(price > 0)) return '買價要是數字，例如：買 3167 250 2張';
  const s = screenerStock(code);
  let src = '你指定的';
  if (!(stop > 0)) {
    if (s && s.stop > 0 && s.stop < price) { stop = s.stop; src = '選股系統建議的近 10 日低點'; }
    else { stop = Math.round(price * 0.92 * 100) / 100; src = '先用買價 −8%'; }
  }
  if (stop >= price) return '停損價要低於買價。';
  const risk = price - stop, riskPct = risk / price * 100;
  const sh = getHoldSheet();
  sh.appendRow([code, map[code] || '', today(), price, lots || '', stop, stop, '持有', '', '', '', memberName(CUR_UID), '否', '', '', '']);
  const lines = ['📝 已記錄買進：' + code + ' ' + (map[code] || ''),
    '買價 ' + price + (lots ? '｜' + lots + ' 張' : '') + '｜停損 ' + stop + '（' + src + '）',
    '風險 ' + riskPct.toFixed(1) + '%' + (lots ? '，最多虧約 ' + Math.round(risk * lots * 1000).toLocaleString() + ' 元' : ''),
    '保本價 ' + (Math.round((price + 2 * risk) * 100) / 100) + '：漲到這裡，停損會自動上移到買價',
    '',
    '之後每天收盤後會自動檢查：碰停損、保本、保本後跌破 50 日線，該賣時 LINE 通知你。'];
  if (riskPct > 8) lines.push('', '⚠️ 停損距離超過 8%，依你的規則這筆風險偏大。');
  if (s && s.warn && s.warn.length) lines.push('', '⚠️ 留意：' + s.warn.join('、'));
  if (!s) lines.push('', '⚠️ 這檔今天沒有通過趨勢模板（不在選股名單）。');
  return lines.join('\n');
}

function findOpenHolding(code) {
  const mine = holdRows().filter(function (h) { return h.code === code && h.status === '持有'; });
  const own = mine.filter(function (h) { return h.user === memberName(CUR_UID); });
  return (own.length ? own : mine).pop() || null;
}

function sellHolding(code0, px) {
  const code = resolveCode(code0, getStockMap()) || code0;
  const h = findOpenHolding(code);
  if (!h) return '找不到 ' + cn(code) + ' 的持股紀錄。傳「持股」看目前有哪些。';
  const sh = getHoldSheet();
  const pct = px > 0 ? Math.round((px * (1 - 0.001425 - 0.003) / (h.price * 1.001425) - 1) * 10000) / 100 : '';
  sh.getRange(h.row, 8, 1, 4).setValues([['已賣出', today(), px || '', pct]]);
  const r = px > 0 && h.price > h.stop0 ? ((px - h.price) / (h.price - h.stop0)).toFixed(1) + 'R' : '';
  return '✅ 已記錄賣出：' + code + ' ' + h.name + (px ? '\n賣價 ' + px + '｜報酬 ' + pct + '%（含手續費和證交稅）' + (r ? '｜' + r : '') : '\n（沒填賣價，報酬沒辦法計算；可以傳「賣 ' + code + ' 價格」補上）');
}

function setHoldingStop(code0, stop) {
  const code = resolveCode(code0, getStockMap()) || code0;
  const h = findOpenHolding(code);
  if (!h) return '找不到 ' + cn(code) + ' 的持股紀錄。';
  getHoldSheet().getRange(h.row, 7).setValue(stop);
  return '✅ ' + cn(code) + ' 停損改為 ' + stop + '（原本 ' + h.stop + '）';
}

function holdingsText() {
  const me = memberName(CUR_UID);
  const list = holdRows().filter(function (h) { return h.status === '持有' && (!h.user || h.user === me); });
  if (!list.length) return '目前沒有持股紀錄。\n買了之後傳：買 3167 250 2張';
  return '📋 目前持股 ' + list.length + ' 檔\n' + list.map(function (h) {
    const pct = h.close ? ((h.close / h.price - 1) * 100).toFixed(1) + '%' : '-';
    return '・' + h.code + ' ' + h.name + '｜買 ' + h.price + (h.lots ? '×' + h.lots + '張' : '') + '｜停損 ' + h.stop + (h.be ? '（已保本）' : '') +
      (h.close ? '｜收 ' + h.close + '（' + pct + '）' : '') + (h.result ? '\n　' + h.result : '');
  }).join('\n') + '\n\n每天收盤後自動檢查；傳「賣 代號 價格」記錄賣出。';
}

// 給 GitHub 的每日檢查：只回傳計算需要的欄位
function holdingsForCheck(p) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  const list = holdRows().filter(function (h) { return h.status === '持有'; }).map(function (h) {
    return { row: h.row, code: h.code, buyDate: h.buyDate ? Utilities.formatDate(h.buyDate, TZ, 'yyyy-MM-dd') : today(),
      price: h.price, stop: h.stop, be: h.be };
  });
  return { ok: true, holdings: list };
}

// 收到檢查結果：更新試算表，並推播給持有人
function applyHoldingChecks(results, date) {
  if (!results.length) return;
  const sh = getHoldSheet();
  const rows = holdRows();
  const byRow = {};
  rows.forEach(function (h) { byRow[h.row] = h; });
  const perUser = {};
  results.forEach(function (r) {
    const h = byRow[r.row];
    if (!h || h.status !== '持有' || h.code !== String(r.code)) return;
    let line, urgent = false, res;
    if (r.error) { res = '檢查失敗：' + r.error; line = '・' + h.code + ' ' + h.name + '｜' + res; }
    else {
      const moved = r.be && !h.be;
      if (r.status === 'stop_hit') { urgent = true; res = '🔴 已碰停損：' + r.note + ' → 還沒賣的話明天開盤賣'; }
      else if (r.status === 'sell_next_open') { urgent = true; res = '🔴 ' + r.note + ' → 明天開盤賣'; }
      else if (moved) { res = '🟢 已漲到保本價 ' + r.be_price + '，停損上移到買價 ' + r.stop + '（請更新你的停損單）'; }
      else { res = '持有｜距停損 ' + r.to_stop + '%' + (r.be ? '｜已保本，跌破 50 日線 ' + r.ma50 + ' 才賣' : '｜保本價 ' + r.be_price); }
      if (r.warn && r.warn.length) res += '｜⚠️' + r.warn.join('、');
      if (!r.listed) res += '｜已不在選股名單';
      sh.getRange(h.row, 7).setValue(Math.max(h.stop, r.stop || 0));
      sh.getRange(h.row, 13, 1, 4).setValues([[r.be ? '是' : '否', r.close, date, res]]);
      line = (urgent ? '‼️ ' : '・') + h.code + ' ' + h.name + '｜收 ' + r.close + '（' + (r.pct > 0 ? '+' : '') + r.pct + '%，' + r.r + 'R）\n　' + res;
    }
    const key = h.user || '';
    (perUser[key] = perUser[key] || { urgent: 0, lines: [] }).lines.push(line);
    if (urgent) perUser[key].urgent++;
  });
  const members = getMembers();
  Object.keys(perUser).forEach(function (name) {
    const u = perUser[name];
    const m = members.filter(function (x) { return x.name === name; })[0];
    const to = m ? m.id : prop('ALLOWED_USER_ID');
    const head = u.urgent ? '📋 持股檢查 ' + date.slice(5).replace('-', '/') + '｜‼️ 有 ' + u.urgent + ' 檔要處理' : '📋 持股檢查 ' + date.slice(5).replace('-', '/') + '｜都照規則持有中';
    const body2 = head + '\n' + u.lines.join('\n');
    if (u.urgent || !eveningPending()) pushTo([to], [text(body2)]);   // 要處理的立刻推；其餘併進 21:00
    else prop('EVE_HOLD_' + to, JSON.stringify({ day: today(), text: body2 }));
  });
}


// ===== v1.9 小助理更新重點：收集、分類、追蹤推播、雷達、歷史紀錄 =====
const FEED_SHEET = '小助理更新';
const FEED_HEADERS = ['時間', '代號', '名稱', '摘要', '10日%', '1月%', '分類', '題材', '收到時間', 'key'];
const WATCH_TAB = 'Watchlist';
const DEFAULT_WATCHLIST_SHEET_ID = '1W4xjYYmvQgS92WNvdrYWbCcdUJZE2lloQbKpluESN_E';   // 你原本的「法人預估紀錄1.0」（讀名稱含 watch 的分頁）
const DIGEST_TIMES = { morning: [8, 30], evening: [21, 0] };   // 推播時間（台北）
const POS_WORDS = /創新高|新高|創高|成長|年增|月增|大增|倍增|翻倍|上修|調升|轉盈|轉虧為盈|虧損收斂|虧損縮小|接單|訂單|滿載|滿單|漲價|調漲|擴產|放量|量產|出貨|認證|打入|拿下|得標|標案|受惠|強勁|樂觀|看好|供不應求|缺貨|合約負債|轉強|回溫|增溫|躍升|攀升|突破|加速|升級|推出|新品|導入|放量|拉貨|急單|追加/;
const NEG_WORDS = /衰退|年減|月減|下滑|下修|調降|虧損|轉虧|看淡|保守|延後|遞延|砍單|減產|庫存|跌價|降價|疲弱|不如預期|承壓|壓抑|放緩|趨緩|競爭加劇|減少|轉弱|觀望|停工|罰款|訴訟|失火|跳票|下降/;
const STRONG_NEG = /看淡|下修|調降|砍單|轉虧|虧損擴大|衰退|延後|不如預期|減產|停工|跳票|失火/;
const THEMES = [
  ['AI伺服器', /AI\s*伺服器|伺服器|GB200|GB300|輝達|NVIDIA|Rubin|ASIC|AI\s*設備|AI\s*基建|機櫃/i],
  ['先進封裝', /CoWoS|先進封裝|SoIC|玻璃基板|FOPLP|面板級|封測|扇出/i],
  ['CPO矽光子', /CPO|矽光子|光通訊|光模組|光收發|800G|1\.6T/i],
  ['記憶體', /DRAM|NAND|HBM|記憶體|DDR\d?/i],
  ['PCB材料', /PCB|CCL|銅箔|載板|ABF|玻纖|銅箔基板/i],
  ['散熱', /散熱|水冷|液冷|冷板|均熱|風扇/],
  ['電源電池', /電源|BBU|HVDC|UPS|電池|儲能/i],
  ['重電電網', /重電|變壓器|電網|電纜|配電|台電/],
  ['機器人', /機器人|人形|減速機|伺服馬達|自動化/],
  ['低軌衛星', /衛星|低軌/],
  ['半導體設備', /設備|機台|EUV|濕製程|檢測|探針/i],
  ['網通', /交換器|網通|Wi-?Fi|5G|路由器/i],
  ['車用', /電動車|車用|汽車|車載/],
  ['無人機國防', /無人機|國防|軍工/],
  ['生技醫療', /新藥|臨床|FDA|生技|醫材/i],
];

function getFeedSheet() {
  const ss = getLogSheet().getParent();
  let sh = ss.getSheetByName(FEED_SHEET);
  if (!sh) {
    sh = ss.insertSheet(FEED_SHEET);
    sh.appendRow(FEED_HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('B:B').setNumberFormat('@');
    sh.getRange('A:A').setNumberFormat('@');
  }
  return sh;
}

function classifyText(t) {
  t = String(t || '');
  const pos = POS_WORDS.test(t), neg = NEG_WORDS.test(t);
  if (/虧損收斂|虧損縮小|轉盈|轉虧為盈/.test(t)) return '偏多';
  if (neg && !pos) return '偏空';
  if (pos && !neg) return '偏多';
  if (pos && neg) return STRONG_NEG.test(t) ? '偏空' : '中性';
  return '中性';
}
function themesOf(t) { return THEMES.filter(function (x) { return x[1].test(t); }).map(function (x) { return x[0]; }); }
const ICON = { '偏多': '🔴', '偏空': '🟢', '中性': '⚪' };

// 竄改猴交來的一批更新
function feedIngest(p, body) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  const items = (body && body.items) || [];
  if (!items.length) return { ok: true, added: 0 };
  // v2.11 小助理更新只寫自己的分頁，改用獨立的鎖，不要卡住 LINE 傳檔／連結
  const lock = cacheMutex('FEED', 120);
  let fresh = [];
  try {
    const sh = getFeedSheet();
    const n = sh.getLastRow();
    const keys = {};
    if (n > 1) sh.getRange(Math.max(2, n - 8000), 10, Math.min(n - 1, 8000), 1).getValues().forEach(function (r) { keys[r[0]] = 1; });
    const rows = [];
    items.forEach(function (it) {
      const text2 = String(it.text || '').slice(0, 300);
      const k = String(it.d) + '|' + String(it.code) + '|' + text2.slice(0, 20);
      if (!it.code || !it.d || keys[k]) return;
      keys[k] = 1;
      const cls = classifyText(text2);
      const th = themesOf(text2).join('、');
      rows.push([String(it.d), String(it.code), String(it.name || ''), text2, it.p10 === null || it.p10 === undefined ? '' : it.p10,
        it.p1m === null || it.p1m === undefined ? '' : it.p1m, cls, th, now(), k]);
      fresh.push({ d: String(it.d), code: String(it.code), name: String(it.name || ''), text: text2, cls: cls });
    });
    if (rows.length) { sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows); FEED_MEMO = null; }
  } finally {
    lock.releaseLock();
  }
  try { urgentHoldingAlerts(fresh); } catch (e) { console.warn('持股即時提醒失敗：' + e); }
  return { ok: true, added: fresh.length };
}

// 唯一的即時推播：持股出現強烈偏空的更新（只看最近 2 天的，避免第一次回補時洗版）
function urgentHoldingAlerts(fresh) {
  const recent = Date.now() - 2 * 86400000;
  const hold = holdRows().filter(function (h) { return h.status === '持有'; });
  if (!hold.length) return;
  const sent = safeJson(prop('URGENT_SENT'));
  fresh.forEach(function (it) {
    if (it.cls !== '偏空' || !STRONG_NEG.test(it.text)) return;
    if (feedTime(it.d) < recent) return;
    const k = it.code + '|' + it.d;
    if (sent[k]) return;
    hold.filter(function (h) { return h.code === it.code; }).forEach(function (h) {
      const m = getMembers().filter(function (x) { return x.name === h.user; })[0];
      pushTo([m ? m.id : prop('ALLOWED_USER_ID')], [text('‼️ 持股警訊：' + it.code + ' ' + (it.name || h.name) + '\n' + it.d.slice(5) + '　🟢 ' + it.text +
        '\n\n買價 ' + h.price + '｜停損 ' + h.stop + '\n看完判斷要不要調整；照規則的話，停損沒到就續抱。傳「更新 ' + it.code + '」看這檔最近的更新紀錄。')]);
      sent[k] = Date.now();
    });
  });
  Object.keys(sent).forEach(function (k) { if (Date.now() - sent[k] > 7 * 86400000) delete sent[k]; });
  prop('URGENT_SENT', JSON.stringify(sent));
}

function feedTime(d) { const t = new Date(String(d).replace(' ', 'T') + ':00+08:00').getTime(); return isNaN(t) ? 0 : t; }

// 讀最近 N 天的更新（新的在後）
let FEED_MEMO = null;
function feedRecent(days) {
  if (!FEED_MEMO) FEED_MEMO = feedReadAll();
  const since = Date.now() - days * 86400000;
  return FEED_MEMO.filter(function (x) { return feedTime(x.d) >= since; });
}
function feedReadAll() {
  const days = 125;
  const sh = getFeedSheet();
  const n = sh.getLastRow();
  if (n < 2) return [];
  const take = Math.min(n - 1, 20000);
  const since = Date.now() - days * 86400000;
  return sh.getRange(n - take + 1, 1, take, 8).getValues().map(function (r) {
    return { d: String(r[0]), code: String(r[1]), name: String(r[2]), text: String(r[3]), p10: r[4] === '' ? null : +r[4], p1m: r[5] === '' ? null : +r[5], cls: String(r[6]), themes: String(r[7] || '') };
  }).filter(function (x) { return feedTime(x.d) >= since; }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
}

// ---------- 追蹤清單（Google Sheet 的 Watchlist；持股自動算進來）----------
function watchSheet() {
  const id = prop('WATCHLIST_SHEET_ID') || DEFAULT_WATCHLIST_SHEET_ID;
  if (id) {
    try {
      const ss = SpreadsheetApp.openById(id);
      return ss.getSheets().filter(function (x) { return /watch/i.test(x.getName()); })[0] || ss.getSheets()[0];
    } catch (e) { console.warn('追蹤表打不開：' + e); }
  }
  const ss = getLogSheet().getParent();
  let sh = ss.getSheetByName(WATCH_TAB);
  if (!sh) { sh = ss.insertSheet(WATCH_TAB); sh.appendRow(['代號', '名稱', '備註']); sh.setFrozenRows(1); sh.getRange('A:A').setNumberFormat('@'); }
  return sh;
}

function getWatchCodes() {
  const out = {};
  try {
    const v = watchSheet().getDataRange().getValues();
    v.forEach(function (r) {
      for (let i = 0; i < Math.min(3, r.length); i++) {
        const m = String(r[i]).trim().match(/^(\d{4,6}[A-Z]?)(?:\s|$|\.0$)/);
        if (m) { out[m[1]] = 'watch'; break; }
      }
    });
  } catch (e) { console.warn('讀追蹤表失敗：' + e); }
  holdRows().forEach(function (h) { if (h.status === '持有') out[h.code] = 'hold'; });
  return out;
}

function watchAdd(code0) {
  const map = getStockMap();
  const code = resolveCode(code0, map);
  if (!code) return '查不到股號「' + code0 + '」。';
  if (getWatchCodes()[code]) return code + ' 已經在追蹤清單裡。';
  const sh = watchSheet();
  sh.appendRow([code, map[code] || '', '由 LINE 加入 ' + today()]);
  return '✅ 已加入追蹤：' + code + ' ' + (map[code] || '') + '\n之後它的小助理更新會出現在 08:30／21:00 的摘要裡。';
}

function watchRemove(code) {
  const sh = watchSheet();
  const v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    if (v[i].slice(0, 3).some(function (c) { return String(c).trim().indexOf(code) === 0; })) { sh.deleteRow(i + 1); return '✅ 已取消追蹤 ' + cn(code); }
  }
  return code + ' 不在追蹤表裡' + (getWatchCodes()[code] === 'hold' ? '（它是持股，賣出後才會自動移除）' : '') + '。';
}

function setWatchlistSheet(s) {
  const m = String(s).match(/[-\w]{25,}/);
  if (!m) return '請貼上 Google 試算表的網址，例如：設定追蹤表 https://docs.google.com/spreadsheets/d/…';
  try { SpreadsheetApp.openById(m[0]); } catch (e) { return '打不開這份試算表，請確認網址正確、而且是你自己的檔案。'; }
  prop('WATCHLIST_SHEET_ID', m[0]);
  return '✅ 已設定追蹤表，會讀名稱含「watch」的分頁（沒有就讀第一個分頁）的前 3 欄股號。\n目前追蹤 ' + Object.keys(getWatchCodes()).length + ' 檔（含持股）。';
}

function watchlistText() {
  const w = getWatchCodes(), map = getStockMap();
  const codes = Object.keys(w).sort();
  if (!codes.length) return '追蹤清單是空的。傳「追蹤 3167」加入，或「設定追蹤表 試算表網址」用你原本的 Watchlist。';
  return '👀 追蹤清單 ' + codes.length + ' 檔\n' + codes.map(function (c) { return '・' + c + ' ' + (map[c] || '') + (w[c] === 'hold' ? '（持股）' : ''); }).join('\n');
}

// ---------- 單檔更新紀錄（LINE 查詢＋報告用）----------
function stockUpdatesText(code, n) {
  const list = feedRecent(120).filter(function (x) { return x.code === code; });
  if (!list.length) return code + ' 最近 4 個月沒有收到小助理更新。';
  const rows = list.slice(-n).reverse();
  return '📰 ' + code + ' ' + (rows[0].name || '') + ' 最近的小助理更新（共 ' + list.length + ' 則）\n' +
    rows.map(function (x) { return ICON[x.cls] + ' ' + x.d.slice(5, 10) + '　' + x.text; }).join('\n') + '\n\n' + trendLine(list);
}

// 這檔最近 30 天 vs 之前的偏多／偏空比例，看有沒有轉向
function trendLine(list) {
  const cut = Date.now() - 30 * 86400000;
  const a = list.filter(function (x) { return feedTime(x.d) < cut; }), b = list.filter(function (x) { return feedTime(x.d) >= cut; });
  const cnt = function (arr, c) { return arr.filter(function (x) { return x.cls === c; }).length; };
  return '近 30 天：偏多 ' + cnt(b, '偏多') + '、偏空 ' + cnt(b, '偏空') + '、中性 ' + cnt(b, '中性') + (a.length ? '｜更早：偏多 ' + cnt(a, '偏多') + '、偏空 ' + cnt(a, '偏空') : '');
}

function refreshUpdatesDoc(code, name, folder) {
  const list = feedRecent(120).filter(function (x) { return x.code === code; });
  if (!list.length) return null;
  const title = code + '_小助理更新紀錄（自動更新）';
  const md = ['# ' + code + ' ' + name + '｜優分析小助理更新重點（逐日累積）', '來源：優分析「小助理更新重點」，由竄改猴每 10 分鐘收集；🔴偏多 🟢偏空 ⚪中性 是關鍵字自動分類，只供參考。', trendLine(list), '']
    .concat(list.map(function (x) { return '- ' + x.d + '　' + ICON[x.cls] + ' ' + x.text + (x.p10 !== null ? '（當時 10 日漲跌 ' + x.p10 + '%）' : ''); })).join('\n');
  const it = folder.getFilesByName(title);
  let doc;
  if (it.hasNext()) doc = DocumentApp.openById(it.next().getId());
  else { doc = DocumentApp.create(title); DriveApp.getFileById(doc.getId()).moveTo(folder); }
  doc.getBody().setText(md);
  doc.saveAndClose();
  return DriveApp.getFileById(doc.getId());
}

// ---------- 雷達：題材的偏多更新突然變多＋股價跟上 ----------
function radarThemes() {
  const all = feedRecent(40);
  const nowT = Date.now(), d5 = nowT - 5 * 86400000;
  let listed = {};
  try { const d = fetchJson(SCREENER_SITE + 'data/latest.json'); (d && d.stocks || []).forEach(function (x) { listed[x.id] = x; }); } catch (e) { /* 選股資料抓不到就只看漲跌 */ }
  const out = [];
  THEMES.forEach(function (th) {
    const name = th[0];
    const pos = all.filter(function (x) { return x.cls === '偏多' && x.themes.indexOf(name) >= 0; });
    const recent = pos.filter(function (x) { return feedTime(x.d) >= d5; });
    const base = pos.length - recent.length;                 // 前 35 天
    const baseline5 = base / 35 * 5;
    const ratio = baseline5 > 0 ? recent.length / baseline5 : (recent.length ? 99 : 0);
    const codes = {};
    recent.forEach(function (x) { codes[x.code] = x; });
    const uniq = Object.keys(codes).map(function (c) { return codes[c]; });
    const p10s = uniq.map(function (x) { return x.p10; }).filter(function (v) { return v !== null && !isNaN(v); }).sort(function (a, b) { return a - b; });
    const med = p10s.length ? p10s[Math.floor(p10s.length / 2)] : null;
    const nListed = uniq.filter(function (x) { return listed[x.code]; }).length;
    const priceOk = (med !== null && med >= 5) || nListed >= 3;
    const reps = uniq.sort(function (a, b) { return (listed[b.code] ? 1 : 0) - (listed[a.code] ? 1 : 0) || (b.p10 || 0) - (a.p10 || 0); }).slice(0, 3);
    out.push({ name: name, recent: recent.length, stocks: uniq.length, ratio: Math.round(ratio * 10) / 10, med: med, nListed: nListed,
      hot: recent.length >= 5 && uniq.length >= 3 && ratio >= 3 && priceOk, reps: reps });
  });
  return out.sort(function (a, b) { return (b.hot - a.hot) || (b.ratio - a.ratio) || (b.recent - a.recent); });
}

function radarText(manual) {
  const r = radarThemes();
  const hot = r.filter(function (x) { return x.hot; }).slice(0, 3);
  const fmt = function (x) {
    return '・' + x.name + '：近 5 天偏多 ' + x.recent + ' 則／' + x.stocks + ' 檔（' + (x.ratio >= 99 ? '之前一個月幾乎沒有' : '平常的 ' + x.ratio + ' 倍') + '）' +
      (x.med !== null ? '｜10 日漲跌中位數 ' + (x.med > 0 ? '+' : '') + x.med + '%' : '') + (x.nListed ? '｜' + x.nListed + ' 檔在選股名單' : '') +
      (x.reps.length ? '\n　代表：' + x.reps.map(function (s) { return s.code + ' ' + s.name; }).join('、') : '');
  };
  if (!manual) return hot.length ? '🛰️ 題材雷達（消息變熱＋股價跟上）\n' + hot.map(fmt).join('\n') : '';
  const top = r.filter(function (x) { return x.recent > 0; }).slice(0, 6);
  return '🛰️ 題材雷達（近 5 天）\n' + (hot.length ? '🔥 符合條件：' + hot.map(function (x) { return x.name; }).join('、') + '\n' : '目前沒有題材同時符合「偏多消息是平常 3 倍以上＋股價跟上」。\n') +
    (top.length ? '\n熱度排行：\n' + top.map(fmt).join('\n') : '還沒有足夠的更新資料（竄改猴收集約一週後會比較準）。');
}

// 雷達股：不在追蹤清單、今天有偏多更新、又正好通過趨勢模板
function radarStocks(watch, sinceT) {
  let listed = {};
  try { const d = fetchJson(SCREENER_SITE + 'data/latest.json'); (d && d.stocks || []).forEach(function (x) { listed[x.id] = x; }); } catch (e) { return []; }
  const seen = {};
  return feedRecent(2).filter(function (x) {
    if (feedTime(x.d) < sinceT || x.cls !== '偏多' || watch[x.code] || !listed[x.code] || seen[x.code]) return false;
    seen[x.code] = 1; return true;
  }).sort(function (a, b) { return (listed[b.code].rs || 0) - (listed[a.code].rs || 0); }).slice(0, 3).map(function (x) {
    const s = listed[x.code];
    return '・' + x.code + ' ' + x.name + '（RS ' + s.rs + '｜評分 ' + s.score + '/4' + (s.action === 'buy' ? '｜🟢可買' : s.action === 'ready' ? '｜🟡準備區' : '') + '）\n　🔴 ' + x.text;
  });
}

// ---------- 摘要推播 ----------
function nowHM() { const d = new Date(); return [+Utilities.formatDate(d, TZ, 'H'), +Utilities.formatDate(d, TZ, 'm')]; }
function eveningPending() {
  const hm = nowHM();
  return prop('DIGEST_evening') !== today() && (hm[0] < DIGEST_TIMES.evening[0] || (hm[0] === DIGEST_TIMES.evening[0] && hm[1] < DIGEST_TIMES.evening[1]));
}

// checkReports 每 10 分鐘呼叫：到時間就推一次
function digestTick() {
  const hm = nowHM(), mins = hm[0] * 60 + hm[1];
  ['morning', 'evening'].forEach(function (kind) {
    const t = DIGEST_TIMES[kind][0] * 60 + DIGEST_TIMES[kind][1];
    if (mins < t || mins > t + 50 || prop('DIGEST_' + kind) === today()) return;
    prop('DIGEST_' + kind, today());
    getMembers().forEach(function (m) {
      const msgs = digestMessages(m.id, kind);
      if (msgs.length) pushTo([m.id], msgs.slice(0, 5));
    });
    if (kind === 'evening') { props().deleteProperty('EVE_SCREENER'); getMembers().forEach(function (m) { props().deleteProperty('EVE_HOLD_' + m.id); }); }
    prop('DIGEST_LAST_' + kind, String(Date.now()));
  });
}

// 產生某位成員的摘要訊息（kind：morning／evening／manual）
function digestMessages(uid, kind) {
  const msgs = [];
  const watch = getWatchCodes();
  const lastOther = Number(prop(kind === 'morning' ? 'DIGEST_LAST_evening' : 'DIGEST_LAST_morning') || 0);
  const sinceT = kind === 'manual' ? Date.now() - 86400000 : (lastOther && Date.now() - lastOther < 20 * 3600000 ? lastOther : Date.now() - 13 * 3600000);
  if (kind === 'evening') {
    const sc = safeJson(prop('EVE_SCREENER'));
    if (sc.day === today() && sc.msg) msgs.push(sc.msg);
    const hd = safeJson(prop('EVE_HOLD_' + uid));
    if (hd.day === today() && hd.text) msgs.push(text(hd.text));
  }
  // 追蹤股的更新：一檔一行（多則時顯示最新一則＋則數），偏空排前面，最多 12 檔
  const upd = feedRecent(2).filter(function (x) { return feedTime(x.d) >= sinceT && watch[x.code]; });
  const byCode = {};
  upd.forEach(function (x) { (byCode[x.code] = byCode[x.code] || []).push(x); });
  const history = feedRecent(60);
  const lines = Object.keys(byCode).map(function (c) {
    const arr = byCode[c], last = arr[arr.length - 1];
    const prev = history.filter(function (x) { return x.code === c && feedTime(x.d) < sinceT && x.cls !== '中性'; }).pop();
    const flip = prev && last.cls !== '中性' && prev.cls !== last.cls ? '🔄 轉向（上次' + prev.cls + ' ' + prev.d.slice(5, 10) + '）' : '';
    const order = (watch[c] === 'hold' ? 0 : 1) * 10 + (last.cls === '偏空' ? 0 : last.cls === '偏多' ? 1 : 2);
    return { order: order, t: ICON[last.cls] + ' ' + c + ' ' + last.name + (watch[c] === 'hold' ? '（持股）' : '') + (arr.length > 1 ? '（' + arr.length + ' 則）' : '') + '\n　' + last.text + (flip ? '\n　' + flip : '') };
  }).sort(function (a, b) { return a.order - b.order; });
  const L = [];
  const title = kind === 'morning' ? '🌅 盤前追蹤摘要' : kind === 'evening' ? '🌙 晚間追蹤摘要' : '📋 追蹤摘要（近 24 小時）';
  if (lines.length) L.push(title + '｜' + lines.length + ' 檔有新消息', lines.slice(0, 12).map(function (x) { return x.t; }).join('\n') + (lines.length > 12 ? '\n…還有 ' + (lines.length - 12) + ' 檔，傳「更新 代號」看單檔' : ''));
  if (kind !== 'morning') {
    const rs = radarStocks(watch, sinceT);
    if (rs.length) L.push('', '🎯 雷達股（不在追蹤清單、有好消息、又通過趨勢模板）', rs.join('\n'));
    const rt = radarText(false);
    if (rt) L.push('', rt);
    const rv = revisionClusterText();
    if (rv) L.push('', rv);
  }
  if (L.length) {
    const m = text(L.join('\n'));
    m.quickReply = { items: [
      { type: 'action', action: { type: 'message', label: '👀 追蹤清單', text: '追蹤清單' } },
      { type: 'action', action: { type: 'message', label: '🛰️ 雷達', text: '雷達' } },
      { type: 'action', action: { type: 'message', label: '📋 持股', text: '持股' } }] };
    msgs.push(m);
  } else if (kind === 'manual') {
    msgs.push(text('近 24 小時追蹤清單沒有新的小助理更新。' + (Object.keys(watch).length ? '' : '\n追蹤清單是空的：傳「追蹤 3167」加入。')));
  }
  return msgs;
}


// ===== v1.9.1 常開電腦的優分析被登出 → LINE 提醒（每天最多一次）=====
function hasJobForScraper(p) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  if (prop('ACTIVE_JOBS') !== '1') return { ok: true, jobs: 0 };
  return { ok: true, jobs: jobRows(getJobSheet()).filter(function (j) { return j.status === '待抓取'; }).length };
}

function uaAlert(p) {
  if (!checkScrapeKey(p)) return { ok: false, error: 'bad key' };
  if (p.what === 'relogin') { push([text('🔑 有報告在等，但常開電腦的優分析被登出了。\n3 分鐘後會自動重新登入；你其他裝置上的優分析可能會被登出。')]); return { ok: true }; }
  if (p.what === 'loggedin') { if (prop('UA_LOGOUT_ALERT') === today()) push([text('✅ 常開電腦的優分析已自動重新登入，漏掉的小助理更新會自動補回。')]); return { ok: true }; }
  if (prop('UA_LOGOUT_ALERT') === today()) return { ok: true, skipped: true };
  prop('UA_LOGOUT_ALERT', today());
  push([text('⚠️ 常開電腦上的優分析被登出了（可能是你在別的裝置登入）。\n在重新登入之前：「報告」抓不到小助理、小助理更新也會暫停收集。\n半夜 00:30～07:30 會自動重新登入（有設定帳號密碼的話）；白天有報告在等時，會先通知你再登入。重新登入後會自動補回漏掉的更新。')]);
  return { ok: true };
}


// ===== v2.0 美股：代號清單、資料夾、檔名辨識、報告規則 =====
const US_FOLDER = '美股';
const US_MAP_FILE = 'us_tickers.json';
const US_STOP = { CCL: 1, ABF: 1, SSD: 1, DRAM: 1, NAND: 1, LED: 1, MLCC: 1, HPC: 1, EV: 1, ASP: 1, BBU: 1, GB: 1, IC: 1, OSAT: 1, NPU: 1, PC: 1, NB: 1, IP: 1, PE: 1, PB: 1, ROE: 1, TSMC: 1, AMD2: 1, A: 1, I: 1, AI: 1, PCB: 1, CEO: 1, CFO: 1, USA: 1, US: 1, ETF: 1, IT: 1, ON: 1, IN: 1, AT: 1, OR: 1, AN: 1, BE: 1, TO: 1, IS: 1, IT2: 1, EPS: 1, GDP: 1, CPU: 1, GPU: 1, HBM: 1, CPO: 1, ASIC: 1, PDF: 1, Q: 1, NEW: 1, ALL: 1, ONE: 1, NOW: 1, FOR: 1, ARE: 1, CAN: 1, HAS: 1, KEY: 1, OUT: 1, TWO: 1, SEE: 1, BIG: 1, LOW: 1, HIGH: 1, BUY: 1, SELL: 1, HOLD: 1, TP: 1, PT: 1, YOY: 1, QOQ: 1, FY: 1, OK: 1, UP: 1, DD: 1, RE: 1 };
function isUS(code) { return /^[A-Z][A-Z.]{0,6}$/.test(String(code || '').toUpperCase()) && !/^\d/.test(String(code)); }

let US_MAP_MEMO = null;
function getUSMap() {
  if (US_MAP_MEMO) return US_MAP_MEMO;
  const sys = getOrCreateChild(rootFolder(), SYSTEM_FOLDER).folder;
  const it = sys.getFilesByName(US_MAP_FILE);
  const file = it.hasNext() ? it.next() : null;
  if (file && Date.now() - file.getLastUpdated().getTime() < 14 * 86400000) {
    US_MAP_MEMO = safeJson(file.getBlob().getDataAsString());
    if (Object.keys(US_MAP_MEMO).length) return US_MAP_MEMO;
  }
  const map = {};
  ['https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt', 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'].forEach(function (url) {
    try {
      const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) return;
      r.getContentText().split(/\r?\n/).slice(1).forEach(function (line) {
        const c = line.split('|');
        const sym = String(c[0] || '').trim().replace('$', '.');
        if (!/^[A-Z][A-Z.]{0,6}$/.test(sym) || /File Creation/.test(line)) return;
        if ((/nasdaqlisted/.test(url) ? c[3] : c[6]) === 'Y') return;   // 測試代號
        let nm = String(c[1] || '').replace(/ - .*$/, '').replace(/ (Common Stock|Ordinary Shares|American Depositary|Class [A-C]).*$/i, '').trim();
        for (let k = 0; k < 3; k++) nm = nm.replace(/,?\s+(Inc\.?|Corp\.?|Corporation|Company|Co\.|Ltd\.?|Limited|Holdings?|plc|N\.V\.|S\.A\.)$/i, '').trim();
        map[sym] = nm.slice(0, 40);
      });
    } catch (e) { console.warn('美股清單下載失敗：' + url + ' ' + e); }
  });
  if (Object.keys(map).length > 1000) {
    const json2 = JSON.stringify(map);
    if (file) file.setContent(json2); else sys.createFile(US_MAP_FILE, json2, MimeType.PLAIN_TEXT);
    US_MAP_MEMO = map;
  } else {
    US_MAP_MEMO = file ? safeJson(file.getBlob().getDataAsString()) : {};
  }
  return US_MAP_MEMO;
}

function stockName(code) {
  if (isUS(code)) return getUSMap()[String(code).toUpperCase()] || '';
  return getStockMap()[code] || '';
}

function getUSFolder(code, name) {
  const top = getOrCreateChild(rootFolder(), US_FOLDER).folder;
  const it = top.getFolders();
  const re = new RegExp('^' + code.replace('.', '\\.') + '(?![A-Z.])');
  while (it.hasNext()) { const f = it.next(); if (re.test(f.getName())) return { folder: f, created: false }; }
  return { folder: top.createFolder((code + ' ' + (name || stockName(code))).trim()), created: true };
}

function listUSFolders() {
  const top = getChildIfExists(rootFolder(), US_FOLDER);
  if (!top) return [];
  const out = [], it = top.getFolders();
  while (it.hasNext()) { const f = it.next(); const m = f.getName().match(/^([A-Z][A-Z.]{0,6})/); if (m) out.push({ code: m[1], name: f.getName(), count: countFiles(f) }); }
  return out.sort(function (a, b) { return a.code < b.code ? -1 : 1; });
}

function usFolderText() {
  const list = listUSFolders();
  if (!list.length) return '還沒有美股資料夾。\n傳「美股 NVDA」後接著傳檔案，或檔名裡有「NVDA US」「(NVDA)」，就會自動建立。';
  return '🇺🇸 美股資料夾：\n' + list.map(function (x) { return '・' + x.name + '（' + x.count + ' 份）'; }).join('\n') + '\n\n要報告就傳「報告 代號」，例如：報告 NVDA';
}

// 檔名裡的美股代號：只認券商常見寫法「NVDA US」「NVDA.O」「(NVDA)」「NASDAQ: NVDA」，避免把一般英文字當代號
function detectUSTicker(stem) {
  const pats = [/(?:^|[^A-Za-z])([A-Z]{1,5}(?:\.[A-Z])?)\s?(?:US|UW|UN|UQ|UA)(?![A-Za-z])/, /(?:^|[^A-Za-z])([A-Z]{1,5})\.(?:O|N|OQ)(?![A-Za-z])/,
    /\(([A-Z]{1,5}(?:\.[A-Z])?)(?:\s?US)?\)/, /(?:NASDAQ|NYSE)\s*[:：]\s*([A-Z]{1,5})/i];
  const map = getUSMap();
  for (let i = 0; i < pats.length; i++) {
    const m = String(stem).match(pats[i]);
    if (m && map[m[1]] && !US_STOP[m[1]]) return m[1];
  }
  return null;
}

const US_RULES_NOTE = [
  '',
  '## 這是美股（不是台股）',
  '- 沒有優分析小助理，也沒有選股系統技術面：第六段改寫「新聞與公開資訊重點」（技術面寫「無選股系統資料」）（files 裡的新聞、網頁存檔、截圖），沒有就寫「無」。',
  '- 金額單位用美元，EPS 用美元；財報年度依公司會計年度（例如 NVIDIA 的 FY 跨年度），寫清楚 FY 與對應季度。',
  '- 循環位置判斷照樣做；若是 AI／半導體上游，另外寫「對台灣供應鏈的意義」（提到的台股公司列出代號）。',
  '- estimates.csv 的股號欄填美股代號（例如 NVDA）。',
].join('\n');


// ===== v2.3 文字筆記（memo）=====
// 每檔股票／產業一份「{代號}_我的筆記」Google 文件，最新的在最上面；整合報告會一起讀
const MEMO_SUFFIX = '_我的筆記';
const MEMO_MIN_LEN = 20;          // 沒寫股號時，至少這麼長才當筆記（避免把打錯的指令存起來）
const MEMO_CACHE_SEC = 6 * 3600;  // 待分類筆記保留 6 小時
function memoCache() { return CacheService.getScriptCache(); }
function memoPending() { return memoCache().get('MEMO_PEND_' + CUR_UID); }
function memoClear() { memoCache().remove('MEMO_PEND_' + CUR_UID); }
function memoSetPending(body) { memoCache().put('MEMO_PEND_' + CUR_UID, body, MEMO_CACHE_SEC); }

// 明確格式：「筆記 …」「memo …」「3167 …」「NVDA …」「產業 記憶體 …」
function tryMemo(t) {
  let m = t.match(/^(?:筆記|備忘|memo|📝)\s*[:：]?\s*([\s\S]*)$/i);
  if (m) {
    const body = m[1].trim();
    if (!body) return text('筆記內容是空的。用法：「筆記 3167 法說會重點…」，或直接「3167 法說會重點…」。');
    const sp0 = splitSegments(body);
    if (sp0.segs.length >= 2) return saveSplitMemo(sp0, body, '');
    const lead = leadTarget(body);
    if (lead) return saveMemo([lead.target], lead.rest);
    return autoMemo(body);
  }
  m = t.match(/^產業[\s:：]+([^\s,，:：]+)[\s,，:：]+([\s\S]+)$/);
  if (m) {
    const nm = cleanIndustry(m[1]), rest = m[2].trim();
    const known = listIndustries().some(function (x) { return x.name === nm; });
    if (nm && (known || rest.length >= 10 || /\n/.test(t))) return saveMemo([{ type: 'industry', sub: nm }], rest);
    return null;
  }
  const sp = splitSegments(t);   // v2.5 一則提到很多檔（例如外電整理）→ 拆到各公司
  if (sp.segs.length >= 2) return saveSplitMemo(sp, t, '');
  const lead = leadTarget(t);
  if (lead) return saveMemo([lead.target], lead.rest);
  return null;
}

// 開頭是股號／美股代號＋內容
function leadTarget(t) {
  let m = t.match(/^(\d{4,6}[A-Z]?)[\s,，:：、]+([\s\S]{2,})$/);
  if (m) {
    const code = resolveCode(m[1], getStockMap());
    if (code) return { target: { type: 'stock', code: code, name: stockName(code) }, rest: m[2].trim() };
  }
  // 美股：「$NVDA …」「美股 NVDA …」，或已經有「美股/NVDA」資料夾的代號（避免 CCL、HBM 這類產業縮寫被當成美股）
  m = t.match(/^(?:美股\s+|\$)([A-Za-z]{1,5}(?:\.[A-Za-z])?)[\s,，:：、]+([\s\S]{2,})$/);
  if (m) m[1] = m[1].toUpperCase();
  if (!m) {
    m = t.match(/^([A-Z]{1,5}(?:\.[A-Z])?)[\s,，:：、]+([\s\S]{2,})$/);
    if (m && !listUSFolders().some(function (f) { return f.code === m[1]; })) m = null;
  }
  if (m && getUSMap()[m[1]]) return { target: { type: 'stock', code: m[1], name: stockName(m[1]) }, rest: m[2].trim() };
  return null;
}

// 沒寫股號：先看 5 分鐘內有沒有「先傳股號」，再從內文找股號／公司名／美股代號／產業名
function autoMemo(body) {
  const sp = splitSegments(body);
  if (sp.segs.length >= 2) return saveSplitMemo(sp, body, '');
  const next = nextTarget();
  if (next) return saveMemo([next], body);
  const found = findMemoTargets(body);
  // 只有一個「明確」的對象（股號、3 字以上公司名、美股代號）才直接存；2 個字的公司名（台燿、大量…）先問你確認
  if (found.length && !found[0].weak) return saveMemo([found[0]], body);   // 第一名明顯領先才直接存
  memoSetPending(body);
  return memoPicker(found);
}

function findMemoTargets(body) {
  // v2.9 改用跟連結一樣的打分數（排除年份、常見詞股名），第一行權重較高
  const map0 = getStockMap();
  const first = String(body).split(/\n/)[0].slice(0, 120);
  const rk = rankStocks([{ text: first, w: 2 }, { text: String(body).slice(0, 2000), w: 1 }], map0);
  const res = rk.slice(0, 6).map(function (x, i) {
    return { type: 'stock', code: x.code, name: map0[x.code] || stockName(x.code), weak: !(i === 0 && rankDecide(rk, 3) === x.code), score: x.score };   // 筆記是你自己寫的，門檻低一點
  });
  const usx = (String(body).match(/\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g) || []).map(function (x) { return x.slice(1); }).filter(function (c) { return getUSMap()[c]; });
  const t2 = detectUSTicker(body); if (t2) usx.push(t2);
  usx.filter(function (c, i, a) { return a.indexOf(c) === i; }).forEach(function (c) { res.push({ type: 'stock', code: c, name: stockName(c), weak: res.length > 0 }); });
  if (!res.length) listIndustries().forEach(function (x) { if (x.name.length >= 2 && String(body).indexOf(x.name) >= 0) res.push({ type: 'industry', sub: x.name, weak: true }); });
  return res.slice(0, 6);
}

function findMemoTargetsOld(body) {
  const out = [], seen = {};
  const add = function (tg) { const k = tg.type === 'industry' ? 'I:' + tg.sub : tg.code; if (!seen[k]) { seen[k] = 1; out.push(tg); } };
  const map = getStockMap();
  // 台股代號：4 碼數字，排除年份、金額、百分比（例如 2026年、2025Q3、3000億、25%）
  const re = /(^|[^\d.A-Za-z])(\d{4})(?![\d.%億萬元張年月日季QHqh\-\/／])/g;
  let m;
  while ((m = re.exec(body))) {
    if (/FY\s*$/i.test(body.slice(Math.max(0, m.index - 3), m.index + m[1].length))) continue;
    if (map[m[2]]) add({ type: 'stock', code: m[2], name: map[m[2]] });
  }
  // 公司名稱（2 個字的名稱容易跟一般用詞撞到，例如「大量」，標成 weak＝要再確認）
  Object.keys(map).forEach(function (c) {
    const nm = String(map[c] || '').replace(/-KY$|\*$/, '');   // 「臻鼎-KY」平常只寫「臻鼎」
    if (nm.length >= 2 && body.indexOf(nm) >= 0) add({ type: 'stock', code: c, name: map[c], weak: nm.length < 3 });
  });
  // 美股：$NVDA、NVDA US、(NVDA)
  const us = body.match(/\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g) || [];
  us.forEach(function (x) { const c = x.slice(1); if (getUSMap()[c]) add({ type: 'stock', code: c, name: stockName(c) }); });
  const t2 = detectUSTicker(body);
  if (t2) add({ type: 'stock', code: t2, name: stockName(t2) });
  // 已經有的產業資料夾名稱
  if (!out.length) listIndustries().forEach(function (x) { if (x.name.length >= 2 && body.indexOf(x.name) >= 0) add({ type: 'industry', sub: x.name }); });
  return out.slice(0, 6);
}

function memoLabel(tg) { return tg.type === 'industry' ? '產業／' + tg.sub : cn(tg.code, tg.name); }

function memoPicker(found) {
  const items = [];
  found.slice(0, 5).forEach(function (tg) {
    items.push({ type: 'action', action: { type: 'postback', label: ('📝 ' + memoLabel(tg)).slice(0, 20),
      data: 'memo|' + (tg.type === 'industry' ? 'I' : 'S') + '|' + (tg.type === 'industry' ? tg.sub : tg.code), displayText: '存到 ' + memoLabel(tg) } });
  });
  if (found.length > 1) items.push({ type: 'action', action: { type: 'postback', label: '全部都存', data: 'memo|ALL', displayText: '全部都存' } });
  if (!found.length) {
    listStockFolders().concat(listUSFolders()).slice(0, 6).forEach(function (f) {
      items.push({ type: 'action', action: { type: 'postback', label: ('📝 ' + f.name).slice(0, 20), data: 'memo|S|' + f.code, displayText: '存到 ' + f.name } });
    });
  }
  items.push({ type: 'action', action: { type: 'postback', label: '✏️ 其他股票', data: 'memo|TYPE', displayText: '存到其他股票' } });
  items.push({ type: 'action', action: { type: 'postback', label: '🏭 產業筆記', data: 'memo|IND', displayText: '存成產業筆記' } });
  items.push({ type: 'action', action: { type: 'postback', label: '不用存', data: 'memo|NO', displayText: '不用存' } });
  const head = found.length > 1 ? '📝 這段筆記提到 ' + found.map(memoLabel).join('、') + '，要存到哪裡？'
    : '📝 這段文字要存成哪檔股票的筆記？';
  return { type: 'text', text: head + '\n點下面的按鈕，或直接輸入股號（例如 3167、NVDA）。6 小時內有效。', quickReply: { items: items.slice(0, 13) } };
}

function memoPostback(parts) {
  const body = memoPending();
  if (parts[0] === 'UNDO') return memoUndo();
  if (!body) return text('找不到要存的筆記（超過 6 小時或已經存過了），請再傳一次。');
  if (parts[0] === 'NO') { memoClear(); return text('好，這段文字不存。'); }
  if (parts[0] === 'TYPE') return text('請直接打股號或股名，例如：3167、大量、聯發科、NVDA。');
  if (parts[0] === 'IND') return askIndustry('MEMO', '這段筆記');
  if (parts[0] === 'ALL') return saveMemoPending(findMemoTargets(body));
  if (parts[0] === 'I') return saveMemoPending([{ type: 'industry', sub: parts.slice(1).join('|') }]);
  const code = resolveCode(parts[1], getStockMap());
  if (!code) return text('查不到股號「' + parts[1] + '」。');
  return saveMemoPending([{ type: 'stock', code: code, name: stockName(code) }]);
}

function saveMemoPending(targets) {
  const body = memoPending();
  if (!body) return text('找不到要存的筆記（超過 6 小時或已經存過了），請再傳一次。');
  memoClear();
  return saveMemo(targets, body);
}

// 寫進筆記文件（最新在最上面）＋上傳紀錄（讓「報告」知道有新資料）
function saveMemo(targets, body) {
  targets = (targets || []).filter(Boolean);
  if (!targets.length) { memoSetPending(body); return memoPicker([]); }
  const lock = LockService.getScriptLock();
  lock.waitLock(LONG_LOCK_MS);
  let r;
  try { r = saveMemoCore(targets.slice(0, 6), body); }
  finally { lock.releaseLock(); }
  memoCache().put('MEMO_LAST_' + CUR_UID, JSON.stringify({ undo: r.undo, body: body, targets: r.done }), MEMO_CACHE_SEC);
  setLastAction('memo');
  return memoSavedMsg(r.done, '📝 已存成筆記：' + r.done.map(memoLabel).join('、') + '（' + String(body).length + ' 字）');
}

// 實際寫入（呼叫的人要自己拿鎖）
function saveMemoCore(targets, body) {
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const who = memberName(CUR_UID);
  const done = [], undo = [];
  {
    const log = getLogSheet();
    targets.forEach(function (tg) {
      const folder = targetFolder(tg).folder;
      const title = (tg.type === 'industry' ? IND_CODE_PREFIX + tg.sub : tg.code) + MEMO_SUFFIX;
      const it = folder.getFilesByName(title);
      let doc;
      if (it.hasNext()) doc = DocumentApp.openById(it.next().getId());
      else {
        doc = DocumentApp.create(title);
        DriveApp.getFileById(doc.getId()).moveTo(folder);
        const p0 = doc.getBody().getChild(0).asParagraph();   // v2.9 setText 不會回傳段落，不能串接
        p0.setText(memoLabel(tg) + '｜我的筆記（LINE 自動整理，最新在最上面）');
        p0.setHeading(DocumentApp.ParagraphHeading.TITLE);
      }
      const b = doc.getBody();
      const header = '🗓 ' + stamp + '｜' + who;
      const lines = String(body).split(/\r?\n/);
      b.insertParagraph(1, header).setHeading(DocumentApp.ParagraphHeading.HEADING3);
      lines.forEach(function (ln, i) { b.insertParagraph(2 + i, ln).setHeading(DocumentApp.ParagraphHeading.NORMAL); });
      b.insertHorizontalRule(2 + lines.length);
      doc.saveAndClose();
      appendLog(log, [now(), '（LINE 文字筆記）' + String(body).slice(0, 40), title, categoryLabel(tg), folder.getName(), '我的筆記', today(), '已歸檔', doc.getId(), 'memo:' + stamp + ':' + (tg.code || tg.sub), who]);
      done.push(tg);
      undo.push({ id: doc.getId(), header: header, n: lines.length + 2 });
    });
  }
  return { done: done, undo: undo };
}

function memoSavedMsg(done, head) {
  const msg = text(head + '\n下次做整合報告會一起讀，並回應你筆記裡的疑問。\n存錯了？按「✏️ 存錯了，改」，或打「改 股號／股名」（例如：改 2454、改 聯發科）。');
  const items = [];
  done.slice(0, 4).forEach(function (tg) {
    const isInd = tg.type === 'industry';
    items.push({ type: 'action', action: { type: 'postback', label: ('更新 ' + (isInd ? tg.sub : cn(tg.code)) + ' 報告').slice(0, 20),
      data: 'rpt|' + (isInd ? IND_CODE_PREFIX + tg.sub : tg.code), displayText: '報告 ' + (isInd ? '產業 ' + tg.sub : cn(tg.code)) } });
  });
  items.push({ type: 'action', action: { type: 'postback', label: '✏️ 存錯了，改', data: 'memo|UNDO', displayText: '筆記存錯了' } });
  msg.quickReply = { items: items };
  return msg;
}

// 存錯了：把剛剛那則從文件拿掉，重新問要存哪裡
function memoUndo() {
  const last = safeJson(memoCache().get('MEMO_LAST_' + CUR_UID));
  if (!last.undo || !last.undo.length) return text('找不到剛剛的筆記（超過 6 小時了），請到雲端文件手動修改。');
  last.undo.forEach(function (u) {
    try {
      const doc = DocumentApp.openById(u.id), b = doc.getBody();
      if (b.getNumChildren() > u.n && b.getChild(1).asText().getText() === u.header) {
        for (let i = 0; i < u.n; i++) b.removeChild(b.getChild(1));
        doc.saveAndClose();
      }
    } catch (e) { console.warn('筆記復原失敗：' + e); }
  });
  memoCache().remove('MEMO_LAST_' + CUR_UID);
  memoSetPending(last.body);
  return memoPicker(findMemoTargets(last.body));
}


// ===== v2.4 內容辨識（檔名看不出股票時）=====
const OCR_MAX_PER_MSG = 6;          // 一次最多辨識幾個檔案（避免 LINE 回覆逾時）
const OCR_MAX_BYTES = 8 * 1024 * 1024;

// 回傳 { target, hit, candidates, head }
function guessFromContent(blob, kind, map) {
  const out = { target: null, hit: '', candidates: [], head: '' };
  let txt = '';
  try {
    if (kind === 'text') txt = blob.getDataAsString('UTF-8');
    else if (blob.getBytes().length <= OCR_MAX_BYTES) txt = ocrText(blob, kind);
  } catch (e) { console.warn('內容辨識失敗：' + e); return out; }
  txt = String(txt || '').replace(/ /g, ' ');
  if (!txt.trim()) return out;
  // v2.5 一張圖／一份 PDF 是很多檔股票的整理（例如外電綜合整理）→ 交給呼叫端拆開
  const sp = splitSegments(txt);
  if (sp.segs.length >= 2) { out.split = sp; out.text = txt; return out; }
  // 只看開頭：報告／貼文的主角通常在最前面，後面常提到同業
  const head = txt.slice(0, 1200);
  out.head = head;
  const rk = rankStocks([{ text: txt.slice(0, 200), w: 2 }, { text: txt.slice(200, 1200), w: 1 }], map);
  const pick = rankDecide(rk);
  if (pick) { out.target = { type: 'stock', code: pick, name: map[pick] || stockName(pick) }; out.hit = pick + ' ' + (map[pick] || stockName(pick)); return out; }
  if (rk.length) { out.candidates = rk.slice(0, 5).map(function (x) { return x.code; }); return out; }
  const st = { candidates: [] };
  // 沒有股號：用公司名稱（3 個字以上直接採用；2 個字的只當按鈕建議）
  const names = [];
  Object.keys(map).forEach(function (c) {
    const nm = String(map[c] || '').replace(/-KY$|\*$/, '');
    if (nm.length >= 2 && /^\d{4}$/.test(c) && head.indexOf(nm) >= 0) names.push({ c: c, nm: nm, pos: head.indexOf(nm) });
  });
  names.sort(function (a, b) { return a.pos - b.pos; });
  const strong = names.filter(function (x) { return x.nm.length >= 3; });
  if (strong.length && (strong.length === 1 || strong[0].pos < 40)) {
    out.target = { type: 'stock', code: strong[0].c, name: map[strong[0].c] };
    out.hit = strong[0].c + ' ' + map[strong[0].c] + '（公司名）';
    return out;
  }
  const us = detectUSTicker(head);
  if (us) { out.target = { type: 'stock', code: us, name: stockName(us) }; out.hit = us + ' ' + stockName(us); return out; }
  out.candidates = (st.candidates || []).concat(names.map(function (x) { return x.c; })).filter(function (c, i, a) { return a.indexOf(c) === i; }).slice(0, 5);
  return out;
}

// 用 Google 雲端硬碟內建的文字辨識：上傳成 Google 文件（會自動 OCR）→ 讀文字 → 刪掉暫存檔
// 不需要另外開啟進階服務，用的是 DriveApp 原本就有的權限
function ocrText(blob, kind) {
  const token = ScriptApp.getOAuthToken();
  const boundary = 'ocr' + Date.now();
  const meta = { name: '_ocr_tmp_' + Date.now(), mimeType: 'application/vnd.google-apps.document',
    parents: [getOrCreateChild(rootFolder(), SYSTEM_FOLDER).folder.getId()] };
  const mime = blob.getContentType() || (kind === 'pdf' ? 'application/pdf' : 'image/jpeg');
  const pre = Utilities.newBlob('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
    '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n').getBytes();
  const post = Utilities.newBlob('\r\n--' + boundary + '--').getBytes();
  const res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=zh-TW&fields=id', {
    method: 'post', contentType: 'multipart/related; boundary=' + boundary,
    payload: pre.concat(blob.getBytes()).concat(post),
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('OCR ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 150));
  const id = JSON.parse(res.getContentText()).id;
  let txt = '';
  try { txt = DocumentApp.openById(id).getBody().getText(); }
  finally {
    UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id, { method: 'delete', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  }
  return txt;
}


// ===== v2.5 一則內容提到很多檔股票 → 拆成各公司的筆記 =====
const DIGEST_FOLDER = '綜合整理';
// 找「段落開頭」的股票：「- 4958臻鼎：」「【2330 台積電】」「台積電：」「$NVDA:」
function splitSegments(text) {
  const out = { header: '', segs: [] };
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length < 3) return out;
  const map = getStockMap();
  const nameIdx = {};
  Object.keys(map).forEach(function (c) { if (/^\d{4}$/.test(c)) { const n = String(map[c] || '').replace(/-KY$|\*$/, ''); if (n.length >= 2) nameIdx[n] = c; } });
  const bullet = '^[\\s\\-–—‧•・·*＊>#▶►◆■□●○◎★☆【\\[（(]*\\s*';
  const reCode = new RegExp(bullet + '(\\d{4})(?![\\d年月日%])\\s*([^\\s：:】\\]）)｜|]{0,10})?\\s*[】\\]）)]?\\s*([：:｜|]|[-–—]\\s)');
  const reName = new RegExp(bullet + '([^\\s：:】\\]）)｜|\\d]{2,8})\\s*[】\\]）)]?\\s*[：:｜|]');
  const reUS = /^[\s\-–—‧•・·*＊]*\$?([A-Z]{1,5})\s*[：:]/;
  const starts = [];
  lines.forEach(function (ln, i) {
    if (ln.trim().length > 60 && !/^[\s\-–—‧•・·*＊【\[]/.test(ln)) return;   // 長句子中間提到的不算段落開頭
    let m = ln.match(reCode);
    if (m && map[m[1]]) { starts.push({ i: i, code: m[1] }); return; }
    m = ln.match(reName);
    if (m) { const nm = m[1].replace(/-KY$/, ''); if (nameIdx[nm]) { starts.push({ i: i, code: nameIdx[nm] }); return; } }
    m = ln.match(reUS);
    if (m && !US_STOP[m[1]] && getUSMap()[m[1]]) starts.push({ i: i, code: m[1] });
  });
  const distinct = starts.map(function (x) { return x.code; }).filter(function (c, i, a) { return a.indexOf(c) === i; });
  if (distinct.length < 2) return out;
  out.header = lines.slice(0, starts[0].i).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const by = {};
  starts.forEach(function (st, k) {
    const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
    const seg = lines.slice(st.i, end).join('\n').trim();
    if (!by[st.code]) { by[st.code] = []; out.segs.push({ code: st.code }); }
    by[st.code].push(seg);
  });
  out.segs.forEach(function (sg) { sg.name = stockName(sg.code); sg.text = by[sg.code].join('\n\n'); });
  out.segs = out.segs.slice(0, 15);
  return out;
}

// noLock＝呼叫端已經拿著鎖（處理檔案／網頁時）
function saveSplitMemo(sp, fullBody, extra, noLock) {
  const lock = LockService.getScriptLock();
  if (!noLock) lock.waitLock(LONG_LOCK_MS);
  const done = [], undo = [];
  try {
    sp.segs.forEach(function (sg) {
      const body = (sp.header ? '〔' + sp.header + '〕\n' : '〔綜合整理〕\n') + sg.text + (extra || '');
      const r = saveMemoCore([{ type: 'stock', code: sg.code, name: sg.name }], body);
      Array.prototype.push.apply(done, r.done); Array.prototype.push.apply(undo, r.undo);
    });
  } finally { if (!noLock) lock.releaseLock(); }
  memoCache().put('MEMO_LAST_' + CUR_UID, JSON.stringify({ undo: undo, body: fullBody, split: true }), MEMO_CACHE_SEC);
  if (!noLock) setLastAction('memo');
  return memoSavedMsg(done, '📝 拆成 ' + done.length + ' 則筆記，存到各公司：\n' + done.map(function (tg) { return '・' + memoLabel(tg); }).join('\n'));
}


// ===== v2.6 判斷準確率：多個地方一起打分數 =====
// v2.9 股名剛好是常見詞的，只在旁邊有股號時才算
const COMMON_WORD_NAMES = { '大量': 1, '統一': 1, '中興': 1, '全新': 1, '新興': 1, '聯合': 1, '中華': 1, '精華': 1, '大同': 1, '合一': 1,
  '大成': 1, '世界': 1, '和平': 1, '第一': 1, '美食': 1, '光明': 1, '先進': 1, '開發': 1, '合作': 1, '安心': 1, '亞洲': 1, '台灣': 1,
  '中國': 1, '東南': 1, '國際': 1, '正達': 1, '如興': 1, '信義': 1, '華夏': 1, '大眾': 1, '南光': 1, '同致': 1,
  '天剛': 1, '聯傑': 1, '力麗': 1, '萬洲': 1, '永信': 1, '尖點': 1, '新光': 1, '上曜': 1 };
// parts：[{ text, w }]，w＝權重（網址、標題比內文可靠）；回傳 [{ code, score }] 由高到低
function rankStocks(parts, map) {
  const score = {};
  const add = function (c, v) { score[c] = (score[c] || 0) + v; };
  const names = [];
  Object.keys(map).forEach(function (c) {
    if (!/^\d{4,6}[A-Z]?$/.test(c)) return;
    const n = String(map[c] || '').replace(/-KY$|\*$/, '');
    if (n.length >= 2) names.push({ c: c, n: n });
  });
  parts.forEach(function (p) {
    const t = String(p.text || '');
    if (!t.trim()) return;
    const seenHere = {};
    let firstPos = 1e9, firstCode = null;
    const mark = function (c, pos) { if (pos < firstPos) { firstPos = pos; firstCode = c; } };
    // 股號（排除年份、日期、金額、百分比）
    const re = /(?<![0-9A-Za-z.])(\d{4})(?![0-9.%億萬元張年月日季QHqh\-\/／])/g;
    let m;
    while ((m = re.exec(t))) {
      const c = m[1];
      if (!map[c]) continue;
      const nm = String(map[c]).replace(/-KY$|\*$/, '');
      const near = t.slice(Math.max(0, m.index - 12), m.index + 16);
      const withName = near.indexOf(nm) >= 0;
      if (+c >= 1990 && +c <= 2039 && !withName) continue;   // 多半是年份
      if (seenHere['c' + c]) continue;
      seenHere['c' + c] = 1;
      add(c, (withName ? 9 : 3) * p.w);   // 「台積電(2330)」「2330 台積電」最可靠
      mark(c, m.index);
    }
    // 公司名稱
    names.forEach(function (x) {
      if (seenHere['n' + x.c] || t.indexOf(x.n) < 0) return;
      if (COMMON_WORD_NAMES[x.n]) return;   // 「大量出貨」「統一規格」這類一般用詞不算（寫股號就會算）
      seenHere['n' + x.c] = 1;
      add(x.c, (x.n.length >= 3 ? 3 : 2) * p.w);
      mark(x.c, t.indexOf(x.n));
    });
    if (firstCode) add(firstCode, 1 * p.w);   // 最先被提到的通常是主角
  });
  return Object.keys(score).map(function (c) { return { code: c, score: score[c] }; })
    .sort(function (a, b) { return b.score - a.score; });
}

// 分數 ≥ 6 且是第二名的 2 倍以上才自動歸檔，否則跳按鈕問你（寧可多問一次，也不要分錯）
function rankDecide(rk, min) {
  if (!rk.length || rk[0].score < (min || 6)) return null;
  if (rk.length > 1 && rk[0].score < rk[1].score * 2) return null;
  return rk[0].code;
}

// 網址裡常見的股票代號寫法（Yahoo 股市 /quote/2330、鉅亨 /twstock/2330、?stock_id=2330、/2330.TW）
function urlStockHints(url) {
  const u = decodeURIComponent(String(url || ''));
  const out = [];
  const pats = [/\/quote\/(\d{4,6})/i, /twstock\/(\d{4,6})/i, /[?&](?:stock_?id|symbol|stockno|code|s)=(\d{4,6})/i, /\/(\d{4,6})\.TWO?\b/i, /\/stock\/(\d{4,6})\b/i];
  pats.forEach(function (re) { const m = u.match(re); if (m) out.push(m[1] + ' ' + (getStockMap()[m[1]] || '')); });
  return out.join(' ');
}

function nameToCode(s) {
  const map = getStockMap();
  const t = String(s || '').trim();
  let hit = null;
  Object.keys(map).some(function (c) { const n = String(map[c] || ''); if (n === t || n.replace(/-KY$|\*$/, '') === t) { hit = c; return true; } return false; });
  return hit;
}

// ===== v2.6 分錯了一鍵改 =====
function setLastAction(kind) { CacheService.getScriptCache().put('LAST_ACT_' + CUR_UID, kind, 6 * 3600); }
function lastAction() { return CacheService.getScriptCache().get('LAST_ACT_' + CUR_UID); }
function rememberSaved(ids, cands) {
  setLastAction('file');
  CacheService.getScriptCache().put('LAST_SAVED_' + CUR_UID, JSON.stringify({ ids: ids.slice(0, 30), cands: (cands || []).filter(function (c, i, a) { return a.indexOf(c) === i; }).slice(0, 6), ts: Date.now() }), 6 * 3600);
}
function lastSaved() { const v = safeJson(CacheService.getScriptCache().get('LAST_SAVED_' + CUR_UID)); return v.ids && v.ids.length ? v : null; }

function fixPostback(parts) {
  const last = lastSaved();
  if (!last) return text('找不到剛剛存的檔案（超過 6 小時了），請到雲端資料夾手動移動。');
  if (parts[0] === 'IND') return askIndustry('FIX', '剛剛的檔案');
  if (parts[0] === 'S') {
    const code = resolveCode(parts[1], getStockMap());
    return text(code ? moveLastSaved({ type: 'stock', code: code, name: stockName(code) }) : '查不到股號。');
  }
  // ASK：跳選單（剛剛判斷到的其他候選＋常用資料夾）
  const items = [], seen = {};
  const map = getStockMap();
  last.cands.concat(listStockFolders().slice(0, 8).map(function (f) { return f.code; })).forEach(function (c) {
    if (seen[c] || items.length >= 10) return;
    seen[c] = 1;
    const label = (c + ' ' + (map[c] || stockName(c))).trim();
    items.push({ type: 'action', action: { type: 'postback', label: ('➡️ ' + label).slice(0, 20), data: 'fix|S|' + c, displayText: '改到 ' + label } });
  });
  items.push({ type: 'action', action: { type: 'postback', label: '🏭 改成產業', data: 'fix|IND', displayText: '改成產業' } });
  return { type: 'text', text: '剛剛存的 ' + last.ids.length + ' 個檔案要改到哪裡？\n點下面的股票，或直接打「改 股號」（例如：改 3167、改 NVDA、改 產業 記憶體）。', quickReply: { items: items } };
}

// 把剛剛存的檔案（含「（轉檔）」可讀版）搬到新的資料夾、改檔名開頭、更新上傳紀錄
function moveLastSaved(target) {
  const last = lastSaved();
  if (!last) return '找不到剛剛存的檔案（超過 6 小時了），請到雲端資料夾手動移動。';
  const lock = LockService.getScriptLock();
  lock.waitLock(LONG_LOCK_MS);
  const moved = [];
  try {
    const fr = targetFolder(target);
    const prefix = target.type === 'industry' ? INDUSTRY_FOLDER + '_' + target.sub : target.code;
    const log = getLogSheet();
    const rename = function (n) {
      const r = n.replace(/^(產業_[^_]+|\d{4,6}[A-Z]?|[A-Z][A-Z.]{0,6})_/, prefix + '_');
      return r === n ? prefix + '_' + n : r;
    };
    last.ids.forEach(function (id) {
      let f;
      try { f = DriveApp.getFileById(id); } catch (e) { return; }
      const oldName = f.getName();
      const parents = f.getParents();
      const oldFolder = parents.hasNext() ? parents.next() : null;
      const newName = uniqueName(fr.folder, rename(oldName));
      f.moveTo(fr.folder); f.setName(newName);
      updateLogByFileId(log, id, { newName: newName, category: categoryLabel(target), folder: fr.folder.getName(), status: '已歸檔' });
      moved.push(newName);
      // 一起搬「（轉檔）」可讀版
      if (oldFolder) {
        const base = oldName.replace(/\.[A-Za-z0-9]{1,5}$/, '');
        const it = oldFolder.getFiles();
        while (it.hasNext()) {
          const g = it.next();
          if (g.getName() === base + '（轉檔）') { g.moveTo(fr.folder); g.setName(newName.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '（轉檔）'); }
        }
      }
    });
    CacheService.getScriptCache().remove('LAST_SAVED_' + CUR_UID);
    return '✅ 已改到「' + fr.folder.getName() + '」：\n' + moved.map(function (n) { return '・' + n; }).join('\n');
  } finally {
    lock.releaseLock();
  }
}


// ===== v2.7 用股名找股票 =====
// exactOnly＝只接受完全相同（單獨打股名時用，避免把一般句子當股名）
function findStockByName(s, exactOnly) {
  const map = getStockMap();
  const q = String(s || '').trim().replace(/\s+/g, '').replace(/(-?KY|\*)$/i, '');
  if (q.length < 2) return [];
  const codes = Object.keys(map).filter(function (c) { return /^\d{4,6}[A-Z]?$/.test(c); });
  const norm = function (c) { return String(map[c] || '').replace(/\s+/g, '').replace(/(-?KY|\*)$/i, ''); };
  let hit = codes.filter(function (c) { return norm(c) === q; });
  if (hit.length || exactOnly) return hit.filter(function (c) { return /^\d{4}$/.test(c); }).concat(hit.filter(function (c) { return !/^\d{4}$/.test(c); })).slice(0, 8);
  hit = codes.filter(function (c) { return /^\d{4}$/.test(c) && norm(c).indexOf(q) === 0; });          // 開頭相同：「台積」→ 台積電
  if (!hit.length) hit = codes.filter(function (c) { return /^\d{4}$/.test(c) && norm(c).indexOf(q) > 0; });   // 包含
  return hit.slice(0, 8);
}

// 股號或股名 → { code } 或 { list, msg }（好幾檔時）
function pickStock(input) {
  const code = resolveCode(input, getStockMap());
  if (code) return { code: code };
  const hits = findStockByName(input);
  if (hits.length === 1) return { code: hits[0] };
  if (hits.length > 1) return { list: hits, msg: '「' + input + '」符合好幾檔，是哪一檔？' };
  return {};
}

function stockChoiceMsg(codes, verb, head) {
  const map = getStockMap();
  const items = codes.slice(0, 12).map(function (c) {
    const label = (verb + ' ' + c + ' ' + (map[c] || '')).trim();
    if (verb === '報告') return { type: 'action', action: { type: 'postback', label: label.slice(0, 20), data: 'rpt|' + c, displayText: '報告 ' + c } };
    return { type: 'action', action: { type: 'message', label: label.slice(0, 20), text: verb + ' ' + c } };
  });
  return { type: 'text', text: head + '\n' + codes.map(function (c) { return '・' + c + ' ' + (map[c] || ''); }).join('\n'), quickReply: { items: items } };
}


// ===== v2.9 共用：股號一律附股名 =====
function cn(code, name) {
  code = String(code || '');
  const n = name || stockName(code);
  return n && String(n).indexOf(code) !== 0 ? code + ' ' + n : (n || code);
}

// 剛剛存的筆記直接搬到別檔（不用再選一次）
function memoMoveTo(target) {
  const last = safeJson(memoCache().get('MEMO_LAST_' + CUR_UID));
  if (!last.undo || !last.undo.length) return text('找不到剛剛的筆記（超過 6 小時了），請到雲端文件手動修改。');
  if (last.split) { memoUndo(); return memoPicker([target]); }   // 拆成多則的，改用選單確認
  last.undo.forEach(function (u) {
    try {
      const doc = DocumentApp.openById(u.id), b = doc.getBody();
      if (b.getNumChildren() > u.n && b.getChild(1).asText().getText() === u.header) {
        for (let i = 0; i < u.n; i++) b.removeChild(b.getChild(1));
        doc.saveAndClose();
      }
    } catch (e) { console.warn('筆記搬移失敗：' + e); }
  });
  memoCache().remove('MEMO_LAST_' + CUR_UID);
  const m = saveMemo([target], last.body);
  m.text = m.text.replace(/^📝 已存成筆記/, '✅ 已改存到');
  return m;
}


// ===== v2.10 自動報告標示 =====
const AUTO_NOTE = '選股訊號自動';
function isAutoJob(j) { return String(j.note || '').indexOf(AUTO_NOTE) >= 0; }
function autoReason(j) {
  const when = j.created ? fmtShort(j.created) : '';
  return '🤖 這份不是你要求的：選股系統在 ' + when + ' 偵測到 ' + j.code + ' ' + j.name + ' 突破買進訊號，自動幫你排的。不需要可以傳「自動報告 關」。';
}

let CUR_SRC = '';
function jobSource(note, uid) {
  const when = Utilities.formatDate(new Date(), TZ, 'MM/dd HH:mm');
  if (String(note || '').indexOf(AUTO_NOTE) >= 0) return '🤖 選股系統突破訊號自動（' + when + '）';
  return (uid ? memberName(uid) : '?') + ' ' + (CUR_SRC || '其他') + '（' + when + '）';
}


// ===== v2.11 獨立的小鎖（只跟自己排隊）=====
function cacheMutex(name, maxSec) {
  const c = CacheService.getScriptCache(), key = 'MUTEX_' + name, me = Utilities.getUuid();
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const cur = c.get(key);
    if (!cur) { c.put(key, me, maxSec); Utilities.sleep(150); if (c.get(key) === me) break; }
    Utilities.sleep(1000);
  }
  return { releaseLock: function () { if (c.get(key) === me) c.remove(key); } };
}

// LINE 推播額度（免費方案每月 200 則；回覆不算額度）
function quotaText() {
  try {
    const tk = prop('LINE_CHANNEL_ACCESS_TOKEN');
    const h = { Authorization: 'Bearer ' + tk };
    const q = JSON.parse(UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota', { headers: h, muteHttpExceptions: true }).getContentText());
    const u = JSON.parse(UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: h, muteHttpExceptions: true }).getContentText());
    const limit = q.type === 'limited' ? q.value : '無上限';
    const used = u.totalUsage;
    const warn = q.type === 'limited' && used >= q.value ? '\n⚠️ 本月額度已用完：每日摘要、選股推播、報告完成通知會收不到，直到下個月 1 號。' : '';
    return '📮 LINE 推播額度：本月已用 ' + used + ' ／ ' + limit + ' 則' + warn + '\n（你傳訊息後我「回覆」不算額度；推播＝我主動傳，例如摘要、報告完成）';
  } catch (e) {
    return '查不到額度：' + String(e.message || e).slice(0, 100);
  }
}


// ===== v2.12 X 貼文完整版 =====
function fetchXPostFull(url) {
  const m = String(url).match(/(?:x|twitter)\.com\/([^\/?#]+)\/status\/(\d+)/i);
  if (!m) return null;
  const esc = function (x) { return String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); };
  let post = null;
  // 1) FxTwitter
  try {
    const r = UrlFetchApp.fetch('https://api.fxtwitter.com/' + m[1] + '/status/' + m[2], { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.getResponseCode() === 200) {
      const t = JSON.parse(r.getContentText()).tweet;
      if (t && t.text) {
        const ph = function (x) { return ((x && x.media && (x.media.photos || x.media.all)) || []).filter(function (p) { return !p.type || p.type === 'photo'; }).map(function (p) { return p.url; }); };
        post = { author: (t.author && (t.author.name + ' @' + t.author.screen_name)) || m[1], date: t.created_at || '', text: t.text, photos: ph(t),
          quote: t.quote ? { author: t.quote.author ? t.quote.author.name + ' @' + t.quote.author.screen_name : '', text: t.quote.text || '', photos: ph(t.quote) } : null };
      }
    }
  } catch (e) { console.warn('FxTwitter 失敗：' + e); }
  // 2) VxTwitter
  if (!post) {
    try {
      const r = UrlFetchApp.fetch('https://api.vxtwitter.com/' + m[1] + '/status/' + m[2], { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.getResponseCode() === 200) {
        const d = JSON.parse(r.getContentText());
        if (d && d.text) post = { author: (d.user_name || '') + ' @' + (d.user_screen_name || m[1]), date: d.date || '', text: d.text,
          photos: (d.mediaURLs || []).filter(function (u) { return /\.(jpe?g|png|webp)/i.test(u); }),
          quote: d.qrt ? { author: (d.qrt.user_name || '') + ' @' + (d.qrt.user_screen_name || ''), text: d.qrt.text || '', photos: (d.qrt.mediaURLs || []).filter(function (u) { return /\.(jpe?g|png|webp)/i.test(u); }) } : null };
      }
    } catch (e) { console.warn('VxTwitter 失敗：' + e); }
  }
  if (!post) return null;
  // 圖片：嵌進文件，並用文字辨識把圖上的字也存下來（像券商報告截圖），最多 3 張（避免 LINE 回覆逾時）
  const photos = post.photos.concat(post.quote ? post.quote.photos : []).slice(0, 3);
  const ocrParts = [];
  photos.forEach(function (u, i) {
    try {
      const b = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
      if (b.getResponseCode() !== 200) return;
      const tx = ocrText(b.getBlob().setName('x_' + i + '.jpg'), 'image');
      if (tx && tx.trim().length > 20) ocrParts.push('<p><b>🖼 圖片 ' + (i + 1) + ' 的文字（自動辨識，可能有錯字）：</b><br>' + esc(tx.trim().slice(0, 4000)) + '</p>');
    } catch (e) { console.warn('X 圖片辨識失敗：' + e); }
  });
  const html = '<html><head><title>X貼文 ' + esc(post.author) + '</title></head><body>' +
    '<p><b>' + esc(post.author) + '</b>　' + esc(post.date) + '</p><p>' + esc(post.text) + '</p>' +
    (post.quote ? '<blockquote><p><b>引用：' + esc(post.quote.author) + '</b></p><p>' + esc(post.quote.text) + '</p></blockquote>' : '') +
    photos.map(function (u) { return '<p><img src="' + u + '" style="max-width:600px"></p>'; }).join('') +
    ocrParts.join('') + '</body></html>';
  const note = '✅ 已抓 X 完整貼文（' + post.text.length + ' 字' + (post.quote ? '＋引用貼文' : '') + (photos.length ? '＋' + photos.length + ' 張圖' + (ocrParts.length ? '，圖上的字也辨識存下來了' : '') : '') + '）';
  return { html: html, note: note };
}


// v2.14 一鍵更新改由「啟動程式」（Apps Script 裡的 Code.gs）負責；這份主程式放在 GitHub 的 gas/Code.gs
const APP_VERSION = 'v2.15';

// ===== v2.13 清理暫存屬性（指令碼屬性超過 50 個時，畫面會變唯讀）=====
function cleanupProps() {
  const all = props().getProperties();
  const pending = getChildIfExists(rootFolder(), PENDING_FOLDER);
  const pendIds = {};
  if (pending) { const it = pending.getFiles(); while (it.hasNext()) pendIds[it.next().getId()] = 1; }
  let n = 0;
  Object.keys(all).forEach(function (k) {
    let del = false;
    if (/^(NEXT_TARGET_|AWAIT_IND_|PGROUP_OPEN_)/.test(k)) { const v = safeJson(all[k]); del = !v.ts || Date.now() - v.ts > 86400000; }
    else if (/^PGROUP_G/.test(k)) del = !safeJsonArr(all[k]).some(function (id) { return pendIds[id]; });   // 這組檔案都已分類完
    else if (/^PGIND_G/.test(k)) del = !all['PGROUP_' + k.slice(6)];
    if (del) { props().deleteProperty(k); n++; }
  });
  console.log('清理暫存屬性：刪除 ' + n + ' 個，剩 ' + (Object.keys(all).length - n) + ' 個');
  return n;
}


// ===== v2.15 同步上修雷達：同一個題材，7 天內有 2 家以上公司出現「上修」消息 → 產業可能有變化 =====
const REVISION_UP = /(上修|調升|上調|調高|上看|優於預期|超乎預期|財測上修|目標價.{0,6}(上調|調升|調高))/;
const REVISION_DOWN = /(下修|調降|下調|調低|不如預期|低於預期)/;
function revisionClusters(days) {
  const since = Date.now() - (days || 7) * 86400000;
  const rows = feedRecent((days || 7) + 1).filter(function (x) { return feedTime(x.d) >= since; });
  const res = {};
  rows.forEach(function (x) {
    const up = REVISION_UP.test(x.text), dn = REVISION_DOWN.test(x.text) && !up;
    if (!up && !dn) return;
    const kind = up ? 'up' : 'down';
    const ths = String(x.themes || '').split(/[、,，\s]+/).filter(Boolean);
    (ths.length ? ths : ['（無題材）']).forEach(function (th) {
      const k = kind + '|' + th;
      res[k] = res[k] || { kind: kind, theme: th, stocks: {} };
      res[k].stocks[x.code] = x;
    });
  });
  return Object.keys(res).map(function (k) { return res[k]; })
    .filter(function (r) { return r.theme !== '（無題材）' && Object.keys(r.stocks).length >= 2; })
    .sort(function (a, b) { return (a.kind === 'up' ? 0 : 1) - (b.kind === 'up' ? 0 : 1) || Object.keys(b.stocks).length - Object.keys(a.stocks).length; });
}
function revisionClusterText() {
  const cl = revisionClusters(7).slice(0, 5);
  if (!cl.length) return '';
  return '🔺 同步上下修（7 天內同題材 2 家以上，可能有產業變化）\n' + cl.map(function (r) {
    const names = Object.keys(r.stocks).slice(0, 4).map(function (c) { return c + ' ' + r.stocks[c].name; }).join('、');
    return (r.kind === 'up' ? '🔺 上修｜' : '🔻 下修｜') + r.theme + '：' + names;
  }).join('\n') + '\n（上修看原因：需求端＝週期未到尾；供給端＝可能尾段）';
}
