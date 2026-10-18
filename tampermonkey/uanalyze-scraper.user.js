// ==UserScript==
// @name         優分析小助理抓取器（股票檔案小幫手）
// @namespace    stock-file-helper
// @version      1.5
// @description  ① LINE 傳「報告 3167」時抓小助理 20 個分類 ② 每 10 分鐘收集「小助理更新重點」交給 Apps Script（追蹤推播、雷達、歷史紀錄）
// @match        https://pro.uanalyze.com.tw/*
// @match        https://*.uanalyze.com.tw/*
// @match        https://accounts.google.com/*
// @match        https://access.line.me/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/k6107055/stock-screener/main/tampermonkey/uanalyze-scraper.user.js
// @downloadURL  https://raw.githubusercontent.com/k6107055/stock-screener/main/tampermonkey/uanalyze-scraper.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ================= v1.4 自動重新登入 =================
  // 規則：① 半夜 00:30～07:30 被登出 → 自動登入（補收前一天的更新）
  //       ② 白天有「報告」工作在等 → 先 LINE 通知，3 分鐘後登入（你其他裝置會被登出）
  //       ③ 其他時間不自動登入，只 LINE 提醒
  // 帳號密碼：Edge 右上角竄改猴圖示 → 這個腳本底下「設定優分析自動登入」，只存在這台電腦的竄改猴裡。
  const AL_KEY = 'uaAutoLoginAt', RET_KEY = 'uaReturnUrl';
  const alRecent = () => Date.now() - (+GM_getValue(AL_KEY, 0)) < 5 * 60 * 1000;
  GM_registerMenuCommand('設定優分析自動登入', () => {
    const mode = prompt('登入方式：輸入 1＝帳號密碼、2＝Google 登入、3＝LINE 登入、0＝不要自動登入', GM_getValue('uaLoginMode', '1'));
    if (mode === null) return;
    GM_setValue('uaLoginMode', mode.trim());
    if (mode.trim() === '1') {
      const id = prompt('優分析帳號（Email 或手機）', GM_getValue('uaLoginId', ''));
      if (id === null) return;
      const pw = prompt('優分析密碼（只存在這台電腦的竄改猴）', '');
      if (pw === null) return;
      GM_setValue('uaLoginId', id.trim()); GM_setValue('uaLoginPw', pw);
    }
    alert('已儲存。被登出時會照規則自動登入。');
  });
  GM_registerMenuCommand('立刻測試自動登入', () => { GM_setValue(AL_KEY, Date.now()); GM_setValue(RET_KEY, location.href); location.reload(); });

  const textOf = e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim();
  const clickable = () => [...document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], div, span')].filter(e => e.offsetParent !== null);
  function setVal(el, v) {      // 讓 React / Vue 也收得到輸入
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // 在登入相關頁面上執行（優分析登入頁、Google 帳號選擇、LINE 登入）
  function loginStep() {
    if (!alRecent()) return false;
    const host = location.hostname, mode = GM_getValue('uaLoginMode', '1');
    if (host === 'accounts.google.com') {
      const acc = document.querySelector('[data-identifier], [data-email]');
      if (acc) { acc.click(); return true; }
      return false;
    }
    if (host === 'access.line.me') {
      const b = clickable().find(e => /^(登入|Log in|以此帳號登入|繼續)$/i.test(textOf(e)) && e.childElementCount === 0);
      if (b) { b.click(); return true; }
      return false;
    }
    const pw = document.querySelector('input[type=password]');
    if (mode === '1' && pw) {
      const id = GM_getValue('uaLoginId', ''), pass = GM_getValue('uaLoginPw', '');
      if (!id || !pass) return false;
      const user = [...document.querySelectorAll('input')].filter(i => i !== pw && i.offsetParent !== null && /text|email|tel/.test(i.type || 'text'))[0];
      if (user) setVal(user, id);
      setVal(pw, pass);
      setTimeout(() => {
        const form = pw.closest('form');
        const btn = (form && form.querySelector('button[type=submit], input[type=submit]')) ||
          clickable().filter(e => /^(登入|會員登入|登 入|Login|Sign in)$/i.test(textOf(e))).pop();
        if (btn) btn.click(); else if (form) form.submit();
      }, 400);
      return true;
    }
    if (mode === '2' || mode === '3') {
      const re = mode === '2' ? /google/i : /line/i;
      const b = clickable().find(e => re.test(textOf(e)) && /登入|login|sign|繼續|continue/i.test(textOf(e)) && e.childElementCount <= 2);
      if (b) { b.click(); return true; }
    }
    // 還沒看到登入表單 → 找「登入」按鈕點進去
    const entry = clickable().find(e => /^(登入|會員登入|登入／註冊|登入\/註冊|Login|Sign in)$/i.test(textOf(e)) && e.childElementCount === 0);
    if (entry) { entry.click(); return true; }
    return false;
  }

  if (location.hostname !== 'pro.uanalyze.com.tw') {
    // 不是主頁面：只負責登入步驟，登入完回到原本的頁面
    let n = 0;
    const iv = setInterval(() => { n++; if (loginStep() || n > 20) clearInterval(iv); }, 1500);
    return;
  }

  // ====== 只要改這兩行 ======
  // v1.5 網址和 KEY 存在這台電腦的竄改猴裡（GitHub 上的版本不含 KEY），之後可以自動更新腳本
  const DEF_URL = '貼上 Apps Script 網頁應用程式網址（https://script.google.com/macros/s/.../exec）';
  const DEF_KEY = '貼上 setupTriggers 執行紀錄裡的 KEY';
  if (!/貼上/.test(DEF_URL) && !GM_getValue('cfgUrl')) GM_setValue('cfgUrl', DEF_URL);
  if (!/貼上/.test(DEF_KEY) && !GM_getValue('cfgKey')) GM_setValue('cfgKey', DEF_KEY);
  const WEBAPP_URL = GM_getValue('cfgUrl', DEF_URL);
  const KEY = GM_getValue('cfgKey', DEF_KEY);
  GM_registerMenuCommand('設定 Apps Script 網址與 KEY', () => {
    const u = prompt('Apps Script 網頁應用程式網址（結尾 /exec）', GM_getValue('cfgUrl', ''));
    if (u === null) return;
    const k = prompt('KEY', GM_getValue('cfgKey', ''));
    if (k === null) return;
    GM_setValue('cfgUrl', u.trim()); GM_setValue('cfgKey', k.trim());
    alert('已儲存，重新整理頁面後生效。'); location.reload();
  });
  // ==========================

  const POLL_MS = 20 * 1000;          // 每 20 秒問一次有沒有新工作
  const RELOAD_MS = 30 * 60 * 1000;   // 閒置時每 30 分鐘重新整理，保持登入
  const PROMPT_TIMEOUT_MS = 90 * 1000;
  const GAP_MS = 1200;                // 每個分類之間停一下，不要打太快
  const API = 'https://data.uanalyze.com.tw/completions';

  let busy = false;
  const startedAt = Date.now();

  // ---------- 多個分頁時只讓一個分頁負責（v1.2） ----------
  const TAB_ID = Math.random().toString(36).slice(2);
  const LEADER_KEY = 'uaScraperLeader';
  const LEADER_TTL = 60 * 1000;
  function readLeader() { try { return JSON.parse(localStorage.getItem(LEADER_KEY) || 'null'); } catch (e) { return null; } }
  function amLeader() {
    const l = readLeader();
    if (!l || l.id === TAB_ID || Date.now() - l.ts > LEADER_TTL) {
      try { localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, ts: Date.now() })); } catch (e) {}
      return true;
    }
    return false;
  }
  setInterval(() => { const l = readLeader(); if (l && l.id === TAB_ID) amLeader(); }, 15 * 1000); // 負責中持續報到（抓取時也會）
  window.addEventListener('beforeunload', () => { const l = readLeader(); if (l && l.id === TAB_ID) localStorage.removeItem(LEADER_KEY); });

  // ---------- 右下角狀態小標籤 ----------
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:2147483647;padding:4px 10px;' +
    'border-radius:12px;font:12px/1.6 sans-serif;color:#fff;background:#555;opacity:.85;pointer-events:none';
  function status(msg, color) {
    badge.textContent = '📡 抓取器：' + msg;
    badge.style.background = color || '#555';
    if (!badge.isConnected && document.body) document.body.appendChild(badge);
  }

  // ---------- 和 Apps Script 溝通 ----------
  function gas(method, params, body) {
    const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: method,
        url: WEBAPP_URL + '?' + qs,
        data: body ? JSON.stringify(body) : undefined,
        headers: body ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
        anonymous: true, // 不帶 Google 登入 cookie，避免 Edge 登入多個 Google 帳號時出現「無法開啟這個檔案」
        timeout: 60000,
        onload: r => { try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(new Error('Apps Script 回應不是 JSON：' + r.responseText.slice(0, 120))); } },
        onerror: () => reject(new Error('連不到 Apps Script')),
        ontimeout: () => reject(new Error('Apps Script 逾時')),
      });
    });
  }

  // ---------- 優分析 ----------
  function cookies() {
    const o = {};
    document.cookie.split(';').forEach(c => {
      const i = c.indexOf('=');
      if (i > 0) o[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1));
    });
    return o;
  }

  async function fetchPrompt(prompt, code, productId) {
    const ck = cookies();
    if (!ck.access_token) throw new Error('AUTH');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROMPT_TIMEOUT_MS);
    try {
      const url = API + '?prompt=' + encodeURIComponent(prompt) + '&stock=' + encodeURIComponent(code) + '&product_id=' + productId;
      const r = await fetch(url, { headers: { Authorization: (ck.token_type || 'Bearer') + ' ' + ck.access_token }, signal: ctrl.signal });
      if (r.status === 401 || r.status === 403) throw new Error('AUTH');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const t = j && j.data && j.data.text;
      if (!t || /^目前尚無法取得資訊/.test(t.trim())) throw new Error('EMPTY');
      return t;
    } finally {
      clearTimeout(timer);
    }
  }

  // 保留原文紅字 [[…]]、綠字 <<…>> 標記，交給 Apps Script 轉成 🔴/🟢＋真正的紅字綠字
  function convertMarks(t) {
    return t.replace(/<\/?key>/g, '');
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function runJob(job) {
    const prompts = job.prompts || [];
    const sections = [];
    const failed = [];
    let authError = false;

    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      status(job.code + ' ' + (i + 1) + '/' + prompts.length + ' ' + p, '#1f6feb');
      let text = null;
      for (let attempt = 1; attempt <= 2 && text === null; attempt++) {
        try {
          text = await fetchPrompt(p, job.code, job.productId || '907');
        } catch (e) {
          if (e.message === 'AUTH') { authError = true; break; }
          if (e.message === 'EMPTY') break;       // 這一類本來就沒資料，不重試
          if (attempt < 2) await sleep(3000);
        }
      }
      if (authError) break;
      if (text === null) failed.push(p.replace('❤️', ''));
      else sections.push('## ' + (i + 1) + '. ' + p.replace('❤️', '') + '\n\n' + convertMarks(text.trim()));
      await sleep(GAP_MS);
    }

    if (authError) return { jobId: job.id, error: 'AUTH' };
    if (!sections.length) return { jobId: job.id, error: '20 個分類都沒有抓到內容' };

    const stamp = new Date().toLocaleString('zh-TW', { hour12: false });
    const header = [
      '# ' + job.code + ' ' + (job.name || '') + '｜優分析產業情報小助理',
      '抓取時間：' + stamp,
      '來源：優分析付費資料庫（非公開資料），由竄改猴腳本自動抓取',
      '標示：🔴紅字＝原文紅字（偏正面重點）、🟢綠字＝原文綠字（偏風險／負面重點）',
    ];
    if (failed.length) header.push('沒有內容的分類：' + failed.join('、'));
    header.push('', '---', '');

    return {
      jobId: job.id,
      markdown: header.join('\n') + sections.join('\n\n---\n\n'),
      okCount: sections.length,
      total: prompts.length,
      failed: failed,
    };
  }

  // ---------- 主迴圈 ----------
  async function tick() {
    if (busy || feedBusy) return;
    if (/貼上/.test(WEBAPP_URL) || /貼上/.test(KEY)) { status('還沒填網址和 KEY', '#b62324'); return; }
    if (!amLeader()) { status('待機（另一個優分析分頁負責中，這頁可以關掉）', '#6e7781'); return; }
    if (!cookies().access_token) {
      status('優分析未登入，請重新登入', '#b62324');
      try { await maybeAutoLogin(); } catch (e) {}
      // v1.3.1 被登出時通知 LINE（每 6 小時最多一次）
      try {
        const last = +localStorage.getItem('uaLogoutAlert') || 0;
        if (Date.now() - last > 6 * 3600 * 1000) { localStorage.setItem('uaLogoutAlert', String(Date.now())); gas('GET', { action: 'uaAlert', key: KEY, what: 'logout' }).catch(() => {}); }
      } catch (e) {}
      return;
    }
    busy = true;
    try {
      const res = await gas('GET', { action: 'nextJob', key: KEY });
      if (!res.ok) { status('KEY 不對（' + res.error + '）', '#b62324'); return; }
      if (!res.job) {
        status('待命中 ' + new Date().toLocaleTimeString('zh-TW', { hour12: false }), '#2da44e');
        // 閒置夠久就在「同一分頁」重新整理保持登入；未登入時不重新整理，避免被導去登入頁多開分頁
        if (Date.now() - startedAt > RELOAD_MS && cookies().access_token && !feedBusy) location.reload();
        return;
      }
      const result = await runJob(res.job);
      status(res.job.code + ' 交件中…', '#1f6feb');
      await gas('POST', { action: 'submitJob', key: KEY }, result);
      status(result.error ? res.job.code + ' 失敗：' + result.error : res.job.code + ' 完成 ' + result.okCount + '/' + result.total,
        result.error ? '#b62324' : '#2da44e');
    } catch (e) {
      status('錯誤：' + e.message, '#b62324');
    } finally {
      busy = false;
    }
  }

  // ================= v1.3「小助理更新重點」收集 =================
  const FEED_MS = 10 * 60 * 1000;        // 每 10 分鐘看一次有沒有新的更新
  const BACKFILL_DAYS = 31;              // 第一次往回收集約一個月
  const PAGE_WAIT_MS = 1500;
  const SEEN_KEY = 'uaFeedSeen', DONE_KEY = 'uaFeedBackfillDone', LAST_KEY = 'uaFeedLast';
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  function feedBox() {
    const heads = [...document.querySelectorAll('div,span,h1,h2,h3,h4,p')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '小助理更新重點');
    for (const h of heads) {
      let box = h.parentElement;
      for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
        if (/\d{2}-\d{2}\s+\d{2}:\d{2}/.test(box.innerText) && box.querySelectorAll('*').length > 30) return box;
      }
    }
    return null;
  }

  function inferYear(mm) {
    const now = new Date();
    return (+mm > now.getMonth() + 2) ? now.getFullYear() - 1 : now.getFullYear();
  }

  // 讀目前這一頁的每一列：漲跌%、代號、名稱、摘要、日期
  function readRows(box) {
    const out = [];
    const cands = [...box.querySelectorAll('tr, [role=row], li, div')].filter(el => {
      const t = el.innerText || '';
      if (!/\d{2}-\d{2}\s+\d{2}:\d{2}/.test(t) || !/(^|\s)\d{4,6}[A-Z]?(\s|$)/.test(t)) return false;
      return (t.match(/\d{2}-\d{2}\s+\d{2}:\d{2}/g) || []).length === 1;   // 一列只有一個時間＝最小的列
    });
    const rows = cands.filter(el => !cands.some(o => o !== el && el.contains(o)));
    for (const el of rows) {
      // 用最底層的文字格當欄位（不管是表格還是手機版卡片都適用），拿不到才用換行切
      let parts = [...el.querySelectorAll('*')].filter(e => e.childElementCount === 0).map(e => (e.textContent || '').trim()).filter(Boolean);
      if (!parts.some(x => /^\d{4,6}[A-Z]?$/.test(x))) parts = (el.innerText || '').split(/\n|\t/).map(x => x.trim()).filter(Boolean);
      const dm = (el.innerText.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/) || []);
      const ci = parts.findIndex(x => /^\d{4,6}[A-Z]?$/.test(x));
      if (ci < 0 || !dm.length) continue;
      const pcts = (el.innerText.match(/[+-]\d+(?:\.\d+)?%/g) || []).map(x => parseFloat(x));
      const rest = parts.filter((x, i) => i !== ci && !/^[+-]?\d+(?:\.\d+)?%$/.test(x) && !/^\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(x));
      const name = parts[ci + 1] && !/\d{2}-\d{2}\s+\d{2}:\d{2}/.test(parts[ci + 1]) ? parts[ci + 1] : '';
      const text = rest.filter(x => x !== name).sort((a, b) => b.length - a.length)[0] || '';
      if (!text) continue;
      const d = inferYear(dm[1]) + '-' + dm[1] + '-' + dm[2] + ' ' + dm[3] + ':' + dm[4];
      out.push({ d, code: parts[ci], name, text: text.replace(/\s+/g, ' ').slice(0, 300), p10: pcts[0] ?? null, p1m: pcts[1] ?? null });
    }
    return out;
  }

  function nextBtn(box) {
    const btns = [...box.querySelectorAll('button, a, li, span, div')].filter(e => e.childElementCount === 0 && e.textContent.trim() === '>');
    const b = btns[0];
    if (!b) return null;
    const cls = (b.className || '') + ' ' + ((b.parentElement && b.parentElement.className) || '');
    if (/disabled/i.test(cls) || b.disabled || b.getAttribute('aria-disabled') === 'true') return null;
    return b;
  }

  const sleep2 = ms => new Promise(r => setTimeout(r, ms));
  async function waitChange(box, before) {
    for (let i = 0; i < 20; i++) {
      await sleep2(250);
      const now = readRows(box).map(r => r.d + r.code).join('|');
      if (now && now !== before) return true;
    }
    return false;
  }

  function rowKey(r) { return r.d + '|' + r.code + '|' + r.text.slice(0, 20); }

  let feedBusy = false;
  async function feedTick(force) {
    if (feedBusy || busy) return;
    if (/貼上/.test(WEBAPP_URL) || !amLeader()) return;
    if (!force && Date.now() - lsGet(LAST_KEY, 0) < FEED_MS) return;
    const box = feedBox();
    if (!box) return;                               // 這個頁面沒有「小助理更新重點」
    feedBusy = true;
    try {
      const seen = new Set(lsGet(SEEN_KEY, []));
      const backfill = !lsGet(DONE_KEY, false);
      const oldest = Date.now() - BACKFILL_DAYS * 86400000;
      const fresh = [];
      let pages = 0, stop = false;
      // 如果不在第 1 頁，先點「|<」回第 1 頁
      const first = [...box.querySelectorAll('button, a, li, span, div')].find(e => e.childElementCount === 0 && e.textContent.trim() === '|<');
      if (first) { const before = readRows(box).map(r => r.d + r.code).join('|'); first.click(); await waitChange(box, before); }
      while (!stop && pages < 800) {
        if (busy) break;                            // 有報告工作進來，先讓報告
        const rows = readRows(box);
        pages++;
        status('收集小助理更新 第 ' + pages + ' 頁', '#8250df');
        let newOnPage = 0;
        for (const r of rows) {
          const k = rowKey(r);
          if (seen.has(k)) continue;
          seen.add(k); fresh.push(r); newOnPage++;
        }
        const last = rows[rows.length - 1];
        if (!rows.length) break;
        if (last && new Date(last.d.replace(' ', 'T') + ':00+08:00').getTime() < oldest) stop = true;   // 超過一個月
        if (!backfill && newOnPage === 0) stop = true;                         // 平常：遇到看過的就停
        if (fresh.length >= 200) { await sendFeed(fresh.splice(0)); }
        if (stop) break;
        const nb = nextBtn(box);
        if (!nb) { stop = true; break; }
        const before = rows.map(r => r.d + r.code).join('|');
        nb.click();
        await sleep2(PAGE_WAIT_MS);
        if (!(await waitChange(box, before))) break;
      }
      if (fresh.length) await sendFeed(fresh);
      if (backfill && stop) lsSet(DONE_KEY, true);
      lsSet(SEEN_KEY, [...seen].slice(-6000));
      lsSet(LAST_KEY, Date.now());
      status('小助理更新已收集（' + pages + ' 頁）' + new Date().toLocaleTimeString('zh-TW', { hour12: false }), '#2da44e');
      if (first) first.click();
    } catch (e) {
      status('收集更新失敗：' + e.message, '#b62324');
    } finally {
      feedBusy = false;
    }
  }

  async function sendFeed(items) {
    if (!items.length) return;
    const res = await gas('POST', { action: 'feed', key: KEY }, { items });
    if (!res.ok) throw new Error(res.error || '交件失敗');
  }

  // ---- 自動登入的判斷（在主頁面、而且偵測到未登入時呼叫）----
  function inNight() { const d = new Date(), m = d.getHours() * 60 + d.getMinutes(); return m >= 30 && m <= 450; }
  async function maybeAutoLogin() {
    const mode = GM_getValue('uaLoginMode', '1');
    if (mode === '0' || (mode === '1' && !GM_getValue('uaLoginPw', ''))) return;
    const tries = JSON.parse(localStorage.getItem('uaLoginTries') || '[]').filter(t => Date.now() - t < 6 * 3600 * 1000);
    if (tries.length >= 3) return;                              // 6 小時內最多試 3 次，避免一直失敗
    let go = inNight();
    if (!go) {
      const res = await gas('GET', { action: 'hasJob', key: KEY }).catch(() => ({}));
      if (res && res.jobs > 0) {
        const warned = +localStorage.getItem('uaReloginWarn') || 0;
        if (!warned || Date.now() - warned > 30 * 60 * 1000) {    // 先通知，3 分鐘後才登入
          localStorage.setItem('uaReloginWarn', String(Date.now()));
          gas('GET', { action: 'uaAlert', key: KEY, what: 'relogin' }).catch(() => {});
          return;
        }
        go = Date.now() - warned > 3 * 60 * 1000;
      }
    }
    if (!go) return;
    tries.push(Date.now()); localStorage.setItem('uaLoginTries', JSON.stringify(tries));
    GM_setValue(AL_KEY, Date.now());
    GM_setValue(RET_KEY, location.href);
    status('自動登入中…', '#8250df');
    if (!loginStep()) setTimeout(() => location.reload(), 3000);
  }
  // 登入後回到原本的頁面
  (function () {
    const ret = GM_getValue(RET_KEY, '');
    if (ret && cookies().access_token && alRecent()) { GM_setValue(RET_KEY, ''); GM_setValue(AL_KEY, 0); localStorage.removeItem('uaLoginTries');
      gas('GET', { action: 'uaAlert', key: KEY, what: 'loggedin' }).catch(() => {});
      if (location.href !== ret) location.href = ret; }
    else if (!cookies().access_token && alRecent()) { let n = 0; const iv = setInterval(() => { n++; if (loginStep() || n > 15) clearInterval(iv); }, 1500); }
  })();

  status('啟動中…');
  setTimeout(tick, 3000);
  setInterval(tick, POLL_MS);
  setTimeout(() => feedTick(false), 15000);
  setInterval(() => feedTick(false), 60 * 1000);
})();
