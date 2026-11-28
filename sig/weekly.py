"""論點訊號週檢查（Gemini 版，取代原本每週日的 Claude 排程）

流程：Apps Script(sigIn) 取訂閱名單＋追蹤清單 → 每檔叫 Gemini（開 Google 搜尋）查最近 14 天的訊號
     → 組成跟原本一模一樣的 JSON → Apps Script(sigOut) 存到 Drive「_系統/訊號檢查_yyyyMMdd」→ 20:00 照舊推 Telegram
需要 GitHub Secrets：GAS_URL、GAS_KEY、GEMINI_API_KEY（都已經有）
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

G = 'https://generativelanguage.googleapis.com'
KEY = os.getenv('GEMINI_API_KEY', '').strip()
GAS, GKEY = os.getenv('GAS_URL', '').strip(), os.getenv('GAS_KEY', '').strip()
MAX_STOCKS = 15
TW = timezone(timedelta(hours=8))
LOG = []


def log(*a):
    s = ' '.join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


def models():
    """挑模型：Pro 優先（判斷比較準），額度用完或忙線就換 Flash"""
    names = []
    try:
        r = requests.get(G + '/v1beta/models?pageSize=300', headers={'x-goog-api-key': KEY}, timeout=30)
        names = [m['name'].split('/')[-1] for m in r.json().get('models', []) if 'generateContent' in m.get('supportedGenerationMethods', [])]
    except Exception as e:  # noqa: BLE001
        log('查模型失敗', e)
    ver = lambda n: -float(re.findall(r'\d+(?:\.\d+)?', n)[0])
    pro = sorted([n for n in names if re.fullmatch(r'gemini-\d+(\.\d+)?-pro', n)], key=ver)
    flash = sorted([n for n in names if re.fullmatch(r'gemini-\d+(\.\d+)?-flash', n)], key=ver)
    out = list(dict.fromkeys(['gemini-pro-latest'] + pro[:2] + ['gemini-flash-latest'] + flash[:2]))
    return [m for m in out if m in names or m.endswith('-latest')]


MODELS = []
DEAD = set()


def ask(prompt):
    """叫 Gemini（開 Google 搜尋）；回傳 (文字, 搜尋來源清單, 模型)"""
    body = {'contents': [{'role': 'user', 'parts': [{'text': prompt}]}], 'tools': [{'google_search': {}}],
            'generationConfig': {'temperature': 0.2, 'maxOutputTokens': 8192}}
    for rnd in range(2):
        for m in MODELS:
            if m in DEAD:
                continue
            try:
                r = requests.post(f'{G}/v1beta/models/{m}:generateContent', headers={'x-goog-api-key': KEY}, json=body, timeout=300)
            except Exception as e:  # noqa: BLE001
                log('  連線失敗', m, str(e)[:80])
                continue
            if r.status_code == 200:
                c = (r.json().get('candidates') or [{}])[0]
                t = ''.join(p.get('text', '') for p in (c.get('content') or {}).get('parts', []) if not p.get('thought'))
                gm = c.get('groundingMetadata') or {}
                src = [{'t': (x.get('web') or {}).get('title', ''), 'u': (x.get('web') or {}).get('uri', '')} for x in gm.get('groundingChunks', []) if x.get('web')]
                if t.strip():
                    return t, src, m
                log('  空白回應', m, c.get('finishReason'))
                continue
            log('  ', m, r.status_code, r.text[:150].replace('\n', ' '))
            if r.status_code in (400, 404):
                DEAD.add(m)
        time.sleep(60)   # 全部忙線／額度用完 → 等一分鐘再整輪試一次
    raise RuntimeError('所有 Gemini 模型都失敗')


def parse_json(t):
    t = re.sub(r'^```(?:json)?\s*|\s*```$', '', t.strip())
    a, b = t.find('{'), t.rfind('}')
    return json.loads(t[a:b + 1])


def find_manual(o, out=None):
    """追蹤清單裡所有 metric="manual" 的項目（不管放在哪一層）"""
    out = [] if out is None else out
    if isinstance(o, dict):
        if o.get('metric') == 'manual':
            out.append(o)
        for v in o.values():
            find_manual(v, out)
    elif isinstance(o, list):
        for v in o:
            find_manual(v, out)
    return out


def prompt_for(st, tl, today):
    since = (datetime.fromisoformat(today) - timedelta(days=14)).strftime('%Y-%m-%d')
    until = (datetime.fromisoformat(today) + timedelta(days=7)).strftime('%Y-%m-%d')
    if tl:
        manual = find_manual(tl)
        if manual:
            ctx = '要查的訊號（追蹤清單裡系統抓不到的項目）：\n' + '\n'.join(
                f'- {x.get("what", "")}｜怎麼查：{x.get("q", "")}｜判斷規則：{x.get("rule", "")}｜為什麼重要：{x.get("why", "")}' for x in manual[:3])
        else:
            keep = {k: tl.get(k) for k in ('thesis', 'breaks', 'ind', 'chain', 'peers') if tl.get(k)}
            ctx = ('這檔的投資論點（追蹤清單摘要）：\n' + json.dumps(keep, ensure_ascii=False)[:3000] +
                   '\n請從中推出 2～3 個「系統抓不到（報價、稼動率、交期、主要客戶資本支出、法說會說法、同業新產能進度等）、但最能提早看出論點對錯」的訊號來查。')
    else:
        ctx = '這檔沒有追蹤清單：只查最近兩週最重要的 1～2 則產業或公司新聞，判斷對這家公司是好是壞。'
    return f"""你是台股研究助理。今天是 {today}（台北時間）。用繁體中文。
