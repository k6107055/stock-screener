// ================= v2.13 Telegram 機器人：影音解析卡片、待解析清單、每日重點、循環週報、持股重大訊息 =================
// 金鑰都從 Atlas ⚙️ 貼（存在指令碼屬性，不會出現在 GitHub）：TG_TOKEN（@BotFather 給的）、GH_TOKEN（叫 GitHub 解析用）
// 跟你持股有關的對照都在這裡做（Apps Script 是私人的），GitHub 上只放節目內容
const ATLAS_URL = 'https://k6107055.github.io/stock-screener/atlas/';
const MEDIA_RAW = 'https://raw.githubusercontent.com/k6107055/stock-screener/media-data/';
const STAGE_N = ['未知', '訂單回升', '稼動率滿載', '缺貨漲價', '宣布擴產', '新產能量產', '同業產能開出'];

function jget_(k, d) { const v = P(k); if (!v) return d; try { return JSON.parse(v); } catch (e) { return d; } }
function jset_(k, v) { P(k, JSON.stringify(v)); }
function th_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function tgApi_(method, payload, token) {
  const tk = token || P('TG_TOKEN'); if (!tk) return { ok: false };
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + tk + '/' + method, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload || {}) });
  return safeJson(r.getContentText()) || { ok: false };
}
function tgSend_(text, buttons, chat) {
  const p = { chat_id: chat || P('TG_CHAT'), text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (buttons && buttons.length) p.reply_markup = { inline_keyboard: buttons };
  const r = tgApi_('sendMessage', p);
  if (!r.ok) console.warn('Telegram 傳送失敗：' + JSON.stringify(r).slice(0, 300));
  return r;
}

// ---- ⚙️ 設定 ----
function opMediaSet(a) {
  if (a.tg !== undefined) {
    const t = String(a.tg || '').trim();
    if (t) {
      if (!/^\d+:[\w-]{20,}$/.test(t)) throw new Error('Telegram 金鑰格式不對（應該像 123456789:ABCdef…）');
      const me = tgApi_('getMe', {}, t);
      if (!me.ok) throw new Error('Telegram 金鑰無效，請確認是 @BotFather 給的那串');
      P('TG_TOKEN', t); P('TG_BOT', me.result.username);
      tgApi_('deleteWebhook', {});
      setupTgTick_();
    } else { P('TG_TOKEN', ''); P('TG_CHAT', ''); }
  }
  if (a.gh !== undefined) {
    const g = String(a.gh || '').trim();
    if (g) {
      const r = UrlFetchApp.fetch('https://api.github.com/repos/k6107055/stock-screener', { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + g, Accept: 'application/vnd.github+json' } });
      if (r.getResponseCode() !== 200) throw new Error('GitHub 金鑰無效，或沒有 stock-screener 的權限（' + r.getResponseCode() + '）');
      P('GH_TOKEN', g);
      if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'ghKick'; })) ScriptApp.newTrigger('ghKick').timeBased().everyMinutes(30).create();
    } else P('GH_TOKEN', '');
  }
  if (a.unmute) { const m = jget_('TG_MUTE', []).filter(function (x) { return x !== a.unmute; }); jset_('TG_MUTE', m); }
  return opMediaStatus();
}
function opMediaStatus() {
  return { tg: !!P('TG_TOKEN'), bot: P('TG_BOT'), chat: !!P('TG_CHAT'), gh: !!P('GH_TOKEN'), mute: jget_('TG_MUTE', []),
    tick: ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tgTick'; }) };
}
function setupTgTick_() {
  if (ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'tgTick'; })) return;
  ScriptApp.newTrigger('tgTick').timeBased().everyMinutes(1).create();
}
function due_(k, min) { const t = Number(P(k) || 0); if (Date.now() - t < min * 60000) return false; P(k, String(Date.now())); return true; }

// ---- 每分鐘：收按鈕／連結 → 叫 GitHub 解析；解析好的送卡片；清單、每日重點、週報、重大訊息 ----
function tgTick() {
  if (!P('TG_TOKEN')) return;
  const lock = LockService.getScriptLock(); if (!lock.tryLock(500)) return;
  try {
    tgPoll_();
    if (!P('TG_CHAT')) return;
    const now = new Date(), hm = Number(Utilities.formatDate(now, TZ, 'HHmm')), wd = Number(Utilities.formatDate(now, TZ, 'u'));
    const Q = jget_('MEDIA_Q', {});
    const busy = Object.keys(Q).length > 0;
    let idx = null;
    if (due_('TG_T_IDX', busy ? 1 : 3)) { idx = mediaIndex_(); if (idx) { queueCheck_(idx); mediaNotify_(idx, hm); } }
    if (hm >= 700 && hm < 2230 && due_('TG_T_MOPS', 5)) { try { mopsNotify_(); } catch (e) { console.warn('重大訊息通知：' + e); } }
    const day = Utilities.formatDate(now, TZ, 'yyyyMMdd');
    [[1230, 'noon'], [2100, 'eve']].forEach(function (s) {
      if (hm >= s[0] && hm < s[0] + 30 && P('TG_DIG_' + s[1]) !== day) { P('TG_DIG_' + s[1], day); idx = idx || mediaIndex_(); if (idx) { digest_(idx); if (s[1] === 'eve') dayRecap_(idx); } }
    });
    if (wd === 7 && hm >= 2000 && hm < 2030 && P('TG_WEEK') !== day) { P('TG_WEEK', day); weekly_(); }
  } catch (e) { console.warn('tgTick：' + e); } finally { lock.releaseLock(); }
}