股票：{st['code']} {st['name']}（{st.get('type') or '觀察'}）
{ctx}

請用 Google 搜尋查 {since} 到 {today} 的最新資料（優先：公司公告、法說會、財經媒體、產業研究；附來源網址與日期）。
每個訊號判斷 effect："+" 對論點加分、"-" 扣分、"0" 沒影響或資料不足。資料不夠就寫「資料不足」，不要猜數字。
另外查 {today} 到 {until} 這檔有沒有法說會、股東會、除權息、重要產品發表（要有明確日期才寫）。
最多 3 個訊號，每個 1～2 個可查證來源。

只輸出一個 JSON，不要其他文字：
{{"one":"30 字內：這週整體對論點是加分、扣分還是沒變，為什麼",
"signals":[{{"what":"20 字內訊號名稱","now":"60 字內最新狀況（含數字）","vs":"40 字內和上次或報告時比","effect":"+","why":"40 字內對論點的意義","src":[{{"t":"來源標題","u":"網址","d":"yyyy-MM-dd"}}]}}],
"events":[{{"d":"yyyy-MM-dd","what":"法說會"}}]}}"""


def clean(st, j, gsrc):
    cut = lambda s, n: str(s or '')[:n]
    sigs = []
    for x in (j.get('signals') or [])[:3]:
        e = str(x.get('effect', '0')).strip()
        e = '+' if e.startswith('+') else '-' if e.startswith('-') else '0'
        src = [{'t': cut(s.get('t'), 80), 'u': cut(s.get('u'), 500), 'd': cut(s.get('d'), 10)} for s in (x.get('src') or []) if isinstance(s, dict) and s.get('u')][:2]
        if not src and gsrc:   # 模型沒附網址 → 用 Google 搜尋實際引用的來源
            src = [{'t': cut(s['t'], 80), 'u': s['u'], 'd': ''} for s in gsrc[:2]]
        sigs.append({'what': cut(x.get('what'), 30), 'now': cut(x.get('now'), 90), 'vs': cut(x.get('vs'), 60), 'effect': e, 'why': cut(x.get('why'), 60), 'src': src})
    ev = [{'d': cut(x.get('d'), 10), 'what': cut(x.get('what'), 20)} for x in (j.get('events') or []) if isinstance(x, dict) and re.match(r'\d{4}-\d{2}-\d{2}$', str(x.get('d', '')))]
    return {'code': st['code'], 'name': st['name'], 'one': cut(j.get('one'), 45), 'signals': sigs, 'events': ev}


def main():
    if not (KEY and GAS and GKEY):
        log('缺少 GEMINI_API_KEY / GAS_URL / GAS_KEY')
        return 1
    r = requests.get(GAS, params={'action': 'sigIn', 'key': GKEY}, timeout=120)
    d = r.json()
    if not d.get('ok'):
        log('讀名單失敗', d)
        return 1
    today = d.get('today') or datetime.now(TW).strftime('%Y-%m-%d')
    stocks = d['stocks']
    hold = [s for s in stocks if '持股' in s.get('type', '')]
    rest = sorted([s for s in stocks if s not in hold], key=lambda s: s.get('added', ''), reverse=True)
    pick = (hold + rest)[:MAX_STOCKS]   # 持股優先，其餘新加入的優先，最多 15 檔
    log(f'名單 {len(stocks)} 檔，這次處理 {len(pick)} 檔')
    global MODELS
    MODELS = models()
    log('模型順序', MODELS)
    out, used = [], {}
    for st in pick:
        try:
            t, gsrc, m = ask(prompt_for(st, d['lists'].get(st['code']), today))
            row = clean(st, parse_json(t), gsrc)
            used[m] = used.get(m, 0) + 1
            out.append(row)
            log(f"✓ {st['code']} {st['name']}：{''.join(s['effect'] for s in row['signals']) or '—'} {row['one']}（{m}）")
        except Exception as e:  # noqa: BLE001
            log(f"✗ {st['code']} {st['name']}：{str(e)[:120]}")
            out.append({'code': st['code'], 'name': st['name'], 'one': '這週查詢失敗', 'signals': [], 'events': []})
        time.sleep(4)   # 放慢一點，避免撞到每分鐘額度
    res = requests.post(GAS, params={'action': 'sigOut', 'key': GKEY}, data=json.dumps({'date': today, 'stocks': out}, ensure_ascii=False).encode('utf-8'),
                        headers={'Content-Type': 'text/plain;charset=utf-8'}, timeout=120).json()
    log('存檔', res, '模型用量', used)
    return 0 if res.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