function tgPoll_() {
  const off = Number(P('TG_OFF') || 0);
  const r = tgApi_('getUpdates', { offset: off + 1, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  if (!r.ok || !r.result || !r.result.length) return;
  let chat = P('TG_CHAT');
  r.result.forEach(function (u) {
    P('TG_OFF', String(u.update_id));
    const msg = u.message, cb = u.callback_query;
    const cid = String((msg && msg.chat && msg.chat.id) || (cb && cb.message && cb.message.chat.id) || '');
    if (!chat && msg && /^\/start/.test(msg.text || '')) {
      chat = cid; P('TG_CHAT', cid);
      tgSend_('👋 Atlas 小幫手接上了！\n\n之後會收到：\n・🎧📺 自動解析的節目卡片（循環變化、跟你持股有關的會標出來）\n・📋 每天 12:30、21:00 的待解析清單（按「📝 解析」才做）\n・🌙 21:00 今日影音重點、週日 20:00 循環週報\n・📢 持股／自選股的重大訊息\n\n隨時貼 YouTube 或 Apple Podcasts 連結給我，就會幫你完整解析。\n23:00～07:00 不推播，早上一起送。', null, cid);
      return;
    }
    if (!chat || cid !== chat) return;   // 只聽你一個人的
    if (cb) {
      const d = String(cb.data || ''), k = d.slice(0, 1), v = d.slice(2);
      if (k === 'a') { const st = enqueue_([v]); tgApi_('answerCallbackQuery', { callback_query_id: cb.id, text: st }); }
      else if (k === 'm') { const ch = muteToggle_(v); tgApi_('answerCallbackQuery', { callback_query_id: cb.id, text: ch, show_alert: true }); }
      else tgApi_('answerCallbackQuery', { callback_query_id: cb.id });
      return;
    }
    const t = String((msg && (msg.text || msg.caption)) || '');
    const urls = (t.match(/https?:\/\/[^\s<>"]+/g) || []).slice(0, 5);
    if (urls.length) { const st = enqueue_(urls); tgSend_(st + '\n好了會傳卡片給你。'); return; }
    if (/^\/mute/.test(t)) { const m = jget_('TG_MUTE', []); tgSend_(m.length ? '🔕 少推的節目：' + m.map(th_).join('、') + '\n（到 Atlas ⚙️ 可以取消）' : '目前沒有設定少推的節目'); return; }
    if (t) tgSend_('貼 YouTube 或 Apple Podcasts 連結給我，就會幫你完整解析 📝\n/mute 看少推的節目');
  });
}

function enqueue_(keys) {
  const Q = jget_('MEDIA_Q', {});
  keys.forEach(function (k) { if (!Q[k]) Q[k] = { t: Date.now(), n: 0 }; });
  if (!P('GH_TOKEN')) { jset_('MEDIA_Q', Q); return '⚠️ 還沒設定 GitHub 金鑰（Atlas ⚙️），先記下來，設定後就會解析'; }
  const code = ghDispatch_('media.yml', { req: keys.join(',') });
  keys.forEach(function (k) { Q[k].d = Date.now(); Q[k].n++; });
  jset_('MEDIA_Q', Q);
  return code === 204 ? '⏳ 收到！解析中，大約 5～15 分鐘' : '⚠️ 叫 GitHub 失敗（' + code + '），等一下會自動再試';
}
function queueCheck_(idx) {
  const Q = jget_('MEDIA_Q', {}), keys = Object.keys(Q); if (!keys.length) return;
  const by = {}; idx.items.forEach(function (x) { by[x.id] = x; if (x.req) by[x.req] = x; });
  const again = [];
  keys.forEach(function (k) {
    const x = by[k], q = Q[k];
    if (x && x.st === 'done') { delete Q[k]; const s = jget_('MEDIA_FORCE', []); s.push(x.id); jset_('MEDIA_FORCE', s.slice(-30)); return; }
    if (x && x.st === 'err') { delete Q[k]; tgSend_('😵 解析失敗：' + th_(x.title) + '\n' + th_(x.err || '')); return; }
    if (Date.now() - (q.d || 0) > 25 * 60000) { if (q.n >= 3 || Date.now() - q.t > 3 * 3600000) { delete Q[k]; tgSend_('😵 試了幾次都沒解析成功：' + th_(k)); } else again.push(k); }
  });
  jset_('MEDIA_Q', Q);
  if (again.length && P('GH_TOKEN')) { ghDispatch_('media.yml', { req: again.join(',') }); again.forEach(function (k) { Q[k].d = Date.now(); Q[k].n++; }); jset_('MEDIA_Q', Q); }
}
function muteToggle_(id) {
  const idx = mediaIndex_(); const x = idx && idx.items.filter(function (i) { return i.id === id; })[0];
  if (!x) return '找不到這個節目';
  const m = jget_('TG_MUTE', []), i = m.indexOf(x.ch);
  if (i >= 0) { m.splice(i, 1); jset_('TG_MUTE', m); return '🔔 「' + x.ch + '」恢復推播'; }
  m.push(x.ch); jset_('TG_MUTE', m);
  return '🔕 「' + x.ch + '」之後不推卡片（Atlas 影音頁照樣看得到，⚙️ 可取消）';
}

function mediaIndex_() {
  const tk = P('GH_TOKEN');
  const r = tk ? UrlFetchApp.fetch('https://api.github.com/repos/k6107055/stock-screener/contents/index.json?ref=media-data', { muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github.raw' } })
    : UrlFetchApp.fetch(MEDIA_RAW + 'index.json?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return null;
  const j = safeJson(r.getContentText());
  return j && j.items ? j : null;
}
function mineSets_() {
  const hold = {}, watch = allWatchCodes();
  try { buildPositionsCodes().forEach(function (c) { hold[c] = 1; }); } catch (e) { /* 沒關係 */ }
  return { hold: hold, watch: watch };
}

// ---- 解析好的 → 卡片 ----
function mediaNotify_(idx, hm) {
  let sent = jget_('MEDIA_SENT', null);
  const done = idx.items.filter(function (x) { return x.st === 'done'; }).sort(function (a, b) { return a.done < b.done ? -1 : 1; });
  if (!sent) { sent = done.map(function (x) { return x.id; }).slice(0, -2); jset_('MEDIA_SENT', sent); }   // 第一次：只送最新 2 張，不要洗版
  const force = jget_('MEDIA_FORCE', []), mute = jget_('TG_MUTE', []);
  const quiet = hm >= 2300 || hm < 700;
  const cut = Utilities.formatDate(new Date(Date.now() - 2 * 86400000), TZ, "yyyy-MM-dd'T'HH:mm");
  const todo = done.filter(function (x) { return sent.indexOf(x.id) < 0 && (x.done || '') >= cut; });
  if (!todo.length) return;
  const M = mineSets_(), est = estLatestByCode();
  todo.slice(0, 6).forEach(function (x) {
    const asked = force.indexOf(x.id) >= 0;
    if (quiet && !asked) return;                                 // 半夜不吵，早上 7 點再送
    if (mute.indexOf(x.ch) < 0 || asked) { const c = mediaCard_(x, M, est); tgSend_(c.text, c.btn); }
    sent.push(x.id);
  });
  jset_('MEDIA_SENT', sent.slice(-300));
}
function mediaCard_(x, M, est) {
  const ic = x.src === 'pod' ? '🎧' : '📺';
  const L = [ic + ' <b>' + th_(x.ch) + '</b>｜' + th_(x.title) + (x.pub ? ' <i>' + th_(x.pub.slice(5, 10).replace('-', '/')) + '</i>' : '')];
  if (x.one) L.push('💬 ' + th_(x.one));
  const cyc = [];
  (x.chg || []).forEach(function (c) { cyc.push('・' + th_(c.ind) + '：' + STAGE_N[c.from] + ' → <b>' + STAGE_N[c.to] + '</b>' + (c.later ? ' ⚠️往後段' : ' ↩️往前段') + '（上次 ' + th_(c.pch) + ' ' + th_(String(c.pd).slice(5).replace('-', '/')) + '）'); });
  (x.conflict || []).forEach(function (c) { cyc.push('・⚔️ ' + th_(c.ind) + '：這集說「' + STAGE_N[c.me] + '」，' + th_(c.och) + ' ' + th_(String(c.od).slice(5).replace('-', '/')) + ' 說「' + STAGE_N[c.other] + '」'); });
  if (cyc.length) L.push('', (x.alert ? '🔴 <b>必看：循環變化</b>' : '🔄 <b>循環變化</b>'), cyc.join('\n'));
  const mine = (x.stk || []).filter(function (s) { return s.c && (M.hold[s.c] || M.watch[s.c]); });
  if (mine.length) {
    L.push('', '⭐ <b>跟你有關</b>');
    mine.slice(0, 5).forEach(function (s) { const e = est[s.c];
      L.push('・' + th_(s.c + ' ' + s.n) + (M.hold[s.c] ? '（持股）' : '（自選）') + ' ' + th_(s.v) + (e ? '｜法人 ' + th_(e.y) + ' EPS ' + (e.pct > 0 ? '上修 ' : '下修 ') + Math.abs(e.pct) + '%（' + String(e.d).slice(4, 6) + '/' + String(e.d).slice(6) + '）' : '')); });
  }
  if (cyc.length || mine.length) { if ((x.hl || []).length) L.push('', (x.hl || []).slice(0, 3).map(function (h) { return '・' + th_(h); }).join('\n')); }
  else if ((x.tags || []).length) L.push('🏷 ' + x.tags.slice(0, 4).map(th_).join('・'));
  return { text: L.join('\n').slice(0, 3900), btn: [[{ text: '📖 完整筆記', url: ATLAS_URL + '#n=' + x.id }, { text: x.src === 'pod' ? '🎧 原集' : '▶ 原片', url: x.url }], [{ text: '🔕 這個節目少推', callback_data: 'm|' + x.id }]] };
}

// ---- 12:30／21:00 待解析清單（推播＋按鈕那幾個頻道，彙整成一則）----
function digest_(idx) {
  const dig = jget_('MEDIA_DIG', []), mute = jget_('TG_MUTE', []);
  const cut = Utilities.formatDate(new Date(Date.now() - 36 * 3600000), TZ, "yyyy-MM-dd'T'HH:mm");
  const list = idx.items.filter(function (x) { return x.st === 'new' && x.pub >= cut && dig.indexOf(x.id) < 0 && mute.indexOf(x.ch) < 0; }).slice(0, 12);
  if (!list.length) return;
  const L = ['📋 <b>待解析清單</b>（' + list.length + ' 支，想看哪支按「📝 解析」）'];
  list.forEach(function (x, i) { L.push((i + 1) + '. <b>' + th_(x.ch) + '</b>｜<a href="' + th_(x.url) + '">' + th_(x.title.slice(0, 60)) + '</a>'); });
  const btn = list.map(function (x, i) { return [{ text: '📝 解析 ' + (i + 1) + '｜' + x.title.slice(0, 18), callback_data: 'a|' + x.id }]; });
  btn.push([{ text: '📱 Atlas 影音頁', url: ATLAS_URL + '#media' }]);
  tgSend_(L.join('\n'), btn);
  jset_('MEDIA_DIG', dig.concat(list.map(function (x) { return x.id; })).slice(-300));
}

// ---- 21:00 今日影音重點（把好幾集講同一件事的合在一起）----
function dayRecap_(idx) {
  const day = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const today = idx.items.filter(function (x) { return x.st === 'done' && String(x.done || '').slice(0, 10) === day; });
  if (!today.length) return;
  const M = mineSets_();
  const L = ['🌙 <b>今日影音重點</b>（' + day.slice(5).replace('-', '/') + '，解析了 ' + today.length + ' 集）'];
  const ind = {};
  today.forEach(function (x) { (x.inds || []).forEach(function (i) { if (!i.s) return; (ind[i.ind] = ind[i.ind] || []).push({ ch: x.ch, s: i.s }); }); });
  const multi = Object.keys(ind).filter(function (k) { return ind[k].length >= 2; });
  if (multi.length) {
    L.push('', '🗣 <b>好幾集都在談</b>');
    multi.slice(0, 6).forEach(function (k) { const a = ind[k], same = a.every(function (y) { return y.s === a[0].s; });
      L.push('・' + th_(k) + '（' + a.length + ' 集）：' + (same ? '一致認為「' + STAGE_N[a[0].s] + '」' : a.map(function (y) { return th_(y.ch) + '「' + STAGE_N[y.s] + '」'; }).join('／'))); });
  }
  const chg = [].concat.apply([], today.map(function (x) { return (x.chg || []).map(function (c) { c.ch = x.ch; return c; }); }));
  if (chg.length) { L.push('', '🔄 <b>循環變化</b>'); chg.slice(0, 6).forEach(function (c) { L.push('・' + th_(c.ind) + '：' + STAGE_N[c.from] + ' → ' + STAGE_N[c.to] + (c.later ? ' ⚠️' : '') + '（' + th_(c.ch) + '）'); }); }
  const mc = {};
  today.forEach(function (x) { (x.stk || []).forEach(function (s) { if (s.c && (M.hold[s.c] || M.watch[s.c])) (mc[s.c] = mc[s.c] || { n: s.n, v: [] }).v.push(s.v); }); });
  const mk = Object.keys(mc);
  if (mk.length) { L.push('', '⭐ <b>提到你的股票</b>'); mk.slice(0, 8).forEach(function (c) { L.push('・' + th_(c + ' ' + mc[c].n) + '：' + mc[c].v.length + ' 集（' + mc[c].v.map(th_).join('、') + '）'); }); }
  if (L.length === 1) L.push('今天沒有循環變化，也沒提到你的股票 👍');
  tgSend_(L.join('\n'), [[{ text: '📱 打開 Atlas 影音頁', url: ATLAS_URL + '#media' }]]);
}

// ---- 週日 20:00 循環週報 ----
function weekly_() {
  const r = UrlFetchApp.fetch(MEDIA_RAW + 'cycle.json?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) return;
  const rows = safeJson(r.getContentText()) || [];
  const d7 = Utilities.formatDate(new Date(Date.now() - 7 * 86400000), TZ, 'yyyy-MM-dd');
  const by = {};
  rows.forEach(function (x) { (by[x.ind] = by[x.ind] || []).push(x); });
  const L = ['📊 <b>本週循環週報</b>'], lines = [];
  Object.keys(by).forEach(function (k) {
    const a = by[k].sort(function (p, q) { return p.at < q.at ? -1 : 1; });
    const wk = a.filter(function (x) { return x.d >= d7; }); if (!wk.length) return;
    const before = a.filter(function (x) { return x.d < d7; }).pop();
    const last = wk[wk.length - 1];
    const srcs = wk.map(function (x) { return x.ch; }).filter(function (c, i, z) { return z.indexOf(c) === i; });
    const move = before && before.stage !== last.stage ? STAGE_N[before.stage] + ' → <b>' + STAGE_N[last.stage] + '</b>' + (last.stage > before.stage ? ' ⚠️' : '') : '<b>' + STAGE_N[last.stage] + '</b>';
    lines.push([wk.length, '・' + th_(k) + '：' + move + '（' + wk.length + ' 次提到，' + srcs.slice(0, 3).map(th_).join('、') + '）']);
  });
  if (!lines.length) return;
  lines.sort(function (a, b) { return b[0] - a[0]; });
  L.push(lines.slice(0, 12).map(function (x) { return x[1]; }).join('\n'));
  L.push('', '⚠️＝往循環後段移動，要開始想出場條件');
  tgSend_(L.join('\n'), [[{ text: '📱 Atlas 影音頁', url: ATLAS_URL + '#media' }]]);
}

// ---- 持股／自選的重大訊息（觀測站即時）----
function mopsNotify_() {
  const M = mineSets_();
  const day = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const items = opMopsLive().filter(function (x) { return x.d === day && (M.hold[x.c] || M.watch[x.c]); });
  let sent = jget_('MOPS_SENT', null);
  const key = function (x) { return x.c + x.t + x.s.slice(0, 12); };
  if (!sent) { jset_('MOPS_SENT', items.map(key)); return; }
  const fresh = items.filter(function (x) { return sent.indexOf(key(x)) < 0; });
  if (!fresh.length) return;
  const L = ['📢 <b>重大訊息</b>'];
  fresh.slice(0, 8).forEach(function (x) { L.push('<b>' + th_(x.c + ' ' + x.n) + '</b>' + (M.hold[x.c] ? '（持股）' : '') + ' ' + th_(x.t) + ' 〔' + th_(x.ty) + '〕\n' + th_(x.s)); });
  const btn = fresh.filter(function (x) { return x.u; }).slice(0, 4).map(function (x) { return [{ text: '📄 ' + x.c + ' ' + x.n + ' 全文', url: x.u }]; });
  tgSend_(L.join('\n\n'), btn);
  jset_('MOPS_SENT', sent.concat(fresh.map(key)).slice(-200));
}

function opMediaReq(a) { const id = String(a.id || ''); if (!/^(yt|pod)-[\w-]+$/.test(id)) throw new Error('id 不對'); return enqueue_([id]); }

// ---- 觀測站重大訊息全文（Atlas 點「即時」那則時用）----
function opMopsBody(a) {
  const u = String(a.u || '');
  if (!/^https:\/\/mopsov\.twse\.com\.tw\/mops\/web\/t05st0\d\?/.test(u)) throw new Error('網址不對');
  const ck = 'MB_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, u)).slice(0, 20);
  const hit = cacheGet(ck); if (hit) return hit;
  const r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (r.getResponseCode() !== 200) throw new Error('觀測站暫時打不開（' + r.getResponseCode() + '）');
  let t = r.getContentText('UTF-8');
  if (t.indexOf('發言日期') < 0) { try { t = r.getContentText('MS950'); } catch (e) { /* 沒關係 */ } }
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(tr|p|div)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
  const i = t.indexOf('發言日期'); if (i < 0) throw new Error('找不到內文');
  let body = t.slice(i);
  const j = body.search(/電子投票|投資人服務中心|不繼續公開發行/); if (j > 0) body = body.slice(0, j);
  body = body.replace(/\n /g, '\n').trim().slice(0, 6000);
  cachePut(ck, body, 21600);
  return body;
}
